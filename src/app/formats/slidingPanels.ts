/**
 * Sliding Panels: a black-background collage that cycles forever.
 *
 * Each cycle picks a random layout (panels/layout.ts), fills it with photos
 * matched to tile shape (panels/match.ts), holds completely still for the
 * interval, then panels slide out to black, a short black beat, and the next
 * layout slides in (panels/motion.ts).
 *
 * Timing (fractions of the transition duration, observed ≈ 0.9 s total):
 * out ≈ 0.42, black beat ≈ 0.11, in ≈ 0.47. All animation is time-based, so
 * it looks the same at 60 Hz and 120 Hz.
 *
 * Memory: each photo is decoded no larger than its tile (PhotoLibrary box),
 * and at most three layouts are held: the one on screen, the preloaded next
 * one, and briefly the outgoing one.
 */
import { animate, clearOf, ctx2d, fitRect, keepOutPixels, rafScheduler, sizeCanvas, stageSize, type Scheduler } from './shared';
import { generateLayout, maxTilesFor, type Rect } from './panels/layout';
import { assignPhotos } from './panels/match';
import { drawPanel, motionsFor, type Motion } from './panels/motion';
import type {
  Box,
  FormatSettings,
  LoadedPhoto,
  RenderOptions,
  SceneContext,
  SceneFormat,
  SceneInstance,
  SceneTiming,
  Viewport,
} from './types';

export interface SlidingPanelsSettings extends FormatSettings {
  maxTiles: number;
  /** Gap between photos, % of screen width. */
  gutterPct: number;
  fullScreen: 'never' | 'sometimes' | 'often';
}

const FULL_BLEED_CHANCE = { never: 0, sometimes: 0.15, often: 0.35 } as const;
const PHASES = { out: 0.42, beat: 0.11, in: 0.47 };
const easeIn = (t: number) => t * t;
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);

/** What fills a tile: a photo, or a logo/sponsor graphic (shown whole on its colour). */
interface PlanItem {
  kind: 'photo' | 'graphic';
  id: string;
}

/** A planned layout: tiles normalised to 0..1 so it survives resizes. */
interface Plan {
  tiles: Rect[];
  items: PlanItem[];
}

/**
 * The tile where a graphic shows largest when contained (graphics are never
 * cropped), after making room for the corner logo (`keepOut`, px).
 */
export function bestTileForGraphic(tiles: Rect[], g: { width: number; height: number }, keepOut?: Box): number {
  let best = 0;
  let bestScale = -1;
  tiles.forEach((t, i) => {
    const r = fitRect(g.width, g.height, t.w, t.h, 'contain');
    const scale = clearOf({ x: t.x + r.x, y: t.y + r.y, w: r.w, h: r.h }, t, keepOut).w / g.width;
    if (scale > bestScale) {
      best = i;
      bestScale = scale;
    }
  });
  return best;
}

interface Frame {
  plan: Plan;
  photos: (LoadedPhoto | null)[];
  out: Motion[];
  in: Motion[];
}

export interface PanelsDeps {
  scheduler: Scheduler;
  setTimeout: (cb: () => void, ms: number) => unknown;
  clearTimeout: (h: unknown) => void;
  now: () => number;
}

const defaultDeps: PanelsDeps = {
  scheduler: rafScheduler,
  setTimeout: (cb, ms) => setTimeout(cb, ms),
  clearTimeout: (h) => clearTimeout(h as number),
  now: () => performance.now(),
};

const HISTORY = 30;

export class SlidingPanelsScene implements SceneInstance {
  private ctx: CanvasRenderingContext2D;
  private timing: SceneTiming;
  private current?: Frame;
  private prefetch?: Promise<Frame | null>;
  private history: Plan[] = [];
  /** Absolute index of history[0] (history is capped). */
  private historyBase = 0;
  private historyPos = -1;
  private paused = false;
  private destroyed = false;
  private transitioning = false;
  private pendingNav = 0;
  private holdResolve?: (dir: number) => void;
  private holdTimer: unknown;
  private holdStarted = 0;
  private holdRemaining = 0;
  private abort = new AbortController();

  constructor(
    private c: SceneContext,
    private s: SlidingPanelsSettings,
    private deps: PanelsDeps = defaultDeps,
  ) {
    this.ctx = ctx2d(c.canvas);
    this.timing = c.timing;
    const { width, height } = stageSize(c.viewport);
    sizeCanvas(c.canvas, width, height);
  }

  async start() {
    if (!this.c.library.photos.length) throw new Error('This collection has no photos yet.');
    const first = await this.loadFrame(this.plan());
    if (this.destroyed) {
      if (first) this.closeFrame(first);
      return;
    }
    if (!first || first.photos.every((p) => !p)) {
      if (first) this.closeFrame(first);
      throw new Error('None of the photos in this collection could be decoded.');
    }
    this.pushHistory(first.plan);
    this.blank();
    void this.run(first);
  }

  pause() {
    this.paused = true;
    if (this.holdTimer !== undefined) {
      this.deps.clearTimeout(this.holdTimer);
      this.holdTimer = undefined;
      this.holdRemaining -= this.deps.now() - this.holdStarted;
    }
  }

