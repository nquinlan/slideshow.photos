/**
 * Slideshow engine: runs the active format and owns the plumbing around it.
 *
 * Transition formats: the engine owns the playlist (order, shuffle), timing,
 * decode/preload window and coalesced navigation, and asks the format to
 * animate from one photo to the next.
 * Scene formats: the format runs its own loop; the engine hands it a
 * PhotoLibrary and forwards pause/resume/next/prev/resize.
 *
 * Memory (transition formats): only the current photo and the next
 * `lookahead` photos are kept decoded (ImageBitmap ≈ w×h×4 bytes each; a
 * 2560×1440 derivative is ~15 MB). Everything else is closed immediately.
 * Decoding uses createImageBitmap, which browsers perform off the main thread.
 */
import type { PlaybackSettings } from '../db/db';
import { effectiveFormat } from '../formats';
import { shuffledOrder } from '../formats/shared';
import {
  resolveSettings,
  type FormatInstance,
  type GraphicInfo,
  type GraphicsSource,
  type LoadedPhoto,
  type PhotoInfo,
  type PhotoLibrary,
  type SceneInstance,
  type Viewport,
} from '../formats/types';
import { GraphicScheduler } from '../graphics/graphics';
import { decodeGraphic } from './graphicLoader';
import { createLibrary, type Decoder } from './library';

export interface EngineState {
  /** Position in the playlist (transition formats) or the scene's step counter. */
  position: number;
  /** Playlist length for transition formats; 0 for scenes (no fixed sequence). */
  total: number;
  photoId: string | undefined;
  paused: boolean;
  ready: boolean;
  error?: string;
}

export interface EngineOptions {
  canvas: HTMLCanvasElement;
  photos: PhotoInfo[];
  settings: PlaybackSettings;
  reducedMotion: boolean;
  viewport: Viewport;
  loadBlob(id: string): Promise<Blob | undefined>;
  onState(s: EngineState): void;
  /** Photo to start on (by id); defaults to the first in playlist order. */
  startPhotoId?: string;
  lookahead?: number;
  /** Enabled graphics (logos, sponsors) with their share of steps, 0..1. */
  graphics?: { info: GraphicInfo; share: number }[];
  loadGraphic?(id: string): Promise<Blob | undefined>;
  /** Injectable for tests. */
  decode?: Decoder;
  decodeGraphic?: (info: GraphicInfo, blob: Blob) => Promise<LoadedPhoto>;
  random?: () => number;
  setTimer?: (cb: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
}

export { shuffledOrder };

const mod = (a: number, n: number) => ((a % n) + n) % n;

export class SlideshowEngine {
  private order: number[] = [];
  private pos = 0;
  private paused = false;
  private ready = false;
  private destroyed = false;
  private error?: string;
  private format?: FormatInstance;
  private scene?: SceneInstance;
  private scenePosition = 0;
  private formatKey = '';
  private readonly library: PhotoLibrary;
  private graphicItems: { info: GraphicInfo; share: number }[] = [];
  private scheduler = new GraphicScheduler([]);
  /** Shared with scenes; swapping the scheduler doesn't require restarting them. */
  private readonly graphics: GraphicsSource = {
    next: () => this.scheduler.next(),
    load: (id) => this.loadGraphic(id),
  };
  private cache = new Map<number, Promise<LoadedPhoto | null>>();
  /** Decoded bitmaps currently held by the cache, by playlist position. */
  private resolved = new Map<number, LoadedPhoto>();
  private current?: LoadedPhoto;
  private timer: unknown;
  private pendingStep = 0;
  private running = false;
  private abort?: AbortController;
  private readonly lookahead: number;
  private readonly setTimer: (cb: () => void, ms: number) => unknown;
  private readonly clearTimer: (h: unknown) => void;

  constructor(private o: EngineOptions) {
    this.lookahead = o.lookahead ?? 3;
    this.setTimer = o.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
    this.clearTimer = o.clearTimer ?? ((h) => clearTimeout(h as number));
    this.library = createLibrary(o.photos, o.loadBlob, o.decode);
    this.setGraphics(o.graphics ?? []);
    this.buildOrder();
    this.createFormat();
  }

