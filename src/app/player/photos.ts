import type { Photo } from '../db/db';
import type { PhotoInfo } from '../formats/types';

/**
 * Stored derivatives are capped (e.g. 2560px), so a large original may be drawn
 * bigger than its stored copy without exceeding the original's resolution.
 * Small originals get maxScale 1: never shown larger than they really are.
 */
export function toPhotoInfo(p: Pick<Photo, 'id' | 'width' | 'height' | 'sourceWidth' | 'sourceHeight'>): PhotoInfo {
  const stored = Math.max(p.width, p.height) || 1;
  const original = Math.max(p.sourceWidth || 0, p.sourceHeight || 0);
  return { id: p.id, width: p.width, height: p.height, maxScale: Math.max(1, original / stored) };
}
