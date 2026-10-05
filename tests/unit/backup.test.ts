import { BlobReader, BlobWriter, TextReader, ZipReader, ZipWriter } from '@zip.js/zip.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { planExport, writeExport } from '../../src/app/backup/export';
import { importBackup, openBackup, sanitizeSettings } from '../../src/app/backup/import';
import { BackupError, parseManifest } from '../../src/app/backup/manifest';
import { DEFAULT_PLAYBACK, SlideshowDB, setDB, type Photo } from '../../src/app/db/db';
import {
  addGraphic,
  addProcessedPhoto,
  createCollection,
  getCollection,
  getCollectionPhotoIds,
  getDisplay,
  getGraphicFile,
  listCollections,
  listGraphics,
  updatePlaybackSettings,
} from '../../src/app/db/repo';

let n = 0;
async function freshDB() {
  const db = new SlideshowDB(`backup-${++n}`);
  setDB(db);
  await db.open();
  return db;
}

// Minimal valid image bytes so imports pass the format check.
const webp = (tag: string) => new Blob([new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]), tag], { type: 'image/webp' });
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 120"><rect width="400" height="120" fill="red"/></svg>';

function photo(hash: string): Omit<Photo, 'id' | 'addedAt'> {
  return {
    contentHash: hash,
    source: 'local',
    name: `${hash}.jpg`,
    width: 1920,
    height: 1440,
    sourceWidth: 4032,
    sourceHeight: 3024,
    format: 'webp',
    tier: 'screen',
    cap: 1920,
    displayBytes: 20,
    thumbBytes: 20,
  };
}

/** Build a library on "computer A": two slideshows sharing a photo, a logo with settings. */
async function libraryA() {
  await freshDB();
  const party = await createCollection('Party');
  const gala = await createCollection('Gala');
  const ids: Record<string, string> = {};
  for (const h of ['p1', 'p2', 'p3']) ids[h] = (await addProcessedPhoto(party.id, photo(h), { display: webp(`display-${h}`), thumb: webp(`thumb-${h}`) })).photo.id;
  await addProcessedPhoto(gala.id, photo('p3'), { display: webp('display-p3'), thumb: webp('thumb-p3') }); // shared
  await addProcessedPhoto(gala.id, photo('p4'), { display: webp('display-p4'), thumb: webp('thumb-p4') });
  const logo = await addGraphic(new File([SVG], 'Our logo.svg', { type: 'image/svg+xml' }));
  await updatePlaybackSettings(gala.id, {
    ...DEFAULT_PLAYBACK,
    formatId: 'floating',
    intervalSec: 9,
    graphics: { share: { [logo.id]: 20 }, corner: { graphicId: logo.id, position: 'top-left', sizePct: 15, opacity: 0.7, plate: true } },
  });
  return { party, gala, logo, ids };
}

async function exportZip(collectionIds: string[]) {
  const plan = await planExport({ collectionIds, includeOriginals: false });
  return (await writeExport(plan, null))!;
}

