import { beforeEach, describe, expect, it } from 'vitest';
import { SlideshowDB, setDB } from '../../src/app/db/db';
import { createCollection, getCollectionPhotoIds } from '../../src/app/db/repo';
import { AuthExpiredError, FatalImportError, runImport, type ImportItem } from '../../src/app/import/importer';
import type { PipelinePool } from '../../src/app/pipeline/pool';
import type { ProcessResult } from '../../src/app/pipeline/types';

let db: SlideshowDB;
let n = 0;
beforeEach(async () => {
  db = new SlideshowDB(`imp-${++n}`);
  setDB(db);
  await db.open();
});

/** Fake pool: "hash" is the blob's text, so identical contents dedupe. */
function fakePool(opts: { failOn?: string } = {}) {
  let processed = 0;
  const pool = {
    size: 2,
    get processed() {
      return processed;
    },
    async process(blob: Blob): Promise<ProcessResult> {
      const text = await blob.text();
      if (text === opts.failOn) throw new Error('corrupt image');
      processed++;
      return {
        display: new Blob(['d' + text]),
        thumb: new Blob(['t' + text]),
        width: 100,
        height: 75,
        thumbWidth: 32,
        thumbHeight: 24,
        contentHash: `hash-${text}`,
        format: 'webp',
        sourceWidth: 100,
        sourceHeight: 75,
        timings: { decode: 0, encode: 0, total: 0 },
        decoder: 'native',
      };
    },
  };
  return pool as unknown as PipelinePool & { processed: number };
}

const item = (name: string, content = name, extra: Partial<ImportItem> = {}): ImportItem => ({
  key: name,
  name,
  quickKey: `${name}|${content.length}|0`,
  load: async () => new Blob([content]),
  ...extra,
});

describe('runImport', () => {
  it('imports, dedupes by quick key and by content hash, and reports failures', async () => {
    const c = await createCollection('A');
    const pool = fakePool({ failOn: 'bad' });
    const first = await runImport(pool, {
      collectionId: c.id,
      source: 'local',
      items: [item('a'), item('b'), item('copy-of-a', 'a'), item('bad')],
      tier: 'screen',
      keepOriginals: false,
    }).done;
    expect(first.status).toBe('done');
    expect(first.imported).toBe(2);
    expect(first.skipped).toBe(1); // copy-of-a: same content hash
    expect(first.failed).toBe(1);
    expect(await getCollectionPhotoIds(c.id)).toHaveLength(2);

    // Re-selecting the same files ("resume") skips them without reading bytes.
    const before = pool.processed;
    const again = await runImport(pool, {
      collectionId: c.id,
      source: 'local',
      items: [item('a'), item('b')],
      tier: 'screen',
      keepOriginals: false,
    }).done;
    expect(again.skipped).toBe(2);
    expect(pool.processed).toBe(before);
  });

  it('persists the job record with progress', async () => {
    const c = await createCollection('A');
    const h = runImport(fakePool(), { collectionId: c.id, source: 'local', items: [item('x')], tier: 'screen', keepOriginals: false });
    await h.done;
    const job = await db.jobs.get(h.jobId);
    expect(job?.status).toBe('done');
    expect(job?.imported).toBe(1);
  });

  it('stops cleanly on QuotaExceededError, keeping what was saved', async () => {
    const c = await createCollection('A');
    let writes = 0;
    db.displays.hook('creating', () => {
      if (++writes > 2) throw new DOMException('quota', 'QuotaExceededError');
    });
    const res = await runImport(fakePool(), {
      collectionId: c.id,
      source: 'local',
      items: ['1', '2', '3', '4', '5', '6'].map((x) => item(x)),
      tier: 'screen',
      keepOriginals: false,
      lanes: 1,
    }).done;
    expect(res.status).toBe('failed');
    expect(res.error).toMatch(/Storage is full/);
    expect(res.imported).toBe(2);
    expect(res.remainingKeys).toEqual(['3', '4', '5', '6']);
    expect(await db.photos.count()).toBe(2);
    expect(await getCollectionPhotoIds(c.id)).toHaveLength(2);
  });

  it('pauses on expired Google auth and records remaining ids for resume', async () => {
    const c = await createCollection('A');
    const g = (id: string, expired = false): ImportItem => ({
      key: id,
      name: id,
      googleId: id,
      load: async () => {
        if (expired) throw new AuthExpiredError();
        return new Blob([id]);
      },
    });
    const h = runImport(fakePool(), {
      collectionId: c.id,
      source: 'google',
      items: [g('g1'), g('g2', true), g('g3')],
      tier: 'screen',
      keepOriginals: false,
      lanes: 1,
      jobExtra: { google: { sessionId: 's1', remainingIds: [] } },
    });
    const res = await h.done;
    expect(res.status).toBe('paused');
    expect(res.imported).toBe(1);
    const job = await db.jobs.get(h.jobId);
    expect(job?.google?.sessionId).toBe('s1');
    expect(job?.google?.remainingIds).toEqual(['g2', 'g3']);
  });

  it('a fatal error (e.g. CORS-blocked downloads) stops the whole job once', async () => {
    const c = await createCollection('A');
    const blocked: ImportItem = { key: 'b', name: 'b', load: async () => { throw new FatalImportError('blocked'); } };
    const res = await runImport(fakePool(), {
      collectionId: c.id, source: 'google', items: [blocked, item('z')], tier: 'screen', keepOriginals: false, lanes: 1,
    }).done;
    expect(res.status).toBe('failed');
    expect(res.error).toBe('blocked');
    expect(res.failed).toBe(0);
  });

  it('can be cancelled', async () => {
    const c = await createCollection('A');
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow: ImportItem = { key: 's', name: 's', load: async () => { await gate; return new Blob(['s']); } };
    const h = runImport(fakePool(), { collectionId: c.id, source: 'local', items: [slow, item('later')], tier: 'screen', keepOriginals: false, lanes: 1 });
    h.cancel();
    release();
    const res = await h.done;
    expect(res.status).toBe('cancelled');
    expect(await db.photos.count()).toBe(0);
  });
});
