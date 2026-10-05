import { useEffect, useId, useRef, useState } from 'react';
import { getDB } from '../db/db';
import { GoogleAuthError, isGisLoaded, loadGis, requestToken, revokeToken, type GoogleToken } from '../google/auth';
import { GOOGLE_CLIENT_ID } from '../google/config';
import {
  createSession,
  deleteSession,
  fetchPickedPhoto,
  getSession,
  listAllMediaItems,
  pickerUrl,
  waitForPicks,
  type PickedMediaItem,
  type PickingSession,
} from '../google/picker';
import { AuthExpiredError, type ImportItem, type ImportProgress } from '../import/importer';
import { importService, type Batch, type ImportServiceState } from '../import/service';

interface Props {
  online: boolean;
  collectionId: string;
  onItems(items: ImportItem[], extra: Partial<Batch>): void;
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'auth' }
  | { kind: 'creating' }
  | { kind: 'picking'; session: PickingSession; windowOpened: boolean }
  | { kind: 'listing' }
  | { kind: 'error'; message: string };

/** baseUrls stay valid for 60 minutes after they are listed. */
const BASE_URL_TTL = 60 * 60_000;

/**
 * "Add from Google Photos": one bounded session per import.
 * sign in → pick in Google Photos (new window) → download sized renditions →
 * same local pipeline as files. Shows the time left on the Google access
 * token, and offers to resume with a fresh sign-in if it runs out mid-import.
 */
