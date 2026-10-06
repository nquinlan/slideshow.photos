/**
 * Floating: photos drift across a black screen at three depths, like the
 * classic "Floating" photo screen saver. Nearer photos are larger, brighter
 * and move faster (parallax); new photos keep entering as others leave.
 *
 * Performance: each photo is decoded at its on-screen size, then rendered
 * once into a sprite (white border, soft shadow and depth dimming baked in)
 * and the bitmap released. Every frame is then one drawImage per photo,
 * which holds 60 fps with a dozen photos on screen. Motion is time-based.
 */
import { createSurface, ctx2d, drawGraphic, keepOutPixels, rafScheduler, shuffledOrder, sizeCanvas, stageSize, type Scheduler, type Surface } from './shared';
import type {
  FormatSettings,
  LoadedPhoto,
  RenderOptions,
  SceneContext,
  SceneFormat,
  SceneInstance,
  SceneTiming,
  Viewport,
} from './types';

export interface FloatingSettings extends FormatSettings {
  /** Seconds for a mid-depth photo to cross the screen. */
  crossSeconds: number;
  /** Roughly how many photos are on screen at once. */
  density: number;
  /** Long edge of a near photo, % of the screen's short side (far ones are smaller). */
  sizePct: number;
  direction: 'down' | 'up';
  depth: boolean;
  borders: boolean;
}

/** Depth layers, far → near. Scale also drives speed (parallax) and dimming. */
export const LAYERS = [
  { scale: 0.6, dim: 0.38 },
  { scale: 0.8, dim: 0.18 },
  { scale: 1, dim: 0 },
] as const;

interface Sprite {
  surface: Surface;
  w: number;
  h: number;
}

/** A full-screen graphic: the drift pauses while it fades in, holds, and fades out. */
interface Feature {
  kind: 'feature';
  img: LoadedPhoto;
  /** Seconds since it started. */
  t: number;
}

const FADE = 0.4;

interface Drifter {
  kind?: 'drifter';
  id: string;
  sprite: Sprite;
  layer: number;
  /** Centre x and top y, stage px. */
  x: number;
  y: number;
  /** px per second (positive = down). */
  speed: number;
}

export interface FloatingDeps {
  scheduler: Scheduler;
  createSurface: (w: number, h: number) => Surface;
}

/** Pick the x (centre) among candidates that is farthest from photos near the entry edge. */
export function chooseX(W: number, w: number, occupied: number[], random: () => number, candidates = 8): number {
  const min = w / 2;
  const max = Math.max(min, W - w / 2);
  let best = min + random() * (max - min);
  let bestDist = -1;
  for (let i = 0; i < candidates; i++) {
    const x = min + random() * (max - min);
    const d = occupied.length ? Math.min(...occupied.map((o) => Math.abs(o - x))) : Infinity;
    if (d > bestDist) {
      best = x;
      bestDist = d;
    }
  }
  return best;
}

/** Photo size (px) for a layer: long edge = base × layer scale, never above the original's resolution. */
export function drifterSize(
  photo: { width: number; height: number; maxScale?: number },
  base: number,
  layerScale: number,
): { w: number; h: number } {
  const long = base * layerScale;
  const ar = photo.width / photo.height;
  let w = ar >= 1 ? long : long * ar;
  let h = ar >= 1 ? long / ar : long;
  const cap = (photo.maxScale ?? Infinity) * photo.width;
  if (w > cap) {
    h *= cap / w;
    w = cap;
  }
  return { w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)) };
}

export class FloatingScene implements SceneInstance {
  private ctx: CanvasRenderingContext2D;
  private drifters: Drifter[] = [];
  private ready: Promise<Drifter | Feature | null>[] = [];
  private feature?: Feature;
  private timing: SceneTiming;
  private order: number[] = [];
  private orderPos = 0;
  /**
   * Photos on screen, waiting to enter, or loading. A photo is never picked
   * again while reserved, so the same photo can't appear twice at once.
   */
  private reserved = new Set<string>();
  private spawned = 0;
  private spawnAcc = 0;
  private paused = false;
  private destroyed = false;
  private frameId = 0;
  private last = 0;

  constructor(
    private c: SceneContext,
    private s: FloatingSettings,
    private deps: FloatingDeps = { scheduler: rafScheduler, createSurface },
  ) {
    this.ctx = ctx2d(c.canvas);
    this.timing = c.timing;
    const { width, height } = stageSize(c.viewport);
    sizeCanvas(c.canvas, width, height);
    const n = c.library.photos.length;
    // Collection order unless the global shuffle setting is on.
    this.order = c.shuffle ? shuffledOrder(n, c.random) : Array.from({ length: n }, (_, i) => i);
  }

