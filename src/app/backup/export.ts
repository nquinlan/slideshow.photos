/**
 * Export collections (photos, graphics, settings) to a .zip that can be
 * imported on another computer. Files are streamed into the zip one at a
 * time — straight to disk where the File System Access API exists — so a
 * 1,000-photo library is never held in memory at once. Images are stored
 * without recompression (they're already compressed). Zip64, so exports
 * over 4 GB (e.g. with originals) work.
 */
import { BlobReader, BlobWriter, TextReader, ZipWriter, configure } from '@zip.js/zip.js';
import { SITE } from '../../site';
import { fromStored, getDB } from '../db/db';
import { EXPORT_FORMAT, EXPORT_VERSION, type ExportManifest, type ManifestGraphic, type ManifestPhoto } from './manifest';

configure({ useWebWorkers: false });

export interface ExportOptions {
  collectionIds: string[];
  includeOriginals: boolean;
}

export interface ExportPlan {
  manifest: ExportManifest;
  /** Approximate size of the zip in bytes. */
  bytes: number;
  files: number;
}

export interface ExportProgress {
  done: number;
  total: number;
}

const ext = (format: string) => (format === 'jpeg' ? 'jpg' : 'webp');

function originalExt(type: string | undefined): string {
  const map: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/heic': 'heic',
    'image/heif': 'heif',
    'image/avif': 'avif',
    'image/gif': 'gif',
  };
  return (type && map[type]) || 'bin';
}

/** Build the manifest for the chosen collections and estimate the export size. */
export async function planExport(opts: ExportOptions): Promise<ExportPlan> {
  const db = getDB();
  const cols = (await db.collections.bulkGet(opts.collectionIds)).filter((c) => !!c);
  const collections: ExportManifest['collections'] = [];
  const photoOrder: string[] = [];
  const seen = new Set<string>();
  for (const c of cols) {
    const items = await db.items.where('[collectionId+position]').between([c.id, -Infinity], [c.id, Infinity]).toArray();
    const ids = items.map((i) => i.photoId);
    collections.push({ id: c.id, name: c.name, createdAt: c.createdAt, settings: c.settings, photoIds: ids });
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      photoOrder.push(id);
    }
  }

  const photos: ManifestPhoto[] = [];
  let bytes = 0;
  for (const p of await db.photos.bulkGet(photoOrder)) {
    if (!p) continue;
    let original: string | undefined;
    if (opts.includeOriginals && p.originalBytes) {
      const row = await db.originals.get(p.id);
      const type = row?.blob?.type ?? row?.type;
      if (row) original = `originals/${p.id}.${originalExt(type)}`;
    }
    photos.push({
      ...p,
      originalBytes: original ? p.originalBytes : undefined,
      files: { display: `photos/${p.id}.${ext(p.format)}`, thumb: `thumbs/${p.id}.${ext(p.format)}`, original },
    });
    bytes += p.displayBytes + p.thumbBytes + (original ? (p.originalBytes ?? 0) : 0);
  }

  // Graphics: everything referenced by the exported collections (share > 0 or corner logo).
  const wanted = new Set<string>();
  for (const c of cols) {
    for (const [gid, share] of Object.entries(c.settings.graphics?.share ?? {})) if (share > 0) wanted.add(gid);
    if (c.settings.graphics?.corner) wanted.add(c.settings.graphics.corner.graphicId);
  }
  const graphics: ManifestGraphic[] = (await db.graphics.bulkGet([...wanted]))
    .filter((g) => !!g)
    .map((g) => ({ ...g, file: `graphics/${g.id}.${g.type}` }));
  bytes += graphics.reduce((a, g) => a + g.bytes, 0);

  const files = photos.length * 2 + photos.filter((p) => p.files.original).length + graphics.length + 2;
  // Per-file zip overhead (headers + central directory, Zip64) is small; allow ~200 bytes each.
  bytes += files * 200;
  return {
    manifest: {
      format: EXPORT_FORMAT,
      version: EXPORT_VERSION,
      exportedAt: new Date().toISOString(),
      app: SITE.name,
      collections,
      photos,
      graphics,
    },
    bytes,
    files,
  };
}

export function readmeText(m: ExportManifest): string {
  return [
    `${SITE.name} slideshow library export`,
    `Exported ${m.exportedAt}`,
    '',
    `Slideshows: ${m.collections.map((c) => `${c.name} (${c.photoIds.length} photos)`).join(', ') || 'none'}`,
    `Photos: ${m.photos.length}  Graphics: ${m.graphics.length}`,
    '',
    `To use on another computer: open ${SITE.name}, choose Settings → Move to another computer → Import,`,
    'and pick this .zip file. Photos already on that computer are reused, not duplicated.',
    '',
    'photos/ holds the slideshow copies, thumbs/ the library thumbnails, graphics/ the logo and',
    'sponsor files exactly as uploaded, and originals/ any original files you chose to include.',
    '',
  ].join('\n');
}

/**
 * Write the export. With a WritableStream (e.g. from showSaveFilePicker) the
 * zip streams to disk and nothing is returned; otherwise it's built as a Blob.
 */
export async function writeExport(
  plan: ExportPlan,
  target: WritableStream<Uint8Array> | null,
  onProgress?: (p: ExportProgress) => void,
  signal?: AbortSignal,
): Promise<Blob | undefined> {
  const db = getDB();
  const writer = target ?? new BlobWriter('application/zip');
  const zip = new ZipWriter(writer, { zip64: true, keepOrder: true });
  const total = plan.files;
  let done = 0;
  const tick = () => onProgress?.({ done: ++done, total });
  const add = async (name: string, data: Blob | string, level = 0) => {
    if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
    const reader = typeof data === 'string' ? new TextReader(data) : new BlobReader(data);
    await zip.add(name, reader, { level, signal });
    tick();
  };

  const m = plan.manifest;
  // Manifest first, so an import can show what's inside without reading the rest.
  await add('manifest.json', JSON.stringify(m, null, 2), 6);
  await add('README.txt', readmeText(m), 6);
  for (const g of m.graphics) {
    const file = fromStored(await db.graphicFiles.get(g.id));
    if (file) await add(g.file, file);
    else tick();
  }
  for (const p of m.photos) {
    const display = fromStored(await db.displays.get(p.id));
    const thumb = fromStored(await db.thumbs.get(p.id));
    if (display) await add(p.files.display, display);
    else tick();
    if (thumb) await add(p.files.thumb, thumb);
    else tick();
    if (p.files.original) {
      const original = fromStored(await db.originals.get(p.id));
      if (original) await add(p.files.original, original);
      else tick();
    }
  }
  const result = await zip.close();
  return target ? undefined : (result as Blob);
}

export function suggestedFileName(): string {
  const d = new Date();
  const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return `${SITE.name.toLowerCase()}-library-${ymd}.zip`;
}
