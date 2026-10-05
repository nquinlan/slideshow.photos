/**
 * Google Photos Picker API client (REST, called directly from the browser —
 * photospicker.googleapis.com supports CORS with an Authorization header).
 *
 * Flow: sessions.create → open pickerUri (+ "/autoclose") in a new window
 * (it may not be iframed) → poll sessions.get using the server-provided
 * pollingConfig until mediaItemsSet → mediaItems.list (paged) → download
 * each item's baseUrl with a size suffix → sessions.delete.
 */
import { AuthExpiredError, FatalImportError } from '../import/importer';
import type { GoogleToken } from './auth';
import { MAX_PICK, MEDIA_FETCH_MODE, PICKER_API, type MediaFetchMode } from './config';

export interface PickingSession {
  id: string;
  pickerUri: string;
  pollingConfig?: { pollInterval?: string; timeoutIn?: string };
  expireTime?: string;
  pickingConfig?: { maxItemCount?: string };
  mediaItemsSet?: boolean;
}

export interface PickedMediaItem {
  id: string;
  createTime?: string;
  type?: 'TYPE_UNSPECIFIED' | 'PHOTO' | 'VIDEO';
  mediaFile: {
    baseUrl: string;
    mimeType?: string;
    filename?: string;
    mediaFileMetadata?: { width?: number; height?: number; cameraMake?: string; cameraModel?: string };
  };
}

export class PickerApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

async function api<T>(token: GoogleToken, path: string, init: RequestInit = {}): Promise<T> {
  if (Date.now() >= token.expiresAt) throw new AuthExpiredError();
  const res = await fetch(`${PICKER_API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token.accessToken}`, 'Content-Type': 'application/json', ...init.headers },
  });
  if (res.status === 401) throw new AuthExpiredError();
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      msg = body?.error?.message ?? msg;
    } catch {
      /* non-JSON error */
    }
    if (res.status === 429) msg = 'Google Photos is rate-limiting requests. Wait a minute and try again.';
    if (res.status === 400 && /FAILED_PRECONDITION|not set/i.test(msg)) msg = 'Selection not finished yet.';
    throw new PickerApiError(msg, res.status);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

export function createSession(token: GoogleToken, maxItemCount = MAX_PICK): Promise<PickingSession> {
  return api(token, '/sessions', {
    method: 'POST',
    body: JSON.stringify({ pickingConfig: { maxItemCount: String(Math.min(MAX_PICK, maxItemCount)) } }),
  });
}

export function getSession(token: GoogleToken, id: string): Promise<PickingSession> {
  return api(token, `/sessions/${encodeURIComponent(id)}`);
}

export async function deleteSession(token: GoogleToken, id: string): Promise<void> {
  try {
    await api(token, `/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
  } catch {
    /* best-effort cleanup */
  }
}

export async function listAllMediaItems(token: GoogleToken, sessionId: string): Promise<PickedMediaItem[]> {
  const out: PickedMediaItem[] = [];
  let pageToken: string | undefined;
  do {
    const q = new URLSearchParams({ sessionId, pageSize: '100' });
    if (pageToken) q.set('pageToken', pageToken);
    const page = await api<{ mediaItems?: PickedMediaItem[]; nextPageToken?: string }>(token, `/mediaItems?${q}`);
    out.push(...(page.mediaItems ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return out;
}

/** Parse a protobuf Duration string like "5s" or "1.5s" to ms. */
export function parseDuration(d: string | undefined, fallbackMs: number): number {
  const m = d?.match(/^(\d+(?:\.\d+)?)s$/);
  return m ? Math.round(parseFloat(m[1]) * 1000) : fallbackMs;
}

/** Picker URL for a web app: "/autoclose" closes Google's tab when the user taps Done. */
export function pickerUrl(session: PickingSession): string {
  return session.pickerUri.replace(/\/?$/, '/autoclose');
}

/**
 * Poll until the user finishes picking. Honours the server's recommended
 * interval and timeout. Rejects with AbortError when `signal` aborts.
 */
export async function waitForPicks(
  token: GoogleToken,
  session: PickingSession,
  signal: AbortSignal,
): Promise<PickingSession> {
  let s = session;
  const deadline = Date.now() + parseDuration(s.pollingConfig?.timeoutIn, 30 * 60_000);
  while (!s.mediaItemsSet) {
    if (Date.now() > deadline) throw new PickerApiError('Timed out waiting for your selection in Google Photos.', 408);
    await sleep(parseDuration(s.pollingConfig?.pollInterval, 3000), signal);
    s = await getSession(token, s.id);
  }
  return s;
}

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException('Aborted', 'AbortError'));
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}

/**
 * Size-limited rendition URL: "=wW-hH" asks Google to scale the image to fit
 * within W×H (aspect preserved), so originals are never downloaded.
 */
export function renditionUrl(baseUrl: string, cap: number): string {
  return `${baseUrl}=w${cap}-h${cap}`;
}

export class MediaBlockedError extends FatalImportError {}

/** Download one picked photo at `cap` px. */
export async function fetchPickedPhoto(
  baseUrl: string,
  cap: number,
  token: GoogleToken,
  signal: AbortSignal,
  mode: MediaFetchMode = MEDIA_FETCH_MODE,
): Promise<Blob> {
  if (Date.now() >= token.expiresAt) throw new AuthExpiredError();
  const url = renditionUrl(baseUrl, cap);
  let res: Response;
  try {
    res =
      mode === 'query'
        ? await fetch(`${url}?access_token=${encodeURIComponent(token.accessToken)}`, { signal, credentials: 'omit' })
        : await fetch(url, { signal, credentials: 'omit', headers: { Authorization: `Bearer ${token.accessToken}` } });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    // A TypeError here while online is almost always the CORS preflight being rejected.
    throw new MediaBlockedError(
      navigator.onLine
        ? 'The browser blocked the download from Google Photos (CORS). See README “Google Photos download” for options.'
        : 'You are offline.',
    );
  }
  if (res.status === 401 || res.status === 403) throw new AuthExpiredError('Google access expired');
  if (!res.ok) throw new Error(`Google Photos returned ${res.status}`);
  return res.blob();
}
