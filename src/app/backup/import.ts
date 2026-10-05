/**
 * Import a library export (.zip) made on another computer.
 *
 * - Only the zip's central directory and manifest.json are read up front
 *   (random access on the File), so the summary is instant even for large
 *   exports; each photo is then read individually.
 * - Photos already on this device (same content hash) are reused, not
 *   duplicated; graphics are deduplicated by their exact bytes.
 * - Imported slideshows are added as new collections (renamed if the name
 *   is taken), in their original order, with graphics settings remapped.
 * - If anything fails or the import is cancelled, everything it added is
 *   removed again, so a partial import never lingers.
 */
import { BlobReader, BlobWriter, TextWriter, ZipReader, configure, type Entry, type FileEntry } from '@zip.js/zip.js';
import {
  DEFAULT_PLAYBACK,
  getDB,
  isQuotaError,
  fromStored,
  type CollectionGraphics,
  type Corner,
  type PlaybackSettings,
} from '../db/db';
import {
  addGraphicRecord,
  addProcessedPhoto,
  appendToCollection,
  collectGarbage,
  createCollectionWith,
  deleteCollection,
  deleteGraphic,
} from '../db/repo';
import { GRAPHIC_MIME, sniffGraphicType } from '../graphics/graphics';
import { BackupError, parseManifest, type ExportManifest } from './manifest';

configure({ useWebWorkers: false });

export interface BackupSummary {
  collections: { name: string; photos: number }[];
  photos: number;
  /** Photos not already on this device. */
  newPhotos: number;
  graphics: number;
  /** Approximate storage the import will add. */
  bytesNeeded: number;
  exportedAt: string;
}

export interface OpenBackup {
  manifest: ExportManifest;
  summary: BackupSummary;
  close(): Promise<void>;
  /** @internal */
  entries: Map<string, FileEntry>;
}

export interface ImportProgress {
  phase: 'graphics' | 'photos' | 'slideshows';
  done: number;
  total: number;
}

export interface ImportResult {
  collections: { id: string; name: string }[];
  photosAdded: number;
  photosReused: number;
  graphicsAdded: number;
  graphicsReused: number;
  /** Entries listed in the manifest but missing or unreadable in the zip. */
  skipped: number;
}

const isFile = (e: Entry): e is FileEntry => !e.directory;

export async function openBackup(file: Blob): Promise<OpenBackup> {
  const reader = new ZipReader(new BlobReader(file));
  let entries: Entry[];
  try {
    entries = await reader.getEntries();
  } catch {
    await reader.close().catch(() => undefined);
    throw new BackupError('This file isn’t a readable .zip export.');
  }
  const byName = new Map(entries.filter(isFile).map((e) => [e.filename, e]));
  const manifestEntry = byName.get('manifest.json');
  if (!manifestEntry) {
    await reader.close();
    throw new BackupError('This .zip isn’t a slideshow library export (no manifest.json).');
  }
  let manifest: ExportManifest;
  try {
    manifest = parseManifest(JSON.parse(await manifestEntry.getData(new TextWriter())));
  } catch (e) {
    await reader.close();
    throw e instanceof BackupError ? e : new BackupError('The export’s manifest.json is damaged.');
  }

  const db = getDB();
  const known = new Set(
    (await db.photos.where('contentHash').anyOf(manifest.photos.map((p) => p.contentHash)).toArray()).map((p) => p.contentHash),
  );
  const fresh = manifest.photos.filter((p) => !known.has(p.contentHash));
  const bytesNeeded =
    fresh.reduce((a, p) => a + p.displayBytes + p.thumbBytes + (p.files.original ? (p.originalBytes ?? 0) : 0), 0) +
    manifest.graphics.reduce((a, g) => a + g.bytes, 0);

  return {
    manifest,
    entries: byName,
    close: () => reader.close(),
    summary: {
      collections: manifest.collections.map((c) => ({ name: c.name, photos: c.photoIds.length })),
      photos: manifest.photos.length,
      newPhotos: fresh.length,
      graphics: manifest.graphics.length,
      bytesNeeded,
      exportedAt: manifest.exportedAt,
    },
  };
}

