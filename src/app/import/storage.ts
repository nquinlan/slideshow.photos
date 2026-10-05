/** Storage quota helpers: persistence, usage meter, and pre-import estimates. */
import {
  BYTES_PER_PIXEL_ESTIMATE,
  THUMB_BYTES_ESTIMATE,
  longEdgeCap,
  type QualityTier,
  type ScreenInfo,
} from '../pipeline/sizing';

export interface StorageInfo {
  usage: number;
  quota: number;
  persisted: boolean;
  supported: boolean;
}

export async function getStorageInfo(): Promise<StorageInfo> {
  const sm = globalThis.navigator?.storage;
  if (!sm?.estimate) return { usage: 0, quota: 0, persisted: false, supported: false };
  const [{ usage = 0, quota = 0 }, persisted] = await Promise.all([
    sm.estimate(),
    sm.persisted?.().catch(() => false) ?? Promise.resolve(false),
  ]);
  return { usage, quota, persisted, supported: true };
}

/**
 * Ask the browser not to evict our data under storage pressure. Chrome grants
 * this silently based on engagement (installed PWA, bookmarked…); Firefox
 * shows a prompt; Safari grants it for home-screen apps.
 */
export async function requestPersistence(): Promise<boolean> {
  try {
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}

export interface ImportEstimate {
  /** Estimated bytes that will be added to storage. */
  bytes: number;
  freeBytes: number;
  /** 'ok' | 'tight' (> 80% of remaining) | 'over' (exceeds remaining). */
  level: 'ok' | 'tight' | 'over' | 'unknown';
}

/**
 * Estimate the storage cost of importing `count` photos at `tier`.
 * Assumes 4:3 photos at the cap (pessimistic for small sources) and the
 * bytes/pixel measured in the Milestone 0 benchmark.
 */
export function estimateImportBytes(
  count: number,
  tier: QualityTier,
  opts: { webp: boolean; originalsBytes?: number; screen?: ScreenInfo },
): number {
  const cap = longEdgeCap(tier, opts.screen);
  const pixels = cap * cap * 0.75;
  const bpp = opts.webp ? BYTES_PER_PIXEL_ESTIMATE.webp : BYTES_PER_PIXEL_ESTIMATE.jpeg;
  return Math.round(count * (pixels * bpp + THUMB_BYTES_ESTIMATE) + (opts.originalsBytes ?? 0));
}

export async function checkImportFits(bytes: number): Promise<ImportEstimate> {
  const info = await getStorageInfo();
  if (!info.supported || !info.quota) return { bytes, freeBytes: Infinity, level: 'unknown' };
  const free = Math.max(0, info.quota - info.usage);
  const level = bytes > free ? 'over' : bytes > free * 0.8 ? 'tight' : 'ok';
  return { bytes, freeBytes: free, level };
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}
