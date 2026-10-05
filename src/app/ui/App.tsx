import { useCallback, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { SITE } from '../../site';
import {
  DEFAULT_APP_SETTINGS,
  type AppSettings,
  type Collection,
  type Graphic,
  type ImportJob,
  type PlaybackSettings,
  type Photo,
} from '../db/db';
import {
  createCollection,
  deleteAllOriginals,
  deleteCollection,
  getAppSettings,
  getCollection,
  getCollectionPhotoIds,
  getPhotos,
  libraryUsage,
  listCollections,
  listGraphics,
  removeFromCollection,
  renameCollection,
  saveAppSettings,
  updatePlaybackSettings,
  type CollectionSummary,
  type LibraryUsage,
} from '../db/repo';
import { dismissJob, markInterruptedJobs, type ImportItem } from '../import/importer';
import { filesFromDataTransfer, filesToItems, pickFiles, pickFolder } from '../import/localFiles';
import { importService, type Batch, type ImportServiceState } from '../import/service';
import { checkImportFits, estimateImportBytes, requestPersistence } from '../import/storage';
import { canEncodeWebP } from '../pipeline/webp';
import type { QualityTier } from '../pipeline/sizing';
import type { PhotoInfo } from '../formats/types';
import { enterFullscreen } from '../player/fullscreen';
import { toPhotoInfo } from '../player/photos';
import { GooglePhotosImport } from './GooglePhotos';
import { BackupPanel } from './BackupPanel';
import { GraphicsPanel } from './GraphicsPanel';
import { useOnline, useStorageInfo } from './hooks';
import { ImportConfirmDialog, ImportPanel, InterruptedJobs, StorageMeter, type PendingImport } from './ImportUI';
import { Library } from './Library';
import { LibrarySettings } from './LibrarySettings';
import { Player, type PlayerHandle } from './Player';
import { SlideshowSettings } from './SlideshowSettings';
import { forgetThumbs } from './thumbs';
import { UpdatePrompt } from './UpdatePrompt';

/** Imports at least this large get a confirmation with a storage estimate. */
const CONFIRM_THRESHOLD = 25;

export default function App() {
  const online = useOnline();
  const [collections, setCollections] = useState<CollectionSummary[]>([]);
  const [collection, setCollection] = useState<Collection>();
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [appSettings, setAppSettings] = useState<AppSettings>(DEFAULT_APP_SETTINGS);
  const [importState, setImportState] = useState<ImportServiceState>({ queued: [] });
  const [pending, setPending] = useState<
    (PendingImport & { items: ImportItem[]; source: Batch['source']; extra?: Partial<Batch>; originalsBytes: number }) | null
  >(null);
  const [playing, setPlaying] = useState<{ startPhotoId?: string; photos: PhotoInfo[] } | null>(null);
  const [interrupted, setInterrupted] = useState<ImportJob[]>([]);
  const [showSettings, setShowSettings] = useState(false);
  const [usage, setUsage] = useState<LibraryUsage>();
  const [dataVersion, setDataVersion] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [ready, setReady] = useState(false);
  const [graphics, setGraphics] = useState<Graphic[]>([]);
  const reloadGraphics = useCallback(async () => setGraphics(await listGraphics()), []);
  const storage = useStorageInfo(dataVersion);
  const playerRef = useRef<PlayerHandle>(null);
  // Imports need the current collection, which loads asynchronously from IndexedDB at
  // startup. Until then the add controls are disabled so a selection is never dropped.
  const canImport = ready && !!collection;

  // --- loading ---

  const loadCollection = useCallback(async (id: string) => {
    const c = await getCollection(id);
    if (!c) return;
    setCollection(c);
    setPhotos(await getPhotos(await getCollectionPhotoIds(id)));
  }, []);

  const refresh = useCallback(async () => {
    setCollections(await listCollections());
    setUsage(await libraryUsage());
    if (collection) {
      setPhotos(await getPhotos(await getCollectionPhotoIds(collection.id)));
    }
    setDataVersion((v) => v + 1);
  }, [collection]);

  useEffect(() => {
    void (async () => {
      const [settings, jobs] = await Promise.all([getAppSettings(), markInterruptedJobs()]);
      setAppSettings(settings);
      setInterrupted(jobs);
      let cols = await listCollections();
      if (!cols.length) {
        await createCollection('My slideshow');
        cols = await listCollections();
      }
      setCollections(cols);
      const id = cols.find((c) => c.id === settings.lastCollectionId)?.id ?? cols[0].id;
      await loadCollection(id);
      setUsage(await libraryUsage());
      await reloadGraphics();
      setReady(true);
    })();
    return importService.subscribe(setImportState);
  }, [loadCollection, reloadGraphics]);

  // Pull newly imported photos into the grid while an import runs (throttled).
  const progressCount = importState.progress
    ? importState.progress.imported + importState.progress.upgraded + importState.progress.skipped
    : -1;
  const lastRefresh = useRef(0);
  useEffect(() => {
    if (progressCount <= 0) return;
    const wait = Math.max(0, 1000 - (Date.now() - lastRefresh.current));
    const t = setTimeout(() => {
      lastRefresh.current = Date.now();
      void refresh();
    }, wait);
    return () => clearTimeout(t);
  }, [progressCount, refresh]);
  useEffect(() => {
    if (importState.last) void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [importState.last]);

  // --- collections ---

  async function switchCollection(id: string) {
    setSelected(new Set());
    await loadCollection(id);
    setAppSettings(await saveAppSettings({ lastCollectionId: id }));
  }

  async function newCollection() {
    const c = await createCollection(`Collection ${collections.length + 1}`);
    setCollections(await listCollections());
    await switchCollection(c.id);
    requestAnimationFrame(() => document.getElementById('collection-name')?.focus());
  }

  async function removeCollection() {
    if (!collection) return;
    if (!confirm(`Delete “${collection.name}”? Photos that aren't in another collection are removed from this device.`)) return;
    await deleteCollection(collection.id);
    let cols = await listCollections();
    if (!cols.length) {
      await createCollection('My slideshow');
      cols = await listCollections();
    }
    setCollections(cols);
    await switchCollection(cols[0].id);
    await refresh();
  }

  const settingsSaveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  function changePlayback(settings: PlaybackSettings) {
    if (!collection) return;
    setCollection({ ...collection, settings });
    clearTimeout(settingsSaveTimer.current);
    const id = collection.id;
    settingsSaveTimer.current = setTimeout(() => void updatePlaybackSettings(id, settings), 300);
  }

  // --- importing ---

  async function startImport(items: ImportItem[], label: string, source: Batch['source'] = 'local', extra?: Partial<Batch>) {
    if (!collection || !items.length) return;
    if (!appSettings.persistRequested) {
      void requestPersistence().then(() => setDataVersion((v) => v + 1));
      setAppSettings(await saveAppSettings({ persistRequested: true }));
    }
    const webp = await canEncodeWebP();
    // Unknown sizes (Google items) are estimated at 4 MB per original.
    const originalsBytes = appSettings.keepOriginals ? items.reduce((a, i) => a + (i.size ?? 4e6), 0) : 0;
    const bytes = estimateImportBytes(items.length, appSettings.tier, { webp, originalsBytes });
    const estimate = await checkImportFits(bytes);
    const p = {
      label,
      count: items.length,
      estimate,
      tier: appSettings.tier,
      keepOriginals: appSettings.keepOriginals,
      items,
      source,
      extra,
      originalsBytes,
    };
    if (items.length >= CONFIRM_THRESHOLD || estimate.level === 'tight' || estimate.level === 'over') {
      setPending(p);
    } else {
      enqueue(p.items, label, source, appSettings.tier, extra);
    }
  }

  function enqueue(items: ImportItem[], label: string, source: Batch['source'], tier: QualityTier, extra?: Partial<Batch>) {
    if (!collection) return;
    importService.enqueue({
      label,
      collectionId: collection.id,
      source,
      items,
      tier,
      keepOriginals: appSettings.keepOriginals,
      ...extra,
    });
  }

  async function addFiles(kind: 'files' | 'folder') {
    const files = kind === 'files' ? await pickFiles() : await pickFolder();
    if (!files.length) return;
    await startImport(filesToItems(files), kind === 'folder' ? 'folder' : `${files.length} file${files.length === 1 ? '' : 's'}`);
  }

  async function onDrop(e: React.DragEvent) {
    e.preventDefault(); // always, or the browser navigates to the dropped file
    setDragging(false);
    if (!canImport) return;
    const files = await filesFromDataTransfer(e.dataTransfer);
    if (files.length) await startImport(filesToItems(files), 'dropped files');
  }

  async function removeSelected() {
    if (!collection || !selected.size) return;
    const ids = [...selected];
    await removeFromCollection(collection.id, ids);
    forgetThumbs(ids);
    setSelected(new Set());
    await refresh();
  }

  async function changeAppSettings(patch: Partial<AppSettings>) {
    setAppSettings(await saveAppSettings(patch));
  }

  // --- playback ---

  function play(startPhotoId?: string) {
    if (!collection || !photos.length) return;
    // Mount the player synchronously so requestFullscreen() runs inside the
    // click's user activation (required by every browser).
    flushSync(() => setPlaying({ startPhotoId, photos: photos.map(toPhotoInfo) }));
    const el = playerRef.current?.element;
    if (el) void enterFullscreen(el);
  }

  const stopPlaying = useCallback(() => {
    setPlaying(null);
    requestAnimationFrame(() => document.getElementById('play-button')?.focus());
  }, []);

  if (playing && collection) {
    return (
      <Player
        ref={playerRef}
        photos={playing.photos}
        graphics={graphics}
        startPhotoId={playing.startPhotoId}
        settings={collection.settings}
        onExit={stopPlaying}
      />
    );
  }

  const busy = !!importState.progress;

  return (
    <div
      className={`app${dragging ? ' is-dragging' : ''}`}
      onDragOver={(e) => {
        if (canImport && e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={onDrop}
    >
      <a className="skip-link" href="#library">
        Skip to photos
      </a>
      <header className="app-header">
        <a href="/" className="brand" aria-label={`${SITE.name} home`}>
          <img src="/favicon.svg" alt="" width="24" height="24" />
          <span>{SITE.name}</span>
        </a>
        <div className="collection-switch">
          <label htmlFor="collection-select" className="visually-hidden">
            Collection
          </label>
          <select id="collection-select" value={collection?.id ?? ''} onChange={(e) => void switchCollection(e.target.value)}>
            {collections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.count})
              </option>
            ))}
          </select>
          <button type="button" className="btn ghost small" onClick={() => void newCollection()}>
            New collection
          </button>
        </div>
        <span className="spacer" />
        <span className={`net-status ${online ? 'online' : 'offline'}`} role="status" data-testid="net-status">
          <span className="dot" aria-hidden="true" />
          {online ? 'Online' : 'Offline'}
        </span>
        <StorageMeter info={storage} />
        <button
          type="button"
          className="btn ghost"
          aria-expanded={showSettings}
          aria-controls="library-settings"
          onClick={() => setShowSettings((s) => !s)}
        >
          Settings
        </button>
      </header>

      <UpdatePrompt />

      {showSettings && (
        <section id="library-settings" className="panel" aria-label="Library settings">
          <div className="panel-head">
            <h2>Settings</h2>
            <button type="button" className="btn ghost small" onClick={() => setShowSettings(false)}>
              Close
            </button>
          </div>
          <LibrarySettings
            settings={appSettings}
            usage={usage}
            storage={storage}
            onChange={(p) => void changeAppSettings(p)}
            onRequestPersist={() => void requestPersistence().then(() => setDataVersion((v) => v + 1))}
            onDeleteOriginals={() => {
              if (confirm('Delete all kept original files? Slideshow copies are not affected.'))
                void deleteAllOriginals().then(refresh);
            }}
          />
          <h3 className="field-title section-title">Move to another computer</h3>
          <BackupPanel
            collections={collections}
            usage={usage}
            onImported={async (r) => {
              await reloadGraphics();
              await refresh();
              if (r.collections[0]) await switchCollection(r.collections[0].id);
            }}
          />
        </section>
      )}

      <div className="app-body">
        <main className="app-main" id="library" tabIndex={-1}>
          <div className="collection-head">
            {collection && (
              <input
                key={collection.id}
                id="collection-name"
                className="collection-name"
                defaultValue={collection.name}
                aria-label="Collection name"
                onBlur={(e) => {
                  if (e.target.value !== collection.name)
                    void renameCollection(collection.id, e.target.value).then(refresh);
                }}
                onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
              />
            )}
            <span className="muted" data-testid="photo-count">
              {photos.length.toLocaleString()} photo{photos.length === 1 ? '' : 's'}
            </span>
            <span className="spacer" />
            <button type="button" className="btn ghost small danger" onClick={() => void removeCollection()}>
              Delete collection
            </button>
          </div>

          <div className="toolbar" role="toolbar" aria-label="Add and manage photos">
            <button type="button" className="btn" onClick={() => void addFiles('files')} disabled={!canImport}>
              Add photos
            </button>
            <button type="button" className="btn" onClick={() => void addFiles('folder')} disabled={!canImport}>
              Add folder
            </button>
            {collection && (
              <GooglePhotosImport
                online={online}
                collectionId={collection.id}
                onItems={(items, extra) => void startImport(items, 'Google Photos', 'google', extra)}
              />
            )}
            <span className="spacer" />
            {selected.size > 0 && (
              <>
                <span className="muted">{selected.size} selected</span>
                <button type="button" className="btn ghost small" onClick={() => setSelected(new Set())}>
                  Clear
                </button>
                <button type="button" className="btn danger" onClick={() => void removeSelected()}>
                  Remove from collection
                </button>
              </>
            )}
            {selected.size === 0 && photos.length > 0 && (
              <button type="button" className="btn ghost small" onClick={() => setSelected(new Set(photos.map((p) => p.id)))}>
                Select all
              </button>
            )}
          </div>

          <InterruptedJobs
            jobs={interrupted}
            onDismiss={(id) => {
              void dismissJob(id);
              setInterrupted((j) => j.filter((x) => x.id !== id));
            }}
          />
          <ImportPanel state={importState} onCancel={() => importService.cancelAll()} onDismiss={() => importService.dismissLast()} />

          {ready && photos.length === 0 && !busy && (
            <div className="empty">
              <h2>Add some photos to get started</h2>
              <p>
                Choose photos or a whole folder from this computer, pick from Google Photos, or drop files anywhere on this
                page. Photos are resized for your screen and stored only on this device, so slideshows work offline.
              </p>
            </div>
          )}
          <Library photos={photos} selected={selected} onSelectionChange={setSelected} onPlayFrom={(id) => play(id)} />
        </main>

        <aside className="app-side" aria-label="Slideshow">
          <h2>Slideshow</h2>
          {collection && <SlideshowSettings settings={collection.settings} onChange={changePlayback} />}
          {collection && (
            <GraphicsPanel
              graphics={graphics}
              settings={collection.settings.graphics}
              onSettingsChange={(g) => changePlayback({ ...collection.settings, graphics: g })}
              onLibraryChange={() => void reloadGraphics()}
            />
          )}
          <button
            id="play-button"
            type="button"
            className="btn primary play"
            disabled={!photos.length}
            onClick={() => play(selected.size === 1 ? [...selected][0] : undefined)}
          >
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
              <path d="M8 5v14l11-7z" fill="currentColor" />
            </svg>
            Play
          </button>
          <p className="help">
            Opens full screen. Press <kbd>Esc</kbd> once to leave full screen and keep watching in the window, twice to
            stop. <kbd>Space</kbd> pauses, <kbd>←</kbd> <kbd>→</kbd> step through photos.
          </p>
        </aside>
      </div>

      {pending && (
        <ImportConfirmDialog
          pending={pending}
          onTierChange={async (tier) => {
            const bytes = estimateImportBytes(pending.count, tier, { webp: await canEncodeWebP(), originalsBytes: pending.originalsBytes });
            setPending({ ...pending, tier, estimate: await checkImportFits(bytes) });
          }}
          onCancel={() => setPending(null)}
          onConfirm={() => {
            enqueue(pending.items, pending.label, pending.source, pending.tier, pending.extra);
            setPending(null);
          }}
        />
      )}
      {dragging && (
        <div className="drop-overlay" aria-hidden="true">
          Drop photos or folders to add them
        </div>
      )}
    </div>
  );
}