  get state(): EngineState {
    if (this.scene) {
      return {
        position: this.scenePosition,
        total: 0,
        photoId: undefined,
        paused: this.paused,
        ready: this.ready,
        error: this.error,
      };
    }
    const total = this.order.length;
    return {
      position: this.pos,
      total,
      photoId: total ? this.o.photos[this.order[this.pos]].id : undefined,
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
    if (this.scene) return this.startScene(this.scene);
    let first = await this.get(this.pos);
    // Skip unreadable photos at the start.
    for (let tries = 1; !first && tries < this.order.length && !this.destroyed; tries++) {
      this.pos = mod(this.pos + 1, this.order.length);
      first = await this.get(this.pos);
    }
    if (this.destroyed || !this.format) return;
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
    if (this.scene) return this.scene.next();
    this.request(1);
  }
  prev() {
    if (this.scene) return this.scene.prev();
    this.request(-1);
  }

  pause() {
    this.paused = true;
    this.cancelTimer();
    this.scene?.pause();
    this.emit();
  }
  resume() {
    this.paused = false;
    this.scene?.resume();
    this.emit();
    this.schedule();
  }
  togglePause() {
    if (this.paused) this.resume();
    else this.pause();
  }

  resize(v: Viewport) {
    this.o.viewport = v;
    (this.scene ?? this.format)?.resize(v);
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
      const wasScene = !!this.scene;
      this.teardownFormat();
      this.createFormat();
      if (this.scene) {
        if (this.ready) void this.startScene(this.scene);
      } else if (this.format && this.current && !wasScene) {
        this.format.init(this.current);
      } else if (this.ready) {
        // Switched from a scene to a transition format: load the current playlist photo.
        this.ready = false;
        void this.start();
        return;
      }
    } else if (this.scene) {
      this.scene.setRenderOptions({ fit: settings.fit, backdrop: settings.backdrop });
      this.scene.setTiming(this.timing());
      return;
    } else {
      this.format?.setRenderOptions({ fit: settings.fit, backdrop: settings.backdrop });
    }
    if (!this.scene) {
      this.preload();
      this.schedule();
    }
  }

  /** Update the enabled graphics or their shares (live; spacing restarts). */
  setGraphics(items: { info: GraphicInfo; share: number }[]) {
    this.graphicItems = items;
    this.scheduler = new GraphicScheduler(items, this.o.random);
  }

  destroy() {
    this.destroyed = true;
    this.cancelTimer();
    this.teardownFormat();
    this.dropCache();
    this.current?.close();
    this.current = undefined;
  }

  // --- internals ---

  private emit() {
    if (!this.destroyed) this.o.onState(this.state);
  }

  private timing() {
    return { intervalMs: this.o.settings.intervalSec * 1000, transitionMs: this.o.settings.transitionMs };
  }

  private async startScene(scene: SceneInstance) {
    try {
      await scene.start();
    } catch (e) {
      if (scene !== this.scene) return;
      this.error = (e as Error).message || 'This slideshow format could not start.';
      return this.emit();
    }
    if (this.destroyed || scene !== this.scene) return;
    if (this.paused) scene.pause();
    this.ready = true;
    this.emit();
  }

  private buildOrder(keepFirstIdx?: number) {
    const n = this.o.photos.length;
    this.order = this.o.settings.shuffle ? shuffledOrder(n, this.o.random) : Array.from({ length: n }, (_, i) => i);
    const want =
      keepFirstIdx ??
      (this.o.startPhotoId !== undefined ? this.o.photos.findIndex((p) => p.id === this.o.startPhotoId) : -1);
    this.pos = want >= 0 ? Math.max(0, this.order.indexOf(want)) : 0;
  }