export function GooglePhotosImport({ online, collectionId, onItems }: Props) {
  const descId = useId();
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [token, setToken] = useState<GoogleToken>();
  const tokenRef = useRef<GoogleToken>(undefined);
  const [listedAt, setListedAt] = useState<number>();
  const [now, setNow] = useState(Date.now());
  const [notice, setNotice] = useState<string>();
  const [paused, setPaused] = useState<ImportProgress & { label: string }>();
  const abortRef = useRef<AbortController>(undefined);
  const pickerWin = useRef<Window | null>(null);

  tokenRef.current = token;
  const configured = !!GOOGLE_CLIENT_ID;
  const disabled = !online || !configured || phase.kind === 'auth' || phase.kind === 'creating' || phase.kind === 'listing';

  // Countdown tick while we hold a token.
  useEffect(() => {
    if (!token) return;
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, [token]);

  // Watch for Google imports that paused because access expired.
  useEffect(
    () =>
      importService.subscribe((s: ImportServiceState) => {
        const last = s.last;
        setPaused(last && last.source === 'google' && last.status === 'paused' ? last : undefined);
      }),
    [],
  );

  useEffect(() => () => abortRef.current?.abort(), []);

  const preload = () => {
    if (online && configured && !isGisLoaded()) void loadGis().catch(() => undefined);
  };

  async function signIn(): Promise<GoogleToken> {
    if (token && Date.now() < token.expiresAt - 5 * 60_000) return token;
    setPhase({ kind: 'auth' });
    const oauth2 = await loadGis();
    const t = await requestToken(oauth2);
    setToken(t);
    tokenRef.current = t;
    return t;
  }

  function itemsFrom(media: PickedMediaItem[]): ImportItem[] {
    return media.map((m) => ({
      key: m.id,
      name: m.mediaFile.filename || 'Google Photos item',
      googleId: m.id,
      originalSize:
        m.mediaFile.mediaFileMetadata?.width && m.mediaFile.mediaFileMetadata?.height
          ? { width: m.mediaFile.mediaFileMetadata.width, height: m.mediaFile.mediaFileMetadata.height }
          : undefined,
      load: (signal, cap) => {
        // Signed out (Disconnect) or expired mid-import: pause so it can resume after a fresh sign-in.
        const t = tokenRef.current;
        if (!t) return Promise.reject(new AuthExpiredError('Signed out of Google'));
        return fetchPickedPhoto(m.mediaFile.baseUrl, cap, t, signal);
      },
    }));
  }

  function hand(media: PickedMediaItem[], session: PickingSession) {
    const photos = media.filter((m) => m.type !== 'VIDEO' && (m.mediaFile.mimeType ?? 'image/').startsWith('image/'));
    const skipped = media.length - photos.length;
    setNotice(
      skipped
        ? `${skipped} video${skipped === 1 ? '' : 's'} skipped — slideshows use photos only.`
        : undefined,
    );
    setListedAt(Date.now());
    if (!photos.length) return;
    onItems(itemsFrom(photos), {
      lanes: 6,
      jobExtra: {
        google: { sessionId: session.id, sessionExpireTime: session.expireTime, remainingIds: photos.map((p) => p.id) },
      },
      onDone: (p) => {
        // Keep the session if the import paused, so it can resume with the same picks.
        if (p.status !== 'paused' && tokenRef.current) void deleteSession(tokenRef.current, session.id);
      },
    });
  }

  async function start() {
    setNotice(undefined);
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    // Popups need the click's user activation, and opening one consumes it. If we
    // must sign in first, the GIS popup gets the activation and the user opens the
    // picker with a second click ("Open Google Photos"). With a valid token we can
    // open the picker window right away and navigate it once the session exists.
    const haveToken = !!token && Date.now() < token.expiresAt - 5 * 60_000;
    pickerWin.current = haveToken ? window.open('', 'google-photos-picker') : null;
    try {
      const t = await signIn();
      setPhase({ kind: 'creating' });
      const session = await createSession(t);
      let opened = false;
      if (pickerWin.current && !pickerWin.current.closed) {
        pickerWin.current.location.href = pickerUrl(session);
        opened = true;
      }
      setPhase({ kind: 'picking', session, windowOpened: opened });
      const done = await waitForPicks(t, session, ac.signal);
      setPhase({ kind: 'listing' });
      const media = await listAllMediaItems(tokenRef.current ?? t, done.id);
      hand(media, done);
      setPhase({ kind: 'idle' });
    } catch (e) {
      pickerWin.current?.close();
      if ((e as Error).name === 'AbortError') return setPhase({ kind: 'idle' });
      const msg = e instanceof GoogleAuthError && e.code === 'popup_closed' ? undefined : (e as Error).message;
      setPhase(msg ? { kind: 'error', message: msg } : { kind: 'idle' });
    }
  }

  async function resume() {
    if (!paused) return;
    const job = await getDB().jobs.get(paused.jobId);
    const g = job?.google;
    if (!g) return;
    try {
      const t = await signIn();
      setPhase({ kind: 'listing' });
      let session: PickingSession;
      try {
        session = await getSession(t, g.sessionId);
      } catch {
        throw new Error(
          'That Google Photos selection has expired. Use “Add from Google Photos” to pick again — photos already saved will be skipped.',
        );
      }
      const remaining = new Set(g.remainingIds);
      const media = (await listAllMediaItems(t, session.id)).filter((m) => remaining.has(m.id));
      importService.dismissLast();
      hand(media, session);
      setPhase({ kind: 'idle' });
    } catch (e) {
      setPhase({ kind: 'error', message: (e as Error).message });
    }
  }

  function cancelPicking() {
    abortRef.current?.abort();
    pickerWin.current?.close();
    if (phase.kind === 'picking' && token) void deleteSession(token, phase.session.id);
    setPhase({ kind: 'idle' });
  }

  async function disconnect() {
    await revokeToken(token);
    setToken(undefined);
    setListedAt(undefined);
  }

  const tokenLeft = token ? token.expiresAt - now : 0;
  const urlLeft = listedAt ? listedAt + BASE_URL_TTL - now : Infinity;
  const left = Math.min(tokenLeft, urlLeft);
  const minutes = Math.max(0, Math.floor(left / 60_000));

  const reason = !online
    ? 'Google Photos needs an internet connection. Your library and slideshows still work offline.'
    : !configured
      ? 'Google Photos isn’t configured on this site (no OAuth client id).'
      : undefined;

  return (
    <div className="google">
      <button
        type="button"
        className="btn"
        onClick={() => void start()}
        onPointerEnter={preload}
        onFocus={preload}
        disabled={disabled}
        aria-describedby={reason ? descId : undefined}
        data-testid="google-button"
      >
        Add from Google Photos
      </button>
      {reason && (
        <span id={descId} className="help inline">
          {reason}
        </span>
      )}

      {(phase.kind !== 'idle' || token || notice || paused) && (
        <div className="google-status" role="status">
          {phase.kind === 'auth' && <p>Waiting for Google sign-in…</p>}
          {phase.kind === 'creating' && <p>Starting a Google Photos session…</p>}
          {phase.kind === 'picking' && (
            <div>
              <p>
                Choose photos in the Google Photos window, then tap <strong>Done</strong>. They'll be added here
                automatically.
              </p>
              <div className="actions">
                <a className="btn small" href={pickerUrl(phase.session)} target="google-photos-picker" rel="noopener">
                  {phase.windowOpened ? 'Reopen Google Photos' : 'Open Google Photos'}
                </a>
                <button type="button" className="btn ghost small" onClick={cancelPicking}>
                  Cancel
                </button>
              </div>
            </div>
          )}
          {phase.kind === 'listing' && <p>Getting your selection…</p>}
          {phase.kind === 'error' && <p className="error-text">{phase.message}</p>}
          {notice && <p className="muted">{notice}</p>}
          {paused && (
            <div className="callout warn">
              <p>
                Google access expired with {paused.remainingKeys?.length ?? 0} photos left. Sign in again to continue —
                photos already saved are kept.
              </p>
              <button type="button" className="btn small" onClick={() => void resume()} disabled={!online}>
                Sign in and resume
              </button>
            </div>
          )}
          {token && left > 0 && (
            <p className={`muted${minutes < 10 ? ' warn-text' : ''}`}>
              Google access: about {minutes} min left.{' '}
              {minutes < 10 && 'If it runs out mid-import, you can resume after signing in again. '}
              <button type="button" className="link" onClick={() => void disconnect()}>
                Disconnect
              </button>
            </p>
          )}
        </div>
      )}
    </div>
  );
}