  resume() {
    this.paused = false;
    if (this.holdResolve && this.holdTimer === undefined) this.armHold();
  }

  next() {
    this.navigate(1);
  }

  prev() {
    if (this.historyPos > 0 || this.history.length === 0) this.navigate(-1);
  }

  resize(v: Viewport) {
    this.c.viewport = v;
    const { width, height } = stageSize(v);
    sizeCanvas(this.c.canvas, width, height);
    if (!this.transitioning && this.current) this.drawFrame(this.current, 'in', 1);
  }

  setRenderOptions(render: RenderOptions) {
    // Panels always crop to fill on black; only the corner logo's area matters (graphics avoid it).
    this.c.render = render;
    if (!this.transitioning && this.current) this.drawFrame(this.current, 'in', 1);
  }

  setTiming(t: SceneTiming) {
    this.timing = t;
    // Restart an in-progress hold with the new interval.
    if (this.holdResolve && !this.paused) {
      if (this.holdTimer !== undefined) this.deps.clearTimeout(this.holdTimer);
      this.holdTimer = undefined;
      this.holdRemaining = t.intervalMs;
      this.armHold();
    }
  }

  destroy() {
    this.destroyed = true;
    this.abort.abort();
    this.finishHold(0);
    if (this.current) this.closeFrame(this.current);
    this.current = undefined;
    void this.prefetch?.then((f) => f && this.closeFrame(f));
    this.prefetch = undefined;
  }

  // --- cycle ---

  private async run(first: Frame) {
    await this.transitionIn(first);
    this.current = first;
    this.c.onStatus({ position: this.historyBase + this.historyPos });
    let failures = 0;
    while (!this.destroyed) {
      // Preload the next new layout while this one holds.
      this.prefetch ??= this.loadFrame(this.plan());
      const dir = await this.hold();
      if (this.destroyed || dir === 0) break;

      let next: Frame | null;
      if (dir < 0 && this.historyPos > 0) {
        next = await this.loadFrame(this.history[this.historyPos - 1]);
        if (next) this.historyPos--;
      } else if (this.historyPos < this.history.length - 1) {
        // Moving forward again after going back: replay history first.
        next = await this.loadFrame(this.history[this.historyPos + 1]);
        if (next) this.historyPos++;
      } else {
        next = await this.prefetch;
        this.prefetch = undefined;
        if (next) this.pushHistory(next.plan);
      }
      if (this.destroyed) {
        if (next) this.closeFrame(next);
        break;
      }
      if (!next || next.photos.every((p) => !p)) {
        if (next) this.closeFrame(next);
        if (++failures > 5) break; // nothing decodable: keep the current layout on screen
        continue;
      }
      failures = 0;

      const outgoing = this.current;
      await this.transition(outgoing, next);
      if (outgoing) this.closeFrame(outgoing);
      this.current = next;
      this.c.onStatus({ position: this.historyBase + this.historyPos });
    }
  }

  private plan(): Plan {
    const { width: W, height: H } = this.c.canvas;
    const photos = this.c.library.photos;
    const v = this.c.viewport;
    const gutter = Math.round((this.s.gutterPct / 100) * W);
    const margin = Math.max(1, Math.round(W * 0.0007));
    const norm = (t: Rect) => ({ x: t.x / W, y: t.y / H, w: t.w / W, h: t.h / H });
    // One step per layout: a graphic's share is the % of layouts that include it.
    const graphic = this.c.graphics.next();
    if (graphic?.fullScreen || (graphic && !photos.length)) {
      return { tiles: [norm({ x: margin, y: margin, w: W - 2 * margin, h: H - 2 * margin })], items: [{ kind: 'graphic', id: graphic.id }] };
    }
    const tiles = generateLayout({
      width: W,
      height: H,
      maxTiles: Math.min(maxTilesFor(Math.min(v.width, v.height), this.s.maxTiles), photos.length + (graphic ? 1 : 0)),
      gutter,
      margin,
      // A mixed-in graphic sits among photos, so don't pick a single full-bleed layout for it.
      fullBleedChance: graphic ? 0 : (FULL_BLEED_CHANCE[this.s.fullScreen] ?? 0.15),
      random: this.c.random,
    });
    const graphicTile = graphic ? bestTileForGraphic(tiles, graphic, keepOutPixels(this.c.render.keepOut, W, H)) : -1;
    const photoTiles = tiles.filter((_, i) => i !== graphicTile);
    // Avoid photos from the current and previous layout when the library allows.
    const avoid = new Set<string>();
    for (const p of this.history.slice(-2)) for (const it of p.items) if (it.kind === 'photo') avoid.add(it.id);
    const ids = photoTiles.length ? assignPhotos(photoTiles, photos, { random: this.c.random, avoid }) : [];
    let next = 0;
    const items: PlanItem[] = tiles.map((_, i) => (i === graphicTile ? { kind: 'graphic', id: graphic!.id } : { kind: 'photo', id: ids[next++] }));
    return { tiles: tiles.map(norm), items };
  }