  private computeFormatKey() {
    const f = effectiveFormat(this.o.settings.formatId, this.o.reducedMotion);
    // Scenes that use shuffle read it at creation, so a change restarts them.
    const shuffle = f.kind === 'scene' && f.uses.shuffle ? this.o.settings.shuffle : null;
    return JSON.stringify([f.id, resolveSettings(f.settingsSchema, this.o.settings.formatSettings[f.id]), shuffle]);
  }

  private createFormat() {
    const f = effectiveFormat(this.o.settings.formatId, this.o.reducedMotion);
    const settings = resolveSettings(f.settingsSchema, this.o.settings.formatSettings[f.id]);
    const ctx = {
      canvas: this.o.canvas,
      viewport: this.o.viewport,
      render: { fit: this.o.settings.fit, backdrop: this.o.settings.backdrop },
    };
    if (f.kind === 'scene') {
      this.scenePosition = 0;
      const scene: SceneInstance = f.create(
        {
          ...ctx,
          library: this.library,
          graphics: this.graphics,
          timing: this.timing(),
          shuffle: this.o.settings.shuffle,
          random: this.o.random ?? Math.random,
          onStatus: (s) => {
            if (scene !== this.scene) return;
            this.scenePosition = s.position;
            this.emit();
          },
        },
        settings,
      );
      this.scene = scene;
      // Scenes decode their own photos; release the transition playlist's bitmaps.
      this.dropCache();
      this.current?.close();
      this.current = undefined;
    } else {
      this.format = f.create(ctx, settings);
    }
    this.formatKey = this.computeFormatKey();
  }

  private teardownFormat() {
    this.cancelTimer();
    this.abort?.abort();
    this.scene?.destroy();
    this.scene = undefined;
    this.format?.destroy();
    this.format = undefined;
  }

  private async loadGraphic(id: string): Promise<LoadedPhoto | null> {
    const info = this.graphicItems.find((g) => g.info.id === id)?.info;
    if (!info || !this.o.loadGraphic) return null;
    try {
      const blob = await this.o.loadGraphic(id);
      if (!blob) return null;
      const g = await (this.o.decodeGraphic ?? decodeGraphic)(info, blob);
      if (this.destroyed) {
        g.close();
        return null;
      }
      return g;
    } catch {
      return null;
    }
  }

  private get(position: number): Promise<LoadedPhoto | null> {
    let p = this.cache.get(position);
    if (!p) {
      const info = this.o.photos[this.order[position]];
      p = this.library.load(info.id).then((d) => {
        // Evicted (or engine destroyed) while decoding: release immediately.
        if (d && (this.destroyed || this.cache.get(position) !== p)) {
          if (d !== this.current) d.close();
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
    if (d && d !== this.current) d.close();
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
    if (this.scene || this.paused || !this.ready || this.destroyed || this.order.length < 2 || this.running) return;
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
    if (!this.ready || this.order.length < 2 || !this.format) return;
    this.pendingStep += step;
    this.cancelTimer();
    if (manual) this.abort?.abort();
    if (!this.running) void this.loop();
  }

  private async loop() {
    this.running = true;
    const n = this.order.length;
    let badStreak = 0;
    while (this.pendingStep !== 0 && !this.destroyed && this.format) {
      const step = this.pendingStep;
      this.pendingStep = 0;
      // A single step forward may be a graphic's turn: show it without advancing the photo.
      if (step === 1 && this.scheduler.size) {
        const due = this.scheduler.next();
        const graphic = due ? await this.graphics.load(due.id) : null;
        if (this.destroyed || !this.format) {
          graphic?.close();
          break;
        }
        if (graphic) {
          const previous = this.current;
          const prevCached = !!previous && [...this.resolved.values()].includes(previous);
          this.abort = new AbortController();
          await this.format.transition(graphic, this.pendingStep !== 0 ? 0 : this.o.settings.transitionMs, this.abort.signal);
          this.current = graphic;
          if (previous && !prevCached) previous.close();
          continue;
        }
      }
      const target = mod(this.pos + step, n);
      const img = await this.get(target);
      if (this.destroyed || !this.format) break;
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
      if (previous && previous !== img && !prevCached) previous.close();
    }
    this.running = false;
    this.schedule();
  }
}