  async start() {
    if (!this.c.library.photos.length) throw new Error('This collection has no photos yet.');
    const { height: H } = this.c.canvas;
    // Start with the screen already populated, spread over the full travel range.
    const made = await Promise.all(Array.from({ length: this.density }, () => this.makePhotoDrifter()));
    const ok = made.filter((d): d is Drifter => !!d);
    if (this.destroyed) return ok.forEach((d) => this.release(d));
    if (!ok.length) throw new Error('None of the photos in this collection could be decoded.');
    const { width: W } = this.c.canvas;
    ok.forEach((d, i) => {
      const span = H + d.sprite.h;
      const at = ((i + this.c.random() * 0.8) / ok.length) * span - d.sprite.h;
      d.y = this.s.direction === 'up' ? H - at - d.sprite.h : at;
      // Spread horizontally away from photos already placed at overlapping heights.
      const overlapping = this.drifters.filter((o) => o.y < d.y + d.sprite.h && d.y < o.y + o.sprite.h).map((o) => o.x);
      d.x = chooseX(W, d.sprite.w * 0.8, overlapping, this.c.random);
      this.drifters.push(d);
    });
    this.drifters.sort((a, b) => a.layer - b.layer);
    this.topUp();
    this.draw();
    this.loop();
  }

  pause() {
    this.paused = true;
  }

  resume() {
    this.paused = false;
    this.last = 0;
  }

  next() {
    // Skip a full-screen graphic that's showing; otherwise bring in another photo now.
    if (this.feature) this.feature.t = Math.max(this.feature.t, FADE + this.holdSeconds);
    else void this.spawn();
  }

  prev() {
    // A continuous drift has no "previous"; ignored.
  }

  resize(v: Viewport) {
    const { width: oldW } = this.c.canvas;
    this.c.viewport = v;
    const { width, height } = stageSize(v);
    sizeCanvas(this.c.canvas, width, height);
    for (const d of this.drifters) d.x = (d.x / oldW) * width;
    this.draw();
  }

  setRenderOptions(render: RenderOptions) {
    this.c.render = render;
  }

  setTiming(t: SceneTiming) {
    // Drift speed/density are Floating's own settings; the interval sets how long full-screen graphics show.
    this.timing = t;
  }

  destroy() {
    this.destroyed = true;
    this.deps.scheduler.cancel(this.frameId);
    this.drifters.forEach((d) => this.release(d));
    this.drifters = [];
    for (const p of this.ready) void p.then((d) => d && this.discard(d));
    this.ready = [];
    this.feature?.img.close();
    this.feature = undefined;
  }

  private get holdSeconds() {
    return Math.max(1, this.timing.intervalMs / 1000);
  }

  private discard(d: Drifter | Feature) {
    if (d.kind === 'feature') d.img.close();
    else this.release(d);
  }

  // --- internals ---

  private get base() {
    const { width: W, height: H } = this.c.canvas;
    return (this.s.sizePct / 100) * Math.min(W, H);
  }

  /**
   * Photos on screen at once. Capped below the library size (leaving room
   * for the two waiting to enter) so a photo never has to repeat on screen.
   */
  private get density() {
    const n = this.c.library.photos.length;
    return Math.max(1, Math.min(Math.round(this.s.density), n > 3 ? n - 3 : n));
  }

  /** Seconds between new photos, so about `density` are on screen. */
  private get spawnEvery() {
    return this.s.crossSeconds / this.density;
  }

  /**
   * Next photo in order that isn't reserved, or -1 if every photo is in use.
   * Tiny libraries (≤ 3 photos) may repeat rather than leave the screen empty.
   */
  private nextPhotoIndex(): number {
    const photos = this.c.library.photos;
    for (let tries = 0; tries < this.order.length; tries++) {
      const i = this.order[this.orderPos++ % this.order.length];
      if (!this.reserved.has(photos[i].id)) return i;
    }
    return photos.length <= 3 ? this.order[this.orderPos++ % this.order.length] : -1;
  }