  private pixelTiles(plan: Plan): Rect[] {
    const { width: W, height: H } = this.c.canvas;
    return plan.tiles.map((t) => ({ x: t.x * W, y: t.y * H, w: t.w * W, h: t.h * H }));
  }

  private async loadFrame(plan: Plan): Promise<Frame | null> {
    const tiles = this.pixelTiles(plan);
    const photos = await Promise.all(
      plan.items.map((it, i) =>
        it.kind === 'graphic'
          ? this.c.graphics.load(it.id)
          : this.c.library.load(it.id, { width: Math.ceil(tiles[i].w), height: Math.ceil(tiles[i].h) }),
      ),
    );
    if (this.destroyed) {
      photos.forEach((p) => p?.close());
      return null;
    }
    return { plan, photos, out: motionsFor(tiles, 'out'), in: motionsFor(tiles, 'in') };
  }

  private closeFrame(f: Frame) {
    for (const p of f.photos) p?.close();
  }

  private pushHistory(plan: Plan) {
    this.history.push(plan);
    if (this.history.length > HISTORY) {
      this.history.shift();
      this.historyBase++;
    }
    this.historyPos = this.history.length - 1;
  }

  // --- hold (pausable, interruptible by next/prev) ---

  private hold(): Promise<number> {
    if (this.pendingNav) {
      const d = this.pendingNav;
      this.pendingNav = 0;
      return Promise.resolve(d);
    }
    return new Promise((resolve) => {
      this.holdResolve = resolve;
      this.holdRemaining = this.timing.intervalMs;
      if (!this.paused) this.armHold();
    });
  }

  private armHold() {
    this.holdStarted = this.deps.now();
    this.holdTimer = this.deps.setTimeout(() => {
      this.holdTimer = undefined;
      this.finishHold(1);
    }, Math.max(0, this.holdRemaining));
  }

  private finishHold(dir: number) {
    if (this.holdTimer !== undefined) this.deps.clearTimeout(this.holdTimer);
    this.holdTimer = undefined;
    const r = this.holdResolve;
    this.holdResolve = undefined;
    r?.(dir);
  }

  private navigate(dir: number) {
    if (this.holdResolve) this.finishHold(dir);
    else this.pendingNav = dir; // mid-transition: run right after it
  }

  // --- drawing ---

  private blank() {
    const { width, height } = this.c.canvas;
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.globalAlpha = 1;
    this.ctx.fillStyle = '#000';
    this.ctx.fillRect(0, 0, width, height);
  }

  private drawFrame(f: Frame, phase: 'in' | 'out', visible: number) {
    this.blank();
    const tiles = this.pixelTiles(f.plan);
    const motions = phase === 'out' ? f.out : f.in;
    const seam = Math.max(2, Math.round((this.s.gutterPct / 100) * this.c.canvas.width)) * (1 - visible);
    const { width: W, height: H } = this.c.canvas;
    const keepOut = keepOutPixels(this.c.render.keepOut, W, H);
    tiles.forEach((t, i) => drawPanel(this.ctx, f.photos[i], t, motions[i], visible, seam, keepOut));
  }

  private async transitionIn(f: Frame) {
    this.transitioning = true;
    await animate(this.timing.transitionMs * PHASES.in, (t) => this.drawFrame(f, 'in', easeOut(t)), this.abort.signal, this.deps.scheduler);
    this.transitioning = false;
  }

  private async transition(from: Frame | undefined, to: Frame) {
    this.transitioning = true;
    const T = this.timing.transitionMs;
    if (from) {
      await animate(T * PHASES.out, (t) => this.drawFrame(from, 'out', 1 - easeIn(t)), this.abort.signal, this.deps.scheduler);
    }
    // Black beat (time-based, via the same scheduler).
    await animate(T * PHASES.beat, () => this.blank(), this.abort.signal, this.deps.scheduler);
    await animate(T * PHASES.in, (t) => this.drawFrame(to, 'in', easeOut(t)), this.abort.signal, this.deps.scheduler);
    this.transitioning = false;
  }
}

export const slidingPanels: SceneFormat<SlidingPanelsSettings> = {
  kind: 'scene',
  id: 'sliding-panels',
  name: 'Sliding Panels',
  description:
    'A collage of photos matched to each panel’s shape. It holds still, then the panels slide away to black and a new layout slides in.',
  uses: { interval: 'Show each layout for', transition: true, shuffle: false, fit: false, backdrop: false },
  settingsSchema: [
    {
      key: 'maxTiles',
      label: 'Most photos per layout',
      type: 'number',
      min: 1,
      max: 6,
      step: 1,
      default: 6,
      help: 'Small screens use fewer automatically.',
    },
    { key: 'gutterPct', label: 'Gap between photos', type: 'number', min: 0, max: 2, step: 0.1, unit: '%', default: 0.6 },
    {
      key: 'fullScreen',
      label: 'Single full-screen photos',
      type: 'select',
      default: 'sometimes',
      options: [
        { value: 'never', label: 'Never' },
        { value: 'sometimes', label: 'Sometimes' },
        { value: 'often', label: 'Often' },
      ],
    },
  ],
  create: (ctx, settings) => new SlidingPanelsScene(ctx, settings),
};
