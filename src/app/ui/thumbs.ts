/**
 * Object-URL cache for thumbnails. The library grid is virtualized, but
 * scrolling through 1,000+ photos would still create a URL per thumb, so we
 * keep at most MAX alive and revoke the least-recently-used ones.
 */
import { getThumb } from '../db/repo';

const MAX = 600;
const urls = new Map<string, string>();
const inflight = new Map<string, Promise<string | undefined>>();

export function thumbUrl(photoId: string): Promise<string | undefined> {
  const hit = urls.get(photoId);
  if (hit) {
    urls.delete(photoId);
    urls.set(photoId, hit); // bump LRU
    return Promise.resolve(hit);
  }
  let p = inflight.get(photoId);
  if (!p) {
    p = getThumb(photoId).then((blob) => {
      inflight.delete(photoId);
      if (!blob) return undefined;
      const url = URL.createObjectURL(blob);
      urls.set(photoId, url);
      while (urls.size > MAX) {
        const [oldId, oldUrl] = urls.entries().next().value as [string, string];
        urls.delete(oldId);
        URL.revokeObjectURL(oldUrl);
      }
      return url;
    });
    inflight.set(photoId, p);
  }
  return p;
}

export function forgetThumbs(photoIds: string[]) {
  for (const id of photoIds) {
    const u = urls.get(id);
    if (u) URL.revokeObjectURL(u);
    urls.delete(id);
  }
}
