import { beforeEach, describe, expect, it } from 'vitest';
import { SlideshowDB, isQuotaError, setBlobMode, setDB, type Photo } from '../../src/app/db/db';
import {
  addProcessedPhoto,
  createCollection,
  deleteCollection,
  getCollectionPhotoIds,
  getDisplay,
  libraryUsage,
  removeFromCollection,
} from '../../src/app/db/repo';

let db: SlideshowDB;
let n = 0;

beforeEach(async () => {
  db = new SlideshowDB(`test-${++n}`);
  setDB(db);
  await db.open();
});

function photo(hash: string, over: Partial<Photo> = {}): Omit<Photo, 'id' | 'addedAt'> {
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
    displayBytes: 1000,
    thumbBytes: 100,
    ...over,
  };
}
const blobs = (tag = 'x') => ({ display: new Blob([`display-${tag}`]), thumb: new Blob([`thumb-${tag}`]) });

describe('storage repository', () => {
  it('adds a photo, its blobs and the collection item atomically', async () => {
    const c = await createCollection('A');
    const r = await addProcessedPhoto(c.id, photo('h1'), blobs());
    expect(r.status).toBe('added');
    expect(await getCollectionPhotoIds(c.id)).toEqual([r.photo.id]);
    expect(await db.displays.count()).toBe(1);
    expect(await db.thumbs.count()).toBe(1);
    expect(await (await getDisplay(r.photo.id))!.text()).toBe('display-x');
  });

  it('dedupes by content hash: links across collections, no second copy', async () => {
    const a = await createCollection('A');
    const b = await createCollection('B');
    const first = await addProcessedPhoto(a.id, photo('same'), blobs());
    const again = await addProcessedPhoto(a.id, photo('same'), blobs());
    const other = await addProcessedPhoto(b.id, photo('same'), blobs());
    expect(again.status).toBe('duplicate');
    expect(other.status).toBe('linked');
    expect(other.photo.id).toBe(first.photo.id);
    expect(await db.photos.count()).toBe(1);
    expect(await db.displays.count()).toBe(1);
    expect(await getCollectionPhotoIds(b.id)).toEqual([first.photo.id]);
  });

  it('re-importing at a higher tier upgrades the stored copy in place', async () => {
    const c = await createCollection('A');
    await addProcessedPhoto(c.id, photo('p0'), blobs('p0'));
    const low = await addProcessedPhoto(c.id, photo('h'), blobs('low'));
    const hi = await addProcessedPhoto(c.id, photo('h', { width: 3840, height: 2880, cap: 3840, tier: '4k' }), blobs('hi'));
    expect(hi.status).toBe('upgraded');
    expect(hi.photo.id).toBe(low.photo.id);
    expect(hi.photo.cap).toBe(3840);
    expect(await (await getDisplay(low.photo.id))!.text()).toBe('display-hi');
    // Position in the collection is unchanged.
    expect((await getCollectionPhotoIds(c.id))[1]).toBe(low.photo.id);
  });

  it('removing from a collection garbage-collects only orphaned photos', async () => {
    const a = await createCollection('A');
    const b = await createCollection('B');
    const shared = await addProcessedPhoto(a.id, photo('shared'), blobs());
    await addProcessedPhoto(b.id, photo('shared'), blobs());
    const solo = await addProcessedPhoto(a.id, photo('solo'), blobs());
    await removeFromCollection(a.id, [shared.photo.id, solo.photo.id]);
    expect(await getCollectionPhotoIds(a.id)).toEqual([]);
    expect(await db.photos.get(shared.photo.id)).toBeDefined(); // still in B
    expect(await db.photos.get(solo.photo.id)).toBeUndefined();
    expect(await db.displays.get(solo.photo.id)).toBeUndefined();
    expect(await db.thumbs.get(solo.photo.id)).toBeUndefined();
  });

  it('deleting a collection removes its orphaned photos and blobs', async () => {
    const a = await createCollection('A');
    await addProcessedPhoto(a.id, photo('1'), blobs());
    await addProcessedPhoto(a.id, photo('2'), blobs());
    await deleteCollection(a.id);
    expect(await db.collections.count()).toBe(0);
    expect(await db.items.count()).toBe(0);
    expect(await db.photos.count()).toBe(0);
    expect(await db.displays.count()).toBe(0);
  });

  it('a QuotaExceededError mid-write leaves no partial photo behind', async () => {
    const c = await createCollection('A');
    await addProcessedPhoto(c.id, photo('ok'), blobs());
    db.thumbs.hook('creating', () => {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    });
    let err: unknown;
    try {
      await addProcessedPhoto(c.id, photo('boom'), blobs());
    } catch (e) {
      err = e;
    }
    expect(isQuotaError(err)).toBe(true);
    // The photo row and display blob written earlier in the same transaction were rolled back.
    expect(await db.photos.count()).toBe(1);
    expect(await db.displays.count()).toBe(1);
    expect(await db.items.count()).toBe(1);
    expect((await libraryUsage()).photos).toBe(1);
  });

  it('stores ArrayBuffers where IndexedDB rejects Blobs (WebKit ephemeral sessions)', async () => {
    setBlobMode('buffer');
    const c = await createCollection('A');
    const r = await addProcessedPhoto(c.id, photo('buf'), blobs('buf'));
    const row = await db.displays.get(r.photo.id);
    expect(row?.blob).toBeUndefined();
    expect(row?.data).toBeInstanceOf(ArrayBuffer);
    expect(await (await getDisplay(r.photo.id))!.text()).toBe('display-buf');
  });

  it('switches to ArrayBuffers and retries when a Blob write is rejected mid-import', async () => {
    const c = await createCollection('A');
    db.displays.hook('creating', (_pk, obj) => {
      if ((obj as { blob?: Blob }).blob) {
        throw new DOMException('Error preparing Blob/File data to be stored in object store', 'UnknownError');
      }
    });
    const r = await addProcessedPhoto(c.id, photo('retry'), blobs('retry'));
    expect(r.status).toBe('added');
    expect(await (await getDisplay(r.photo.id))!.text()).toBe('display-retry');
    expect(await db.photos.count()).toBe(1);
  });
});
