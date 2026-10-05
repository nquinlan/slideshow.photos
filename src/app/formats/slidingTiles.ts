/**
 * Sliding Tiles: the current image is cut into a grid; each tile slides out
 * of its cell while the matching tile of the next image slides in behind it,
 * in a staggered wave, until the next image is complete.
 *
 * Rendering choice: Canvas 2D. Both slides are composed once per transition
 * into stage-sized canvases (fit + backdrop), so each animation frame is just
 * `2 × tiles` GPU-backed canvas→canvas blits of sub-rectangles (≈96 for a
 * 6×4 grid, 384 at the 16×12 maximum). That holds 60fps at 1080p on
 * integrated GPUs, keeps memory at two stage-sized surfaces, and gives exact
 * per-pixel tile edges. CSS transforms would need 2×tiles composited layers
 * each referencing a full-size image (more GPU memory, layer-explosion risk on
 * large grids); WebGL/PixiJS would add ~100 KB+ for no visible gain here.
 *
 * Tiles are masked to their own cell (we blit only the visible part of each
 * tile rather than using clip(), which is slower), so neighbours never overlap.
 */
import {
  EASINGS,
  EASING_OPTIONS,
  animate,
  composeSlide,
  createSurface,
  ctx2d,
  sizeCanvas,
  stageSize,
  type EasingName,
  type Surface,
} from './shared';
import type { FormatContext, FormatInstance, FormatSettings, RenderOptions, SlideImage, TransitionFormat, Viewport } from './types';

export type Direction = 'left' | 'right' | 'up' | 'down';
export type DirectionSetting = Direction | 'alternate' | 'random';
export type Stagger = 'sweep' | 'diagonal' | 'center' | 'random' | 'none';

export interface SlidingTilesSettings extends FormatSettings {
  cols: number;
  rows: number;
  direction: DirectionSetting;
  stagger: Stagger;
  /** Fraction (0–0.85) of the transition spent staggering tile start times. */
  staggerAmount: number;
  easing: EasingName;
}

export interface Tile {
  /** Destination/source rect in stage pixels (integers; tiles exactly cover the stage). */
  x: number;
  y: number;
  w: number;
  h: number;
  dir: Direction;
  /** Normalised start delay 0..1 (scaled by staggerAmount). */
  order: number;
}

/** Deterministic PRNG so a given transition's random layout is stable across frames. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DIRS: Direction[] = ['left', 'right', 'up', 'down'];

/** Pure layout: exported for unit tests. */
export function layoutTiles(W: number, H: number, s: SlidingTilesSettings, seed = 1): Tile[] {
  const cols = Math.max(1, Math.round(s.cols));
  const rows = Math.max(1, Math.round(s.rows));
  const rand = mulberry32(seed);
  const baseDir: Direction = DIRS.includes(s.direction as Direction) ? (s.direction as Direction) : 'left';
  const tiles: Tile[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = Math.round((c * W) / cols);
      const y = Math.round((r * H) / rows);
      const x2 = Math.round(((c + 1) * W) / cols);
      const y2 = Math.round(((r + 1) * H) / rows);
      let dir = baseDir;
      if (s.direction === 'random') dir = DIRS[Math.floor(rand() * 4)];
      else if (s.direction === 'alternate') dir = r % 2 === 0 ? 'left' : 'right';
      tiles.push({ x, y, w: x2 - x, h: y2 - y, dir, order: tileOrder(s.stagger, c, r, cols, rows, dir, rand) });
    }
  }
  return tiles;
}

function tileOrder(stagger: Stagger, c: number, r: number, cols: number, rows: number, dir: Direction, rand: () => number) {
  const nc = cols > 1 ? c / (cols - 1) : 0;
  const nr = rows > 1 ? r / (rows - 1) : 0;
  switch (stagger) {
    case 'none':
      return 0;
    case 'random':
      return rand();
    case 'diagonal':
      return (nc + nr) / 2;
    case 'center': {
      const dx = nc - 0.5;
      const dy = nr - 0.5;
      return Math.min(1, Math.sqrt(dx * dx + dy * dy) / Math.SQRT1_2);
    }
    case 'sweep':
    default:
      // The wave travels the way the tiles move: tiles at the leading edge go first.
      if (dir === 'left') return nc;
      if (dir === 'right') return 1 - nc;
      if (dir === 'up') return nr;
      return 1 - nr;
  }
}

/** Local eased progress for a tile at global progress t. */
export function tileProgress(t: number, order: number, staggerAmount: number, ease: (x: number) => number) {
  const s = Math.min(0.85, Math.max(0, staggerAmount));
  const local = s >= 1 ? 1 : (t - order * s) / (1 - s);
  return Math.min(1, Math.max(0, ease(Math.min(1, Math.max(0, local)))));
}

/**
 * Draw one tile at progress p (0 = outgoing fully visible, 1 = incoming fully
 * visible). The outgoing tile moves toward `dir`; the incoming one follows it
 * in from the opposite edge. Only the parts inside the cell are blitted.
 */