async function sha256(blob: Blob): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

function isImage(bytes: Uint8Array, format: 'webp' | 'jpeg'): boolean {
  if (format === 'jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8;
  return String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP';
}

const clamp = (v: unknown, min: number, max: number, dflt: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : dflt;

/** Sanitise imported playback settings and point graphic references at this device's graphics. */
export function sanitizeSettings(raw: unknown, graphicIds: Map<string, string>): PlaybackSettings {
  const s = (typeof raw === 'object' && raw ? raw : {}) as Record<string, unknown>;
  const formatSettings: PlaybackSettings['formatSettings'] = {};
  if (typeof s.formatSettings === 'object' && s.formatSettings) {
    for (const [k, v] of Object.entries(s.formatSettings as Record<string, unknown>)) {
      if (typeof v === 'object' && v && !Array.isArray(v)) formatSettings[k] = { ...(v as Record<string, unknown>) };
    }
  }
  const g = (typeof s.graphics === 'object' && s.graphics ? s.graphics : {}) as Partial<CollectionGraphics>;
  const share: Record<string, number> = {};
  for (const [oldId, pct] of Object.entries(g.share ?? {})) {
    const id = graphicIds.get(oldId);
    if (id) share[id] = clamp(pct, 0, 50, 0);
  }
  const c = g.corner;
  const corners: Corner[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
  const corner =
    c && graphicIds.has(c.graphicId)
      ? {
          graphicId: graphicIds.get(c.graphicId)!,
          position: corners.includes(c.position) ? c.position : 'bottom-right',
          sizePct: clamp(c.sizePct, 4, 35, 12),
          opacity: clamp(c.opacity, 0.2, 1, 0.9),
          plate: c.plate === true,
        }
      : null;
  return {
    formatId: typeof s.formatId === 'string' ? s.formatId : DEFAULT_PLAYBACK.formatId,
    intervalSec: clamp(s.intervalSec, 2, 60, DEFAULT_PLAYBACK.intervalSec),
    transitionMs: clamp(s.transitionMs, 300, 4000, DEFAULT_PLAYBACK.transitionMs),
    shuffle: s.shuffle === true,
    fit: s.fit === 'cover' ? 'cover' : 'contain',
    backdrop: s.backdrop === 'black' ? 'black' : 'blur',
    formatSettings,
    graphics: { share, corner },
  };
}

async function uniqueName(name: string): Promise<string> {
  const taken = new Set((await getDB().collections.toArray()).map((c) => c.name));
  if (!taken.has(name)) return name;
  for (let i = 1; ; i++) {
    const candidate = i === 1 ? `${name} (imported)` : `${name} (imported ${i})`;
    if (!taken.has(candidate)) return candidate;
  }
}

export async function importBackup(
  open: OpenBackup,
  onProgress?: (p: ImportProgress) => void,
  signal?: AbortSignal,
): Promise<ImportResult> {
  const { manifest: m, entries } = open;
  const db = getDB();
  const created = { collections: [] as string[], photos: [] as string[], graphics: [] as string[] };
  const result: ImportResult = { collections: [], photosAdded: 0, photosReused: 0, graphicsAdded: 0, graphicsReused: 0, skipped: 0 };
  const check = () => {
    if (signal?.aborted) throw new DOMException('Import cancelled', 'AbortError');
  };
  const read = (path: string | undefined, type: string) => {
    const e = path ? entries.get(path) : undefined;
    return e ? e.getData(new BlobWriter(type), { signal }) : Promise.resolve(undefined);
  };

  try {
    // 1. Graphics, deduplicated by exact bytes.
    const graphicIds = new Map<string, string>();
    if (m.graphics.length) {
      const existing = new Map<string, string>();
      for (const g of await db.graphics.toArray()) {
        const f = fromStored(await db.graphicFiles.get(g.id));
        if (f) existing.set(await sha256(f), g.id);
      }
      let i = 0;
      for (const g of m.graphics) {
        check();
        onProgress?.({ phase: 'graphics', done: i++, total: m.graphics.length });
        const blob = await read(g.file, GRAPHIC_MIME[g.type]);
        if (!blob || sniffGraphicType(new Uint8Array(await blob.slice(0, 4096).arrayBuffer())) !== g.type) {
          result.skipped++;
          continue;
        }
        const hash = await sha256(blob);
        const same = existing.get(hash);
        if (same) {
          graphicIds.set(g.id, same);
          result.graphicsReused++;
          continue;
        }
        const { id: _old, addedAt: _a, file: _f, ...rest } = g;
        const added = await addGraphicRecord({ ...rest, bytes: blob.size }, blob);
        created.graphics.push(added.id);
        existing.set(hash, added.id);
        graphicIds.set(g.id, added.id);
        result.graphicsAdded++;
      }
    }

    // 2. Photos, reusing any already on this device.
    const photoIds = new Map<string, string>();
    let i = 0;
    for (const p of m.photos) {
      check();
      onProgress?.({ phase: 'photos', done: i++, total: m.photos.length });
      const existing = await db.photos.where('contentHash').equals(p.contentHash).first();
      if (existing && existing.width * existing.height >= p.width * p.height) {
        photoIds.set(p.id, existing.id);
        result.photosReused++;
        continue;
      }
      const mime = p.format === 'jpeg' ? 'image/jpeg' : 'image/webp';
      const display = await read(p.files.display, mime);
      const thumb = await read(p.files.thumb, mime);
      if (!display || !thumb || !isImage(new Uint8Array(await display.slice(0, 12).arrayBuffer()), p.format)) {
        result.skipped++;
        continue;
      }
      const original = p.files.original ? await read(p.files.original, 'application/octet-stream') : undefined;
      const { id: _id, addedAt: _added, files: _files, ...record } = p;
      const res = await addProcessedPhoto(
        null,
        {
          ...record,
          displayBytes: display.size,
          thumbBytes: thumb.size,
          originalBytes: original ? original.size : undefined,
        },
        { display, thumb, original },
      );
      photoIds.set(p.id, res.photo.id);
      if (res.status === 'added') {
        created.photos.push(res.photo.id);
        result.photosAdded++;
      } else result.photosReused++;
    }
    onProgress?.({ phase: 'photos', done: m.photos.length, total: m.photos.length });

    // 3. Slideshows, as new collections in their original order.
    let c = 0;
    for (const col of m.collections) {
      check();
      onProgress?.({ phase: 'slideshows', done: c++, total: m.collections.length });
      const made = await createCollectionWith(await uniqueName(col.name), sanitizeSettings(col.settings, graphicIds));
      created.collections.push(made.id);
      await appendToCollection(
        made.id,
        col.photoIds.map((id) => photoIds.get(id)).filter((id): id is string => !!id),
      );
      result.collections.push({ id: made.id, name: made.name });
    }
    return result;
  } catch (e) {
    // Roll back everything this import added.
    for (const id of created.collections) await deleteCollection(id).catch(() => undefined);
    await collectGarbage(created.photos).catch(() => undefined);
    for (const id of created.graphics) await deleteGraphic(id).catch(() => undefined);
    if (signal?.aborted || (e as Error).name === 'AbortError') throw new DOMException('Import cancelled', 'AbortError');
    if (isQuotaError(e)) throw new BackupError('There isn’t enough storage space on this device for this import. Nothing was imported.');
    throw e instanceof BackupError ? e : new BackupError(`The import failed: ${(e as Error).message}. Nothing was imported.`);
  }
}
