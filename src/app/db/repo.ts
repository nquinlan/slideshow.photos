/**
 * Data access for collections and photos. All multi-table writes are
 * transactional.
 */
import {
  DEFAULT_APP_SETTINGS,
  DEFAULT_PLAYBACK,
  blobStorageMode,
  fromStored,
  getDB,
  isBlobStorageError,
  setBlobMode,
  toStored,
  uid,
  type StoredBytes,
  type AppSettings,
  type Collection,
  type PlaybackSettings,
  type Photo,
} from './db';

export interface CollectionSummary extends Collection {
  count: number;
}

export async function listCollections(): Promise<CollectionSummary[]> {
  const db = getDB();
  const cols = await db.collections.orderBy('updatedAt').reverse().toArray();
  return Promise.all(
    cols.map(async (c) => ({
      ...c,
      count: await db.items.where('[collectionId+position]').between([c.id, -Infinity], [c.id, Infinity]).count(),
    })),
  );
}

export async function createCollection(name: string): Promise<Collection> {
  const now = Date.now();
  const c: Collection = {
    id: uid(),
    name: name.trim() || 'Untitled collection',
    createdAt: now,
    updatedAt: now,
    settings: structuredClone(DEFAULT_PLAYBACK),
  };
  await getDB().collections.add(c);
  return c;
}

export async function getCollection(id: string): Promise<Collection | undefined> {
  return getDB().collections.get(id);
}

export async function renameCollection(id: string, name: string) {
  await getDB().collections.update(id, { name: name.trim() || 'Untitled collection', updatedAt: Date.now() });
}

export async function updatePlaybackSettings(id: string, settings: PlaybackSettings) {
  await getDB().collections.update(id, { settings, updatedAt: Date.now() });
}

export async function deleteCollection(id: string) {
  const db = getDB();
  const photoIds = await db.transaction('rw', db.collections, db.items, db.jobs, async () => {
    const items = await db.items.where('[collectionId+position]').between([id, -Infinity], [id, Infinity]).toArray();
    await db.items.bulkDelete(items.map((i) => i.id!));
    await db.collections.delete(id);
    await db.jobs.where('collectionId').equals(id).delete();
    return items.map((i) => i.photoId);
  });
  await collectGarbage(photoIds);
}

/** Ordered photo ids in a collection. */
export async function getCollectionPhotoIds(collectionId: string): Promise<string[]> {
  const items = await getDB()
    .items.where('[collectionId+position]')
    .between([collectionId, -Infinity], [collectionId, Infinity])
    .toArray();
  return items.map((i) => i.photoId);
}

export async function getPhotos(ids: string[]): Promise<Photo[]> {
  const rows = await getDB().photos.bulkGet(ids);
  return rows.filter((p): p is Photo => !!p);
}

export async function getThumb(photoId: string): Promise<Blob | undefined> {
  return fromStored(await getDB().thumbs.get(photoId));
}

export async function getDisplay(photoId: string): Promise<Blob | undefined> {
  return fromStored(await getDB().displays.get(photoId));
}

export async function findPhotoByQuickKey(quickKey: string): Promise<Photo | undefined> {
  return getDB().photos.where('quickKey').equals(quickKey).first();
}

export async function findPhotoByHash(hash: string): Promise<Photo | undefined> {
  return getDB().photos.where('contentHash').equals(hash).first();
}

export async function findPhotoByGoogleId(googleId: string): Promise<Photo | undefined> {
  return getDB().photos.where('googleId').equals(googleId).first();
}

async function nextPosition(collectionId: string): Promise<number> {
  const last = await getDB()
    .items.where('[collectionId+position]')
    .between([collectionId, -Infinity], [collectionId, Infinity])
    .last();
  return (last?.position ?? 0) + 1;
}

/**
 * Link an existing photo into a collection. Returns false if it was already
 * there.
 */
export async function linkPhoto(collectionId: string, photoId: string): Promise<boolean> {
  const db = getDB();
  return db.transaction('rw', db.items, db.collections, async () => {
    const exists = await db.items.where('[collectionId+photoId]').equals([collectionId, photoId]).count();
    if (exists) return false;
    await db.items.add({ collectionId, photoId, position: await nextPosition(collectionId) });
    await db.collections.update(collectionId, { updatedAt: Date.now() });
    return true;
  });
}

export interface NewPhotoBlobs {
  display: Blob;
  thumb: Blob;
  original?: Blob;
}

export type AddResult = { status: 'added' | 'upgraded' | 'duplicate' | 'linked'; photo: Photo };

/**
 * True when `existing` was stored below `cap` and its source had more pixels
 * than were kept, i.e. re-processing at `cap` would give a sharper copy.
 */
export function canUpgrade(existing: Photo, cap: number): boolean {
  return existing.cap < cap && Math.max(existing.sourceWidth, existing.sourceHeight) > Math.max(existing.width, existing.height);
}

/**
 * Store a newly processed photo and add it to a collection, atomically.
 * If a photo with the same content hash already exists, it is linked instead
 * and the new blobs are discarded.
 */
export async function addProcessedPhoto(
  collectionId: string,
  photo: Omit<Photo, 'id' | 'addedAt'>,
  blobs: NewPhotoBlobs,
): Promise<AddResult> {
  const mode = await blobStorageMode();
  try {
    return await writeProcessedPhoto(collectionId, photo, await storedBlobs(blobs, mode));
  } catch (e) {
    // Blob values rejected (WebKit ephemeral storage): switch to ArrayBuffers and retry once.
    if (mode !== 'blob' || !isBlobStorageError(e)) throw e;
    setBlobMode('buffer');
    return writeProcessedPhoto(collectionId, photo, await storedBlobs(blobs, 'buffer'));
  }
}

