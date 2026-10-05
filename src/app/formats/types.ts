/**
 * Slideshow format plugin interface.
 *
 * The player core (player/engine.ts) owns playback plumbing: decoding,
 * memory, pause/resume, next/prev input, full-screen, wake lock. Formats come
 * in two kinds:
 *
 *  - `transition` formats (e.g. Crossfade) only say *how* one photo becomes
 *    the next. The engine owns the playlist, timing and preloading and calls
 *    `transition()` for each step.
 *  - `scene` formats (e.g. Sliding Panels, Floating) show several photos at
 *    once and run their own loop. They get a `PhotoLibrary` that can decode
 *    any photo at the size it will be drawn, and receive pause/next/prev from
 *    the engine.
 *
 * Adding a format means implementing one of these and registering it in
 * formats/index.ts; no core changes. Its `settingsSchema` is rendered
 * automatically by the settings UI and persisted per collection, and `uses`
 * says which global settings (interval, transition speed, …) apply to it.
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
  /** Set when this image is a graphic: draw it whole on its background colour. */
  graphic?: GraphicInfo;
}

/** A logo/sponsor graphic as the player sees it. Always shown whole (contain), never cropped. */
export interface GraphicInfo {
  id: string;
  width: number;
  height: number;
  /** SVGs scale freely; PNGs are never enlarged past their native size. */
  kind: 'vector' | 'raster';
  /** CSS colour filling the graphic's space. */
  background: string;
  /** Size within its space, %. */
  scalePct: number;
  /** Take the whole screen when shown, rather than mixing in with photos. */
  fullScreen: boolean;
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

/** Which global playback settings a format uses (the settings UI hides the rest). */
export interface GlobalSettingUse {
  /** Label for the interval slider, or false if the format has no interval. */
  interval: string | false;
  transition: boolean;
  shuffle: boolean;
  fit: boolean;
  backdrop: boolean;
}

interface FormatMeta {
  id: string;
  name: string;
  description: string;
  settingsSchema: SettingField[];
  uses: GlobalSettingUse;
}

export interface TransitionFormat<S extends FormatSettings = FormatSettings> extends FormatMeta {
  kind: 'transition';
  create(ctx: FormatContext, settings: S): FormatInstance;
}

/** A decoded photo handed to a scene. The scene must close() it when done. */
export interface LoadedPhoto extends SlideImage {
  id: string;
  close(): void;
}

export interface PhotoLibrary {
  /** Every photo in the collection, in collection order. */
  readonly photos: readonly PhotoInfo[];
  /**
   * Decode a photo. Pass the box (device px) it will be drawn into and it is
   * decoded no larger than needed to cover that box, which keeps memory low
   * when many photos are on screen. Resolves null if the photo can't be read.
   */
  load(id: string, box?: { width: number; height: number }): Promise<LoadedPhoto | null>;
}

export interface SceneTiming {
  /** Global "interval" setting, in ms. */
  intervalMs: number;
  /** Global "transition speed" setting, in ms. */
  transitionMs: number;
}

export interface SceneStatus {
  /** Monotonic step counter (e.g. layouts shown), surfaced for tests and screen readers. */
  position: number;
}

export interface SceneContext extends FormatContext {
  library: PhotoLibrary;
  timing: SceneTiming;
  /** Global shuffle setting (for scenes whose `uses.shuffle` is true). */
  shuffle: boolean;
  random: () => number;
  onStatus(status: SceneStatus): void;
}

export interface SceneInstance {
  /** Load and show the first content, then keep running until destroyed. Resolves once something is on screen. */
  start(): Promise<void>;
  pause(): void;
  resume(): void;
  /** User asked for the next / previous content. Formats may ignore prev. */
  next(): void;
  prev(): void;
  resize(viewport: Viewport): void;
  setRenderOptions(render: RenderOptions): void;
  setTiming(timing: SceneTiming): void;
  /** Stop all animation and close every LoadedPhoto it holds. */
  destroy(): void;
}

export interface SceneFormat<S extends FormatSettings = FormatSettings> extends FormatMeta {
  kind: 'scene';
  create(ctx: SceneContext, settings: S): SceneInstance;
}

export type SlideshowFormat<S extends FormatSettings = FormatSettings> = TransitionFormat<S> | SceneFormat<S>;

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
