/**
 * Format registry. To add a format: implement SlideshowFormat (see types.ts)
 * and append it here — the settings UI and player pick it up automatically.
 * Unknown ids (e.g. a removed format saved in old settings) fall back to the
 * first entry.
 */
import { crossfade } from './crossfade';
import { floating } from './floating';
import { slidingPanels } from './slidingPanels';
import type { SlideshowFormat } from './types';

export const FORMATS: SlideshowFormat<any>[] = [slidingPanels, floating, crossfade];

export const REDUCED_MOTION_FORMAT_ID = 'crossfade';

export function getFormat(id: string): SlideshowFormat<any> {
  return FORMATS.find((f) => f.id === id) ?? FORMATS[0];
}

/** The format actually used for playback, honouring prefers-reduced-motion. */
export function effectiveFormat(id: string, reducedMotion: boolean): SlideshowFormat<any> {
  return reducedMotion ? getFormat(REDUCED_MOTION_FORMAT_ID) : getFormat(id);
}

export type { SlideshowFormat } from './types';