interface StoredPhotoBlobs {
  display: StoredBytes;
  thumb: StoredBytes;
  original?: StoredBytes;
}

async function storedBlobs(b: NewPhotoBlobs, mode: 'blob' | 'buffer'): Promise<StoredPhotoBlobs> {
  return {
    display: await toStored(b.display, mode),
    thumb: await toStored(b.thumb, mode),
    original: b.original ? await toStored(b.original, mode) : undefined,
  };
}

async function writeProcessedPhoto(
  collectionId: string,
  photo: Omit<Photo, 'id' | 'addedAt'>,
  blobs: StoredPhotoBlobs,
): Promise<AddResult> {
  const db = getDB();
  return db.transaction('rw', [db.photos, db.displays, db.thumbs, db.originals, db.items, db.collections], async () => {
    const existing = await db.photos.where('contentHash').equals(photo.contentHash).first();
    if (existing && photo.width * photo.height > existing.width * existing.height) {
      // Re-import at a higher quality tier: replace the derivative in place so
      // collection membership and ordering are preserved.
      const upgraded: Photo = {
        ...existing,
        width: photo.width,
        height: photo.height,
        format: photo.format,
        tier: photo.tier,
        cap: photo.cap,
        displayBytes: photo.displayBytes,
        thumbBytes: photo.thumbBytes,
        quickKey: existing.quickKey ?? photo.quickKey,
        googleId: existing.googleId ?? photo.googleId,
      };
      if (photo.originalBytes !== undefined) upgraded.originalBytes = photo.originalBytes;
      await db.photos.put(upgraded);
      await db.displays.put({ photoId: existing.id, ...blobs.display });
      await db.thumbs.put({ photoId: existing.id, ...blobs.thumb });
      if (blobs.original) await db.originals.put({ photoId: existing.id, ...blobs.original });
      await linkPhoto(collectionId, existing.id);
      return { status: 'upgraded', photo: upgraded };
    }
    if (existing) {
      // Fill in identifiers that let future imports skip work.
      const patch: Partial<Photo> = {};
      if (photo.quickKey && !existing.quickKey) patch.quickKey = photo.quickKey;
      if (photo.googleId && !existing.googleId) patch.googleId = photo.googleId;
      if (Object.keys(patch).length) await db.photos.update(existing.id, patch);
      const linked = await linkPhoto(collectionId, existing.id);
      return { status: linked ? 'linked' : 'duplicate', photo: existing } as AddResult;
    }
    const full: Photo = { ...photo, id: uid(), addedAt: Date.now() };
    await db.photos.add(full);
    await db.displays.add({ photoId: full.id, ...blobs.display });
    await db.thumbs.add({ photoId: full.id, ...blobs.thumb });
    if (blobs.original) await db.originals.add({ photoId: full.id, ...blobs.original });
    await db.items.add({ collectionId, photoId: full.id, position: await nextPosition(collectionId) });
    await db.collections.update(collectionId, { updatedAt: Date.now() });
    return { status: 'added', photo: full } as AddResult;
  });
}

export async function removeFromCollection(collectionId: string, photoIds: string[]) {
  const db = getDB();
  await db.transaction('rw', db.items, db.collections, async () => {
    const keys = photoIds.map((p) => [collectionId, p] as [string, string]);
    const rows = await db.items.where('[collectionId+photoId]').anyOf(keys).toArray();
    await db.items.bulkDelete(rows.map((r) => r.id!));
    await db.collections.update(collectionId, { updatedAt: Date.now() });
  });
  await collectGarbage(photoIds);
}

/** Delete photos (and their blobs) that are no longer in any collection. */
export async function collectGarbage(candidateIds: string[]) {
  const db = getDB();
  await db.transaction('rw', [db.photos, db.displays, db.thumbs, db.originals, db.items], async () => {
    const orphans: string[] = [];
    for (const id of candidateIds) {
      if ((await db.items.where('photoId').equals(id).count()) === 0) orphans.push(id);
    }
    await Promise.all([
      db.photos.bulkDelete(orphans),
      db.displays.bulkDelete(orphans),
      db.thumbs.bulkDelete(orphans),
      db.originals.bulkDelete(orphans),
    ]);
  });
}

export interface LibraryUsage {
  photos: number;
  displayBytes: number;
  thumbBytes: number;
  originalBytes: number;
}

export async function libraryUsage(): Promise<LibraryUsage> {
  const u: LibraryUsage = { photos: 0, displayBytes: 0, thumbBytes: 0, originalBytes: 0 };
  await getDB().photos.each((p) => {
    u.photos++;
    u.displayBytes += p.displayBytes;
    u.thumbBytes += p.thumbBytes;
    u.originalBytes += p.originalBytes ?? 0;
  });
  return u;
}

export async function deleteAllOriginals() {
  const db = getDB();
  await db.transaction('rw', db.photos, db.originals, async () => {
    await db.originals.clear();
    await db.photos.toCollection().modify((p) => {
      delete p.originalBytes;
    });
  });
}

export async function getAppSettings(): Promise<AppSettings> {
  const row = await getDB().kv.get('settings');
  return { ...DEFAULT_APP_SETTINGS, ...((row?.value as Partial<AppSettings>) ?? {}) };
}

export async function saveAppSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const next = { ...(await getAppSettings()), ...patch };
  await getDB().kv.put({ key: 'settings', value: next });
  return next;
}