export function drawTile(ctx: CanvasRenderingContext2D, from: CanvasImageSource, to: CanvasImageSource, t: Tile, p: number) {
  const { x, y, w, h } = t;
  if (p <= 0) return void ctx.drawImage(from, x, y, w, h, x, y, w, h);
  if (p >= 1) return void ctx.drawImage(to, x, y, w, h, x, y, w, h);
  const horizontal = t.dir === 'left' || t.dir === 'right';
  const size = horizontal ? w : h;
  const off = Math.round(p * size);
  const rest = size - off;
  if (horizontal) {
    if (t.dir === 'right') {
      // outgoing: left part of tile, shifted right by `off`
      if (rest > 0) ctx.drawImage(from, x, y, rest, h, x + off, y, rest, h);
      // incoming: right part of tile, entering at the left edge
      if (off > 0) ctx.drawImage(to, x + rest, y, off, h, x, y, off, h);
    } else {
      if (rest > 0) ctx.drawImage(from, x + off, y, rest, h, x, y, rest, h);
      if (off > 0) ctx.drawImage(to, x, y, off, h, x + rest, y, off, h);
    }
  } else if (t.dir === 'down') {
    if (rest > 0) ctx.drawImage(from, x, y, w, rest, x, y + off, w, rest);
    if (off > 0) ctx.drawImage(to, x, y + rest, w, off, x, y, w, off);
  } else {
    if (rest > 0) ctx.drawImage(from, x, y + off, w, rest, x, y, w, rest);
    if (off > 0) ctx.drawImage(to, x, y, w, off, x, y + rest, w, off);
  }
}

class SlidingTilesInstance implements FormatInstance {
  private ctx: CanvasRenderingContext2D;
  private current: Surface;
  private incoming: Surface;
  private currentImage?: SlideImage;
  private seed = 1;

  constructor(
    private c: FormatContext,
    private s: SlidingTilesSettings,
  ) {
    this.ctx = ctx2d(c.canvas);
    const { width, height } = stageSize(c.viewport);
    sizeCanvas(c.canvas, width, height);
    this.current = createSurface(width, height);
    this.incoming = createSurface(width, height);
  }

  init(first: SlideImage) {
    this.currentImage = first;
    composeSlide(this.current, first, this.c.render);
    this.blit(this.current);
  }

  async transition(next: SlideImage, durationMs: number, signal?: AbortSignal) {
    composeSlide(this.incoming, next, this.c.render);
    const { width: W, height: H } = this.c.canvas;
    const tiles = layoutTiles(W, H, this.s, this.seed++);
    const ease = EASINGS[this.s.easing] ?? EASINGS['ease-in-out-cubic'];
    const from = this.current as CanvasImageSource;
    const to = this.incoming as CanvasImageSource;
    const ctx = this.ctx;
    await animate(
      durationMs,
      (t) => {
        // Every tile covers its own cell exactly, so no clear is needed.
        for (const tile of tiles) drawTile(ctx, from, to, tile, tileProgress(t, tile.order, this.s.staggerAmount, ease));
      },
      signal,
    );
    // Swap surfaces: incoming becomes current.
    [this.current, this.incoming] = [this.incoming, this.current];
    this.currentImage = next;
  }

  resize(v: Viewport) {
    this.c.viewport = v;
    const { width, height } = stageSize(v);
    sizeCanvas(this.c.canvas, width, height);
    sizeCanvas(this.current, width, height);
    sizeCanvas(this.incoming, width, height);
    if (this.currentImage) this.init(this.currentImage);
  }

  setRenderOptions(render: RenderOptions) {
    this.c.render = render;
    if (this.currentImage) this.init(this.currentImage);
  }

  destroy() {
    for (const s of [this.current, this.incoming]) sizeCanvas(s, 1, 1);
    this.currentImage = undefined;
  }

  private blit(src: Surface) {
    this.ctx.drawImage(src as CanvasImageSource, 0, 0);
  }
}

export const slidingTiles: TransitionFormat<SlidingTilesSettings> = {
  kind: 'transition',
  id: 'sliding-tiles',
  name: 'Sliding Tiles',
  description: 'The photo splits into a grid of tiles that slide away to reveal the next one.',
  uses: { interval: 'Show each photo for', transition: true, shuffle: true, fit: true, backdrop: true },
  settingsSchema: [
    { key: 'cols', label: 'Columns', type: 'number', min: 1, max: 16, step: 1, default: 6 },
    { key: 'rows', label: 'Rows', type: 'number', min: 1, max: 12, step: 1, default: 4 },
    {
      key: 'direction',
      label: 'Direction',
      type: 'select',
      default: 'left',
      options: [
        { value: 'left', label: 'Left' },
        { value: 'right', label: 'Right' },
        { value: 'up', label: 'Up' },
        { value: 'down', label: 'Down' },
        { value: 'alternate', label: 'Alternating rows' },
        { value: 'random', label: 'Random per tile' },
      ],
    },
    {
      key: 'stagger',
      label: 'Wave pattern',
      type: 'select',
      default: 'sweep',
      options: [
        { value: 'sweep', label: 'Sweep' },
        { value: 'diagonal', label: 'Diagonal' },
        { value: 'center', label: 'From centre' },
        { value: 'random', label: 'Random' },
        { value: 'none', label: 'All at once' },
      ],
    },
    {
      key: 'staggerAmount',
      label: 'Wave spread',
      type: 'number',
      min: 0,
      max: 0.85,
      step: 0.05,
      default: 0.5,
      help: 'How much tile start times are spread across the transition.',
    },
    { key: 'easing', label: 'Easing', type: 'select', default: 'ease-in-out-cubic', options: EASING_OPTIONS },
  ],
  create: (ctx, settings) => new SlidingTilesInstance(ctx, settings),
};
