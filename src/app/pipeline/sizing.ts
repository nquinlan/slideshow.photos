/**
 * Derivative sizing rules. Pure functions so they can be unit-tested and
 * shared between the main thread (which knows the screen) and workers
 * (which do not have `screen`).
 */

export type QualityTier = 'screen' | 'high' | '4k';

/** Absolute cap for the default "Screen-fit" tier. */
export const SCREEN_FIT_MAX = 2560;

export const TIER_LABELS: Record<QualityTier, string> = {
  screen: 'Screen-fit',
  high: 'High (2560px)',
  '4k': '4K (3840px)',
};

export const THUMB_LONG_EDGE = 320;

export interface ScreenInfo {
  width: number;
  height: number;
  devicePixelRatio: number;
}

export function currentScreen(): ScreenInfo {
  return {
    width: globalThis.screen?.width ?? 1920,
    height: globalThis.screen?.height ?? 1080,
    devicePixelRatio: globalThis.devicePixelRatio || 1,
  };
}

/** Long-edge cap, in pixels, for a quality tier on a given screen. */
export function longEdgeCap(tier: QualityTier, s: ScreenInfo = currentScreen()): number {
  switch (tier) {
    case 'high':
      return 2560;
    case '4k':
      return 3840;
    case 'screen':
    default:
      return Math.min(Math.round(Math.max(s.width, s.height) * s.devicePixelRatio), SCREEN_FIT_MAX);
  }
}

/** Scale (w, h) so the long edge is at most `cap`. Never upscales. */
export function fitLongEdge(w: number, h: number, cap: number): { width: number; height: number } {
  const long = Math.max(w, h);
  if (long <= cap) return { width: w, height: h };
  const k = cap / long;
  return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) };
}

/** EXIF orientations 5-8 swap width and height. */
export function orientedSize(w: number, h: number, orientation: number | undefined) {
  return orientation && orientation >= 5 && orientation <= 8 ? { width: h, height: w } : { width: w, height: h };
}

/**
 * Rough bytes-per-output-pixel for WebP/JPEG photo derivatives, from the
 * Milestone 0 benchmark (see bench/RESULTS.md). Used for pre-import
 * estimates only; deliberately a little pessimistic.
 */
export const BYTES_PER_PIXEL_ESTIMATE = { webp: 0.12, jpeg: 0.19 } as const;
export const THUMB_BYTES_ESTIMATE = 14_000;

/** Default encoder quality (see bench/RESULTS.md for the size/quality trade-off). */
export const DEFAULT_QUALITY = 0.82;