describe('library export / import', () => {
  beforeEach(() => undefined);

  it('round-trips slideshows, photo order, settings and graphics (byte-for-byte) to another device', async () => {
    const a = await libraryA();
    const zip = await exportZip([a.party.id, a.gala.id]);

    // The zip has the manifest first, then the files.
    const names = (await new ZipReader(new BlobReader(zip)).getEntries()).map((e) => e.filename);
    expect(names[0]).toBe('manifest.json');
    expect(names).toContain('README.txt');
    expect(names.filter((x) => x.startsWith('photos/'))).toHaveLength(4); // shared photo stored once

    // "Computer B": empty library.
    await freshDB();
    const opened = await openBackup(zip);
    expect(opened.summary).toMatchObject({ photos: 4, newPhotos: 4, graphics: 1, collections: [{ name: 'Party', photos: 3 }, { name: 'Gala', photos: 2 }] });
    const progress: string[] = [];
    const res = await importBackup(opened, (p) => progress.push(p.phase));
    await opened.close();
    expect(res).toMatchObject({ photosAdded: 4, photosReused: 0, graphicsAdded: 1, skipped: 0 });
    expect(new Set(progress)).toEqual(new Set(['graphics', 'photos', 'slideshows']));

    const cols = await listCollections();
    const party = cols.find((c) => c.name === 'Party')!;
    const gala = cols.find((c) => c.name === 'Gala')!;
    const partyPhotos = await getCollectionPhotoIds(party.id);
    expect(await Promise.all(partyPhotos.map(async (id) => (await getDisplay(id))!.text()))).toEqual(
      ['p1', 'p2', 'p3'].map((h) => `RIFF\0\0\0\0WEBPdisplay-${h}`),
    );
    // Shared photo is one record in both slideshows.
    expect((await getCollectionPhotoIds(gala.id))[0]).toBe(partyPhotos[2]);

    const [logo] = await listGraphics();
    expect(logo.name).toBe('Our logo');
    expect(await (await getGraphicFile(logo.id))!.text()).toBe(SVG);
    const galaSettings = (await getCollection(gala.id))!.settings;
    expect(galaSettings).toMatchObject({ formatId: 'floating', intervalSec: 9 });
    expect(galaSettings.graphics).toEqual({
      share: { [logo.id]: 20 },
      corner: { graphicId: logo.id, position: 'top-left', sizePct: 15, opacity: 0.7, plate: true },
    });
  });

  it('importing again reuses photos and graphics and adds renamed slideshows', async () => {
    const a = await libraryA();
    const zip = await exportZip([a.party.id, a.gala.id]);
    await freshDB();
    for (let i = 0; i < 2; i++) {
      const o = await openBackup(zip);
      await importBackup(o);
      await o.close();
    }
    const db = await import('../../src/app/db/db').then((m) => m.getDB());
    expect(await db.photos.count()).toBe(4);
    expect(await db.graphics.count()).toBe(1);
    expect((await listCollections()).map((c) => c.name).sort()).toEqual(['Gala', 'Gala (imported)', 'Party', 'Party (imported)']);
    const second = await openBackup(zip);
    expect(second.summary.newPhotos).toBe(0);
    await second.close();
  });

  it('exports only the chosen slideshows and the graphics they use', async () => {
    const a = await libraryA();
    const zip = await exportZip([a.party.id]);
    const o = await openBackup(zip);
    expect(o.summary).toMatchObject({ photos: 3, graphics: 0, collections: [{ name: 'Party', photos: 3 }] });
    await o.close();
  });

  it('rolls back everything if the import fails part-way', async () => {
    const a = await libraryA();
    const zip = await exportZip([a.party.id, a.gala.id]);
    const db = await freshDB();
    await createCollection('Existing');
    const o = await openBackup(zip);
    let photos = 0;
    db.photos.hook('creating', () => {
      if (++photos === 3) throw new DOMException('disk full', 'QuotaExceededError');
    });
    await expect(importBackup(o)).rejects.toThrow(/enough storage space/);
    await o.close();
    expect((await listCollections()).map((c) => c.name)).toEqual(['Existing']);
    expect(await db.photos.count()).toBe(0);
    expect(await db.displays.count()).toBe(0);
    expect(await db.graphics.count()).toBe(0);
  });

  it('can be cancelled, leaving nothing behind', async () => {
    const a = await libraryA();
    const zip = await exportZip([a.party.id]);
    const db = await freshDB();
    const o = await openBackup(zip);
    const ac = new AbortController();
    await expect(
      importBackup(o, (p) => {
        if (p.phase === 'photos' && p.done === 1) ac.abort();
      }, ac.signal),
    ).rejects.toThrow(/cancel/i);
    await o.close();
    expect(await db.photos.count()).toBe(0);
    expect(await db.collections.count()).toBe(0);
  });
});

describe('untrusted export files', () => {
  it('rejects files that are not exports', async () => {
    await freshDB();
    await expect(openBackup(new Blob(['not a zip']))).rejects.toBeInstanceOf(BackupError);
    const w = new ZipWriter(new BlobWriter('application/zip'));
    await w.add('hello.txt', new TextReader('hi'));
    await expect(openBackup(await w.close())).rejects.toThrow(/manifest/);
    expect(() => parseManifest({ format: 'something-else' })).toThrow(BackupError);
    expect(() => parseManifest({ format: 'tessera-library', version: 99, collections: [], photos: [], graphics: [] })).toThrow(/newer/);
  });

  it('drops entries with unsafe paths or bad fields', () => {
    const m = parseManifest({
      format: 'tessera-library',
      version: 1,
      collections: [{ id: 'c', name: 'C', settings: {}, photoIds: ['ok', 'evil', 'missing'] }],
      photos: [
        { id: 'ok', contentHash: 'h1', width: 10, height: 10, files: { display: 'photos/ok.webp', thumb: 'thumbs/ok.webp' } },
        { id: 'evil', contentHash: 'h2', width: 10, height: 10, files: { display: '../../etc/passwd', thumb: 'thumbs/e.webp' } },
      ],
      graphics: [{ id: 'g', type: 'exe', width: 1, height: 1, file: 'graphics/g.exe' }],
    });
    expect(m.photos.map((p) => p.id)).toEqual(['ok']);
    expect(m.collections[0].photoIds).toEqual(['ok']);
    expect(m.graphics).toEqual([]);
  });

  it('sanitises imported settings and drops references to graphics that weren’t imported', () => {
    const s = sanitizeSettings(
      { formatId: 'crossfade', intervalSec: 9999, transitionMs: -5, fit: 'stretch', graphics: { share: { a: 80, b: 10 }, corner: { graphicId: 'b', position: 'middle', sizePct: 99, opacity: 3, plate: 'yes' } } },
      new Map([['a', 'A']]),
    );
    expect(s).toMatchObject({ formatId: 'crossfade', intervalSec: 60, transitionMs: 300, fit: 'contain' });
    expect(s.graphics).toEqual({ share: { A: 50 }, corner: null });
  });
});
