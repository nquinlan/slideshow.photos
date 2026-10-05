/**
 * IndexedDB schema (Dexie).
 *
 * Blobs live in their own tables (`displays`, `thumbs`, `originals`) keyed by
 * photo id, so listing/sorting thousands of photo records never pulls image
 * bytes into memory. Photos are shared across collections and deduped by
 * content hash; a photo is garbage-collected when no collection references it.
 *
 * Every photo is written in a single transaction (record + blobs + collection
 * item), so a QuotaExceededError mid-import aborts that one photo cleanly and
 * never leaves a half-written entry behind.
 */
import Dexie, { type EntityTable, type Table } from 'dexie';
import type { QualityTier } from '../pipeline/sizing';
import type { OutputFormat } from '../pipeline/types';

export type PhotoSource = 'local' | 'google';

export interface Photo {
  id: string;
  contentHash: string;
  /** name|size|lastModified for local files – lets re-imports skip without reading bytes. */
  quickKey?: string;
  source: PhotoSource;
  /** Google Photos media item id (for dedupe across picker sessions). */
  googleId?: string;
  name: string;
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
  format: OutputFormat;
  tier: QualityTier;
  cap: number;
  displayBytes: number;
  thumbBytes: number;
  originalBytes?: number;
  takenAt?: number;
  addedAt: number;
}

/**
 * Image bytes. Normally a Blob; but WebKit refuses Blobs in IndexedDB in
 * ephemeral sessions (Safari Private Browsing, automation) with
 * "UnknownError: Error preparing Blob/File data to be stored in object store",
 * so there we store an ArrayBuffer + MIME type instead. Reads accept both.
 */
export interface BlobRow {
  photoId: string;
  blob?: Blob;
  data?: ArrayBuffer;
  type?: string;
}

export type StoredBytes = Omit<BlobRow, 'photoId'>;
export type BlobMode = 'blob' | 'buffer';

let blobMode: Promise<BlobMode> | undefined;

/** Probe once per database whether IndexedDB accepts Blob values. */
export function blobStorageMode(): Promise<BlobMode> {
  blobMode ??= (async () => {
    const db = getDB();
    try {
      await db.kv.put({ key: '__blob_probe', value: new Blob(['probe'], { type: 'text/plain' }) });
      await db.kv.delete('__blob_probe');
      return 'blob';
    } catch (e) {
      return isBlobStorageError(e) ? 'buffer' : 'blob';
    }
  })();
  return blobMode;
}

export function setBlobMode(mode: BlobMode) {
  blobMode = Promise.resolve(mode);
}

export function isBlobStorageError(e: unknown): boolean {
  let cur: any = e;
  for (let i = 0; cur && i < 5; i++) {
    if (cur.name === 'DataCloneError') return true;
    if (typeof cur.message === 'string' && /Blob\/File data|preparing Blob/i.test(cur.message)) return true;
    cur = cur.inner ?? cur.cause;
  }
  return false;
}

/** Convert a Blob to its stored form. Must be awaited *outside* IndexedDB transactions. */
export async function toStored(blob: Blob, mode: BlobMode): Promise<StoredBytes> {
  return mode === 'blob' ? { blob } : { data: await blob.arrayBuffer(), type: blob.type };
}

export function fromStored(row: StoredBytes | undefined): Blob | undefined {
  if (!row) return undefined;
  if (row.blob) return row.blob;
  if (row.data) return new Blob([row.data], { type: row.type ?? '' });
  return undefined;
}

export interface Collection {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  settings: PlaybackSettings;
}

export interface CollectionItem {
  id?: number;
  collectionId: string;
  photoId: string;
  position: number;
}

export type Fit = 'contain' | 'cover';
export type Backdrop = 'blur' | 'black';

export interface PlaybackSettings {
  formatId: string;
  /** Seconds each photo is shown (excluding the transition). */
  intervalSec: number;
  /** Transition duration in ms. */
  transitionMs: number;
  shuffle: boolean;
  fit: Fit;
  backdrop: Backdrop;
  /** Per-format settings, keyed by format id. */
  formatSettings: Record<string, Record<string, unknown>>;
}

export const DEFAULT_PLAYBACK: PlaybackSettings = {
  formatId: 'sliding-tiles',
  intervalSec: 6,
  transitionMs: 1400,
  shuffle: false,
  fit: 'contain',
  backdrop: 'blur',
  formatSettings: {},
};

export type JobStatus = 'running' | 'paused' | 'interrupted' | 'done' | 'cancelled' | 'failed';

export interface ImportJob {
  id: string;
  collectionId: string;
  source: PhotoSource;
  status: JobStatus;
  createdAt: number;
  updatedAt: number;
  total: number;
  imported: number;
  skipped: number;
  failed: number;
  tier: QualityTier;
  error?: string;
  /** Google: the picker session + items not yet imported, for resume after re-auth. */
  google?: { sessionId: string; sessionExpireTime?: string; remainingIds: string[] };
}

export interface AppSettings {
  tier: QualityTier;
  keepOriginals: boolean;
  lastCollectionId?: string;
  persistRequested?: boolean;
}

export const DEFAULT_APP_SETTINGS: AppSettings = { tier: 'screen', keepOriginals: false };

interface KV {
  key: string;
  value: unknown;
}

export class SlideshowDB extends Dexie {
  photos!: EntityTable<Photo, 'id'>;
  displays!: Table<BlobRow, string>;
  thumbs!: Table<BlobRow, string>;
  originals!: Table<BlobRow, string>;
  collections!: EntityTable<Collection, 'id'>;
  items!: EntityTable<CollectionItem, 'id'>;
  jobs!: EntityTable<ImportJob, 'id'>;
  kv!: Table<KV, string>;

  constructor(name = 'tessera') {
    super(name);
    this.version(1).stores({
      photos: 'id, &contentHash, quickKey, googleId, addedAt',
      displays: 'photoId',
      thumbs: 'photoId',
      originals: 'photoId',
      collections: 'id, updatedAt',
      items: '++id, [collectionId+position], &[collectionId+photoId], photoId',
      jobs: 'id, status, collectionId',
      kv: 'key',
    });
  }
}

let instance: SlideshowDB | undefined;
export function getDB(): SlideshowDB {
  instance ??= new SlideshowDB();
  return instance;
}
/** Tests only. */
export function setDB(db: SlideshowDB) {
  instance = db;
  blobMode = undefined;
}

export function isQuotaError(e: unknown): boolean {
  let cur: any = e;
  for (let i = 0; cur && i < 5; i++) {
    if (cur.name === 'QuotaExceededError' || cur.name === 'NS_ERROR_DOM_QUOTA_REACHED') return true;
    if (typeof cur.message === 'string' && /quota/i.test(cur.message)) return true;
    cur = cur.inner ?? cur.cause;
  }
  return false;
}

export function uid(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
