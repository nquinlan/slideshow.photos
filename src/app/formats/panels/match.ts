/**
 * Assign photos to tiles by shape: wide tiles get landscape photos, tall
 * tiles portraits, squarish tiles something near square, so the cover-crop
 * removes as little as possible. Photos that would have to be upscaled past
 * their original resolution to fill a tile are penalised too.
 */
import type { PhotoInfo } from '../types';
import type { Rect } from './layout';

export interface MatchOptions {
  random: () => number;
  /** Ids to avoid (e.g. photos on screen in the previous layouts). */
  avoid?: ReadonlySet<string>;
  /** How many random candidates to consider (keeps it O(tiles × sample) for big libraries). */
  sampleSize?: number;
}

/** Cost of showing `p` in `tile`: aspect mismatch (log scale) plus any upscaling beyond the original. */
export function matchCost(p: PhotoInfo, tile: Rect): number {
  const aspect = Math.abs(Math.log(p.width / p.height) - Math.log(tile.w / tile.h));
  const coverScale = Math.max(tile.w / p.width, tile.h / p.height);
  const upscale = Math.max(0, Math.log(coverScale / p.maxScale));
  return aspect + 0.5 * upscale;
}

function sample<T>(items: readonly T[], n: number, random: () => number): T[] {
  if (items.length <= n) return [...items];
  const a = [...items];
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(random() * (a.length - i));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}

/** Returns one photo id per tile (same order as `tiles`), never repeating a photo within the layout. */
export function assignPhotos(tiles: Rect[], photos: readonly PhotoInfo[], o: MatchOptions): string[] {
  const fresh = o.avoid?.size ? photos.filter((p) => !o.avoid!.has(p.id)) : photos;
  // Fall back to recently shown photos only when the library is too small.
  const pool = fresh.length >= tiles.length ? fresh : photos;
  let candidates = sample(pool, Math.max(o.sampleSize ?? 48, tiles.length), o.random);
  const out = new Array<string>(tiles.length);
  // Biggest tiles choose first: their crop is the most visible.
  const order = tiles.map((t, i) => [i, t.w * t.h] as const).sort((a, b) => b[1] - a[1]);
  for (const [i] of order) {
    if (!candidates.length) candidates = sample(photos, tiles.length, o.random); // tiny library: allow repeats
    const ranked = candidates.map((p) => [p, matchCost(p, tiles[i])] as const).sort((a, b) => a[1] - b[1]);
    // A little randomness among the best few keeps layouts from always pairing the same photos.
    const r = o.random();
    const k = Math.min(ranked.length - 1, r < 0.6 ? 0 : r < 0.85 ? 1 : 2);
    const chosen = ranked[k][0];
    out[i] = chosen.id;
    candidates = candidates.filter((p) => p !== chosen);
  }
  return out;
}
