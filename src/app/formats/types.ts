/**
 * Slideshow format plugin interface.
 *
 * The player core (player/engine.ts) owns *what* is shown and *when*:
 * playlist order, decoding/preloading, timers, input, full-screen. A format
 * owns only *how* one image becomes the next on a canvas. Adding a format
 * means implementing `SlideshowFormat` and registering it in formats/index.ts;
 * no core changes. Its `settingsSchema` is rendered automatically by the
 * settings UI and its values are persisted per collection.
 */
import type { Backdrop, Fit } from '../db/db';

export type SettingField =
  | {
      key: string;
      label: string;
      type: 'number';
      min: number;
      max: number;
      step: number;
      unit?: string;
      default: number;
      help?: string;
    }
  | {
      key: string;
      label: string;
      type: 'select';
      options: { value: string; label: string }[];
      default: string;
      help?: string;
    }
  | { key: string; label: string; type: 'boolean'; default: boolean; help?: string };

export type FormatSettings = Record<string, number | string | boolean>;

export interface Viewport {
  /** CSS pixels. */
  width: number;
  height: number;
  devicePixelRatio: number;
}

export interface RenderOptions {
  fit: Fit;
  backdrop: Backdrop;
}

/** Anything drawable with known intrinsic size (normally a decoded ImageBitmap). */
export interface SlideImage {
  source: CanvasImageSource;
  width: number;
  height: number;
  /**
   * Largest scale (destination px per source px) this image may be drawn at
   * without exceeding the original photo's resolution. Formats must not
   * upscale beyond it. Undefined = no limit (e.g. synthetic images in tests).
   */
  maxScale?: number;
}

/** What the player knows about each photo before decoding it. */
export interface PhotoInfo {
  id: string;
  /** Stored derivative size in px. */
  width: number;
  height: number;
  /** Max scale of the stored derivative before exceeding the original (≥ 1). */
  maxScale: number;
}

export interface FormatContext {
  canvas: HTMLCanvasElement;
  viewport: Viewport;
  render: RenderOptions;
}

export interface FormatInstance {
  /** Show the first image immediately (no transition). */
  init(first: SlideImage): void;
  /**
   * Animate from the current image to `next` over `durationMs`.
   * Resolves when the transition has finished. If `signal` aborts, the format
   * must jump to the final state (next image fully shown) and resolve.
   */
  transition(next: SlideImage, durationMs: number, signal?: AbortSignal): Promise<void>;
  /** Viewport changed (window resize, full-screen toggle, DPR change). Redraw current state. */
  resize(viewport: Viewport): void;
  /** Update render options (fit/backdrop) and redraw. */
  setRenderOptions(render: RenderOptions): void;
  /** Release canvases/listeners. The engine owns and closes the ImageBitmaps it passed in. */
  destroy(): void;
}

export interface SlideshowFormat<S extends FormatSettings = FormatSettings> {
  id: string;
  name: string;
  description: string;
  settingsSchema: SettingField[];
  create(ctx: FormatContext, settings: S): FormatInstance;
}

export function defaultSettings(schema: SettingField[]): FormatSettings {
  return Object.fromEntries(schema.map((f) => [f.key, f.default]));
}

/** Merge stored values over defaults, dropping unknown keys and coercing out-of-range values. */
export function resolveSettings(schema: SettingField[], stored: Record<string, unknown> | undefined): FormatSettings {
  const out = defaultSettings(schema);
  for (const f of schema) {
    const v = stored?.[f.key];
    if (v === undefined) continue;
    if (f.type === 'number' && typeof v === 'number' && Number.isFinite(v)) out[f.key] = Math.min(f.max, Math.max(f.min, v));
    else if (f.type === 'select' && typeof v === 'string' && f.options.some((o) => o.value === v)) out[f.key] = v;
    else if (f.type === 'boolean' && typeof v === 'boolean') out[f.key] = v;
  }
  return out;
}