  /** One step of the flow: a graphic if one is due (by share), otherwise a photo. */
  private async makeDrifter(): Promise<Drifter | Feature | null> {
    const g = this.c.graphics.next();
    if (!g) return this.makePhotoDrifter();
    const img = await this.c.graphics.load(g.id);
    if (!img || this.destroyed) {
      img?.close();
      return this.destroyed ? null : this.makePhotoDrifter();
    }
    if (g.fullScreen) return { kind: 'feature', img, t: 0 };
    // A card in the graphic's colour, sized like a photo; the graphic sits whole inside it.
    const layer = this.s.depth ? Math.floor(this.c.random() * LAYERS.length) : LAYERS.length - 1;
    const { scale, dim } = LAYERS[layer];
    const card = drifterSize({ width: g.width, height: g.height }, this.base, scale);
    const sprite = this.renderGraphicSprite(img, card.w, card.h, this.s.depth ? dim : 0);
    img.close();
    return { id: `graphic:${g.id}`, sprite, layer, x: 0, y: 0, speed: this.speedFor(scale) };
  }

  private speedFor(scale: number) {
    const { height: H } = this.c.canvas;
    const midSpeed = (H + this.base) / Math.max(1, this.s.crossSeconds);
    return midSpeed * (this.s.depth ? scale / LAYERS[1].scale : 1) * (this.s.direction === 'up' ? -1 : 1);
  }

  private async makePhotoDrifter(): Promise<Drifter | null> {
    const photos = this.c.library.photos;
    for (let attempt = 0; attempt < Math.min(5, photos.length); attempt++) {
      const index = this.nextPhotoIndex();
      if (index < 0) return null; // every photo is on screen or about to be; skip this spawn
      const info = photos[index];
      this.reserved.add(info.id);
      const layer = this.s.depth ? Math.floor(this.c.random() * LAYERS.length) : LAYERS.length - 1;
      const { scale, dim } = LAYERS[layer];
      const size = drifterSize(info, this.base, scale);
      const photo = await this.c.library.load(info.id, { width: size.w, height: size.h });
      if (this.destroyed) {
        photo?.close();
        this.reserved.delete(info.id);
        return null;
      }
      if (!photo) {
        this.reserved.delete(info.id);
        continue;
      }
      const fitted = drifterSize(photo, this.base, scale);
      const sprite = this.renderSprite(photo.source, fitted.w, fitted.h, this.s.depth ? dim : 0);
      photo.close();
      return { id: info.id, sprite, layer, x: 0, y: 0, speed: this.speedFor(scale) };
    }
    return null;
  }

  private renderSprite(src: CanvasImageSource, w: number, h: number, dim: number): Sprite {
    const border = this.s.borders ? Math.max(2, Math.round(Math.min(w, h) * 0.025)) : 0;
    const pad = Math.round(Math.min(w, h) * 0.06); // room for the shadow
    const sw = w + 2 * (border + pad);
    const sh = h + 2 * (border + pad);
    const surface = this.deps.createSurface(sw, sh);
    const g = surface.getContext('2d') as CanvasRenderingContext2D;
    g.save();
    g.shadowColor = 'rgba(0,0,0,0.65)';
    g.shadowBlur = pad * 0.8;
    g.shadowOffsetY = pad * 0.25;
    g.fillStyle = this.s.borders ? '#f4f4f2' : '#000';
    g.fillRect(pad, pad, w + 2 * border, h + 2 * border);
    g.restore();
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(src, pad + border, pad + border, w, h);
    if (dim > 0) {
      g.fillStyle = `rgba(0,0,0,${dim})`;
      g.fillRect(pad, pad, w + 2 * border, h + 2 * border);
    }
    return { surface, w: sw, h: sh };
  }

  private renderGraphicSprite(img: LoadedPhoto, w: number, h: number, dim: number): Sprite {
    const pad = Math.round(Math.min(w, h) * 0.06); // room for the shadow
    const surface = this.deps.createSurface(w + 2 * pad, h + 2 * pad);
    const g = surface.getContext('2d') as CanvasRenderingContext2D;
    g.save();
    g.shadowColor = 'rgba(0,0,0,0.65)';
    g.shadowBlur = pad * 0.8;
    g.shadowOffsetY = pad * 0.25;
    g.fillStyle = img.graphic!.background;
    g.fillRect(pad, pad, w, h);
    g.restore();
    drawGraphic(g, img, { x: pad, y: pad, w, h });
    if (dim > 0) {
      g.fillStyle = `rgba(0,0,0,${dim})`;
      g.fillRect(pad, pad, w, h);
    }
    return { surface, w: w + 2 * pad, h: h + 2 * pad };
  }

  private release(d: Drifter) {
    sizeCanvas(d.sprite.surface, 1, 1);
    this.reserved.delete(d.id);
  }

  /** Keep two photos decoded and ready so spawns are instant. */
  private topUp() {
    while (this.ready.length < 2 && !this.destroyed) this.ready.push(this.makeDrifter());
  }

