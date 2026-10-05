/**
 * Slideshow engine: playlist, timing, decode/preload window, navigation.
 * Knows nothing about how transitions look – that's the SlideshowFormat's job.
 *
 * Memory: only the current photo and the next `lookahead` photos are kept
 * decoded (ImageBitmap ≈ w×h×4 bytes each; a 2560×1440 derivative is ~15 MB).
 * Everything else is closed immediately. Decoding uses createImageBitmap,
 * which browsers perform off the main thread.
 */
import type { PlaybackSettings } from '../db/db';
import { effectiveFormat } from '../formats';
import { resolveSettings, type FormatInstance, type SlideImage, type Viewport } from '../formats/types';

export interface EngineState {
  /** Position in the (possibly shuffled) playlist. */
  position: number;
  total: number;
  photoId: string | undefined;
  paused: boolean;
  ready: boolean;
  error?: string;
}

export interface EngineOptions {
  canvas: HTMLCanvasElement;
  photoIds: string[];
  settings: PlaybackSettings;
  reducedMotion: boolean;
  viewport: Viewport;
  loadBlob(id: string): Promise<Blob | undefined>;
  onState(s: EngineState): void;
  /** Photo to start on (by id); defaults to the first in playlist order. */
  startPhotoId?: string;
  lookahead?: number;
  /** Injectable for tests. */
  decode?: (blob: Blob) => Promise<SlideImage & { close?: () => void }>;
  random?: () => number;
  setTimer?: (cb: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
}

type Decoded = SlideImage & { close?: () => void };

export function shuffledOrder(n: number, random: () => number = Math.random): number[] {
  const a = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const mod = (a: number, n: number) => ((a % n) + n) % n;

async function decodeBitmap(blob: Blob): Promise<Decoded> {
  const bmp = await createImageBitmap(blob);
  return { source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() };
}

export class SlideshowEngine {
  private order: number[] = [];
  private pos = 0;
  private paused = false;
  private ready = false;
  private destroyed = false;
  private error?: string;
  private format!: FormatInstance;
  private formatKey = '';
  private cache = new Map<number, Promise<Decoded | null>>();
  /** Decoded bitmaps currently held by the cache, by playlist position. */
  private resolved = new Map<number, Decoded>();
  private current?: Decoded;
  private timer: unknown;
  private pendingStep = 0;
  private running = false;
  private abort?: AbortController;
  private readonly lookahead: number;
  private readonly decode: (b: Blob) => Promise<Decoded>;
  private readonly setTimer: (cb: () => void, ms: number) => unknown;
  private readonly clearTimer: (h: unknown) => void;

  constructor(private o: EngineOptions) {
    this.lookahead = o.lookahead ?? 3;
    this.decode = o.decode ?? decodeBitmap;
    this.setTimer = o.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
    this.clearTimer = o.clearTimer ?? ((h) => clearTimeout(h as number));
    this.buildOrder();
    this.createFormat();
  }

  get state(): EngineState {
    const total = this.order.length;
    return {
      position: this.pos,
      total,
      photoId: total ? this.o.photoIds[this.order[this.pos]] : undefined,
      paused: this.paused,
      ready: this.ready,
      error: this.error,
    };
  }

  async start() {
    if (!this.order.length) {
      this.error = 'This collection has no photos yet.';
      return this.emit();
    }
    let first = await this.get(this.pos);
    // Skip unreadable photos at the start.
    for (let tries = 1; !first && tries < this.order.length && !this.destroyed; tries++) {
      this.pos = mod(this.pos + 1, this.order.length);
      first = await this.get(this.pos);
    }
    if (this.destroyed) return;
    if (!first) {
      this.error = 'None of the photos in this collection could be decoded.';
      return this.emit();
    }
    this.current = first;
    this.format.init(first);
    this.ready = true;
    this.emit();
    this.preload();
    this.schedule();
  }

  next() {
    this.request(1);
  }
  prev() {
    this.request(-1);
  }

  pause() {
    this.paused = true;
    this.cancelTimer();
    this.emit();
  }
  resume() {
    this.paused = false;
    this.emit();
    this.schedule();
  }
  togglePause() {
    if (this.paused) this.resume();
    else this.pause();
  }

  resize(v: Viewport) {
    this.o.viewport = v;
    this.format.resize(v);
  }

  /** Apply new settings live. Recreates the format only if it (or its settings) changed. */
  updateSettings(settings: PlaybackSettings, reducedMotion = this.o.reducedMotion) {
    const shuffleChanged = settings.shuffle !== this.o.settings.shuffle;
    this.o.settings = settings;
    this.o.reducedMotion = reducedMotion;
    if (shuffleChanged) {
      const currentIdx = this.order[this.pos];
      this.buildOrder(currentIdx);
      this.dropCache();
    }
    const key = this.computeFormatKey();
    if (key !== this.formatKey) {
      this.abort?.abort();
      this.format.destroy();
      this.createFormat();
      if (this.current) this.format.init(this.current);
    } else {
      this.format.setRenderOptions({ fit: settings.fit, backdrop: settings.backdrop });
    }
    this.preload();
    this.schedule();
  }

  destroy() {
    this.destroyed = true;
    this.cancelTimer();
    this.abort?.abort();
    this.format.destroy();
    this.dropCache();
    this.current?.close?.();
    this.current = undefined;
  }

  // --- internals ---

  private emit() {
    if (!this.destroyed) this.o.onState(this.state);
  }

  private buildOrder(keepFirstIdx?: number) {
    const n = this.o.photoIds.length;
    this.order = this.o.settings.shuffle ? shuffledOrder(n, this.o.random) : Array.from({ length: n }, (_, i) => i);
    const want =
      keepFirstIdx ??
      (this.o.startPhotoId !== undefined ? this.o.photoIds.indexOf(this.o.startPhotoId) : -1);
    this.pos = want >= 0 ? Math.max(0, this.order.indexOf(want)) : 0;
  }

  private computeFormatKey() {
    const f = effectiveFormat(this.o.settings.formatId, this.o.reducedMotion);
    return JSON.stringify([f.id, resolveSettings(f.settingsSchema, this.o.settings.formatSettings[f.id])]);
  }

  private createFormat() {
    const f = effectiveFormat(this.o.settings.formatId, this.o.reducedMotion);
    const settings = resolveSettings(f.settingsSchema, this.o.settings.formatSettings[f.id]);
    this.format = f.create(
      {
        canvas: this.o.canvas,
        viewport: this.o.viewport,
        render: { fit: this.o.settings.fit, backdrop: this.o.settings.backdrop },
      },
      settings,
    );
    this.formatKey = this.computeFormatKey();
  }

  private get(position: number): Promise<Decoded | null> {
    let p = this.cache.get(position);
    if (!p) {
      const id = this.o.photoIds[this.order[position]];
      p = this.o
        .loadBlob(id)
        .then((b) => (b ? this.decode(b) : null))
        .catch(() => null)
        .then((d) => {
          // Evicted (or engine destroyed) while decoding: release immediately.
          if (d && (this.destroyed || this.cache.get(position) !== p)) {
            if (d !== this.current) d.close?.();
          } else if (d) this.resolved.set(position, d);
          return d;
        });
      this.cache.set(position, p);
    }
    return p;
  }

  private evict(position: number) {
    this.cache.delete(position);
    const d = this.resolved.get(position);
    this.resolved.delete(position);
    if (d && d !== this.current) d.close?.();
  }

  /** Keep current + next `lookahead` decoded; release everything else. */
  private preload() {
    const n = this.order.length;
    const keep = new Set<number>();
    for (let i = 0; i <= Math.min(this.lookahead, n - 1); i++) keep.add(mod(this.pos + i, n));
    for (const position of [...this.cache.keys()]) if (!keep.has(position)) this.evict(position);
    for (const position of keep) void this.get(position);
  }

  private dropCache() {
    for (const position of [...this.cache.keys()]) this.evict(position);
  }

  private schedule() {
    this.cancelTimer();
    if (this.paused || !this.ready || this.destroyed || this.order.length < 2 || this.running) return;
    this.timer = this.setTimer(() => this.request(1, false), this.o.settings.intervalSec * 1000);
  }

  private cancelTimer() {
    if (this.timer !== undefined) this.clearTimer(this.timer);
    this.timer = undefined;
  }

  /**
   * Navigation requests are coalesced: pressing → five times quickly jumps
   * five photos with one transition, and a manual press during a transition
   * finishes that transition instantly.
   */
  private request(step: number, manual = true) {
    if (!this.ready || this.order.length < 2) return;
    this.pendingStep += step;
    this.cancelTimer();
    if (manual) this.abort?.abort();
    if (!this.running) void this.loop();
  }

  private async loop() {
    this.running = true;
    const n = this.order.length;
    let badStreak = 0;
    while (this.pendingStep !== 0 && !this.destroyed) {
      const step = this.pendingStep;
      this.pendingStep = 0;
      const target = mod(this.pos + step, n);
      const img = await this.get(target);
      if (this.destroyed) break;
      if (!img) {
        // Unreadable photo: drop it from the cache and keep going in the same direction.
        this.evict(target);
        if (++badStreak >= n) break;
        this.pos = target;
        this.pendingStep += Math.sign(step) || 1;
        continue;
      }
      badStreak = 0;
      const previous = this.current;
      this.pos = target;
      this.emit();
      this.abort = new AbortController();
      // If more presses arrived while decoding, skip the animation.
      const duration = this.pendingStep !== 0 ? 0 : this.o.settings.transitionMs;
      await this.format.transition(img, duration, this.abort.signal);
      // A cached outgoing bitmap is released by preload()'s eviction (or kept if
      // still in the window); one that isn't cached (e.g. after a shuffle
      // change dropped the cache) must be closed here.
      const prevCached = !!previous && [...this.resolved.values()].includes(previous);
      this.current = img;
      this.preload();
      if (previous && previous !== img && !prevCached) previous.close?.();
    }
    this.running = false;
    this.schedule();
  }
}