  private async spawn() {
    const p = this.ready.shift();
    this.topUp();
    const d = p ? await p : null;
    if (!d || this.destroyed) return;
    if (d.kind === 'feature') {
      if (this.feature) d.img.close(); // one at a time
      else this.feature = d;
      this.spawned++;
      this.c.onStatus({ position: this.spawned });
      return;
    }
    const { width: W, height: H } = this.c.canvas;
    const up = this.s.direction === 'up';
    d.y = up ? H : -d.sprite.h;
    // Spread entries out: avoid photos still near the entry edge.
    const nearEntry = this.drifters.filter((o) => (up ? o.y > H - o.sprite.h * 1.5 : o.y < o.sprite.h * 0.5)).map((o) => o.x);
    d.x = chooseX(W, d.sprite.w * 0.8, nearEntry, this.c.random);
    // Insert keeping far → near draw order.
    const at = this.drifters.findIndex((o) => o.layer > d.layer);
    if (at < 0) this.drifters.push(d);
    else this.drifters.splice(at, 0, d);
    this.spawned++;
    this.c.onStatus({ position: this.spawned });
  }

  private loop = () => {
    if (this.destroyed) return;
    this.frameId = this.deps.scheduler.request((t) => {
      this.tick(t);
      this.loop();
    });
  };

  tick(now: number) {
    const dt = this.last ? Math.min(0.1, (now - this.last) / 1000) : 0;
    this.last = now;
    if (!this.paused && dt > 0 && this.feature) {
      // Full-screen graphic: the drift holds still while it shows.
      this.feature.t += dt;
      if (this.feature.t >= 2 * FADE + this.holdSeconds) {
        this.feature.img.close();
        this.feature = undefined;
      }
    } else if (!this.paused && dt > 0) {
      for (const d of this.drifters) d.y += d.speed * dt;
      const { height: H } = this.c.canvas;
      const gone = this.drifters.filter((d) => d.y > H || d.y + d.sprite.h < 0);
      if (gone.length) {
        gone.forEach((d) => this.release(d));
        this.drifters = this.drifters.filter((d) => !gone.includes(d));
      }
      this.spawnAcc += dt;
      while (this.spawnAcc >= this.spawnEvery) {
        this.spawnAcc -= this.spawnEvery;
        void this.spawn();
      }
    }
    this.draw();
  }

  private draw() {
    const { width: W, height: H } = this.c.canvas;
    const g = this.ctx;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.fillStyle = '#000';
    g.fillRect(0, 0, W, H);
    for (const d of this.drifters) g.drawImage(d.sprite.surface as CanvasImageSource, Math.round(d.x - d.sprite.w / 2), Math.round(d.y));
    const f = this.feature;
    if (f) {
      const hold = this.holdSeconds;
      g.globalAlpha = f.t < FADE ? f.t / FADE : f.t > FADE + hold ? Math.max(0, 1 - (f.t - FADE - hold) / FADE) : 1;
      drawGraphic(g, f.img, { x: 0, y: 0, w: W, h: H }, 0, 0, keepOutPixels(this.c.render.keepOut, W, H));
      g.globalAlpha = 1;
    }
  }

  /** Test hooks. */
  get count() {
    return this.drifters.length;
  }
  get ids() {
    return this.drifters.map((d) => d.id);
  }
  get showingFeature() {
    return !!this.feature;
  }
}

export const floating: SceneFormat<FloatingSettings> = {
  kind: 'scene',
  id: 'floating',
  name: 'Floating',
  description: 'Photos drift across the screen at different depths, nearer ones larger and faster.',
  uses: { interval: 'Full-screen graphics show for', transition: false, shuffle: true, fit: false, backdrop: false },
  settingsSchema: [
    {
      key: 'crossSeconds',
      label: 'Time to cross the screen',
      type: 'number',
      min: 8,
      max: 60,
      step: 1,
      unit: 's',
      default: 22,
    },
    { key: 'density', label: 'Photos on screen', type: 'number', min: 3, max: 20, step: 1, default: 10 },
    { key: 'sizePct', label: 'Photo size', type: 'number', min: 20, max: 90, step: 1, unit: '%', default: 50 },
    {
      key: 'direction',
      label: 'Direction',
      type: 'select',
      default: 'down',
      options: [
        { value: 'down', label: 'Downward' },
        { value: 'up', label: 'Upward' },
      ],
    },
    { key: 'depth', label: 'Depth (parallax)', type: 'boolean', default: true },
    { key: 'borders', label: 'White photo borders', type: 'boolean', default: true },
  ],
  create: (ctx, settings) => new FloatingScene(ctx, settings),
};
