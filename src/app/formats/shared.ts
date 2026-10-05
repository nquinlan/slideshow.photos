/**
 * Helpers shared by formats: slide composition (fit + backdrop), canvas
 * sizing, easing, and a rAF animation driver.
 */
import type { RenderOptions, SlideImage, Viewport } from './types';

/** Max backing-store size for the stage canvas; beyond 4K the GPU cost isn't visible. */
const MAX_STAGE_PIXELS = 3840 * 2160;

export function stageSize(v: Viewport): { width: number; height: number } {
  let w = Math.max(1, Math.round(v.width * v.devicePixelRatio));
  let h = Math.max(1, Math.round(v.height * v.devicePixelRatio));
  const over = (w * h) / MAX_STAGE_PIXELS;
  if (over > 1) {
    const k = 1 / Math.sqrt(over);
    w = Math.round(w * k);
    h = Math.round(h * k);
  }
  return { width: w, height: h };
}

export function sizeCanvas(c: HTMLCanvasElement | OffscreenCanvas, w: number, h: number) {
  if (c.width !== w) c.width = w;
  if (c.height !== h) c.height = h;
}

export type Surface = HTMLCanvasElement | OffscreenCanvas;

export function createSurface(w: number, h: number): Surface {
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }
  return new OffscreenCanvas(w, h);
}

export function ctx2d(c: Surface): CanvasRenderingContext2D {
  const ctx = c.getContext('2d', { alpha: false }) as CanvasRenderingContext2D | null;
  if (!ctx) throw new Error('Canvas 2D unavailable');
  return ctx;
}

/**
 * Fit an iw×ih image into w×h (contain or cover), centred. `maxScale` caps the
 * scale so small photos are never blown up beyond their original resolution;
 * they're shown centred at that size instead.
 */
export function fitRect(iw: number, ih: number, w: number, h: number, mode: 'contain' | 'cover', maxScale = Infinity) {
  const k = Math.min(maxScale, mode === 'cover' ? Math.max(w / iw, h / ih) : Math.min(w / iw, h / ih));
  const dw = iw * k;
  const dh = ih * k;
  return { x: (w - dw) / 2, y: (h - dh) / 2, w: dw, h: dh };
}

let tinyCanvas: Surface | undefined;

/**
 * Render `img` into `target` (sized to the stage) with the requested fit and
 * backdrop. Done once per slide, so per-frame transition work is only cheap
 * canvas-to-canvas blits.
 */
export function composeSlide(target: Surface, img: SlideImage, render: RenderOptions) {
  const ctx = ctx2d(target);
  const { width: W, height: H } = target;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  const r = fitRect(img.width, img.height, W, H, render.fit, img.maxScale);
  const fillsStage = r.x <= 0.5 && r.y <= 0.5 && r.x + r.w >= W - 0.5 && r.y + r.h >= H - 0.5;
  if (render.backdrop === 'blur' && !fillsStage) drawBlurBackdrop(ctx, img, W, H);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img.source, r.x, r.y, r.w, r.h);
}

/**
 * Cheap, cross-browser blur: downscale a cover-fit copy to ~48px wide and
 * stretch it back up with smoothing (plus ctx.filter blur where supported),
 * then darken so the foreground photo stands out.
 */
function drawBlurBackdrop(ctx: CanvasRenderingContext2D, img: SlideImage, W: number, H: number) {
  const tw = 48;
  const th = Math.max(1, Math.round((tw * H) / W));
  tinyCanvas ??= createSurface(tw, th);
  sizeCanvas(tinyCanvas, tw, th);
  const t = tinyCanvas.getContext('2d') as CanvasRenderingContext2D;
  const r = fitRect(img.width, img.height, tw, th, 'cover');
  t.imageSmoothingEnabled = true;
  t.imageSmoothingQuality = 'medium';
  t.drawImage(img.source, r.x, r.y, r.w, r.h);
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  if ('filter' in ctx) ctx.filter = `blur(${Math.round(Math.min(W, H) / 60)}px)`;
  // Overdraw slightly so the blur doesn't vignette at the edges.
  const pad = Math.min(W, H) * 0.08;
  ctx.drawImage(tinyCanvas as CanvasImageSource, -pad, -pad, W + pad * 2, H + pad * 2);
  ctx.restore();
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fillRect(0, 0, W, H);
}

/** Fisher–Yates permutation of 0..n-1. */
export function shuffledOrder(n: number, random: () => number = Math.random): number[] {
  const a = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export const EASINGS = {
  linear: (t: number) => t,
  'ease-in-out-sine': (t: number) => -(Math.cos(Math.PI * t) - 1) / 2,
  'ease-in-out-cubic': (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  'ease-out-quart': (t: number) => 1 - Math.pow(1 - t, 4),
  'ease-in-out-expo': (t: number) =>
    t === 0 ? 0 : t === 1 ? 1 : t < 0.5 ? Math.pow(2, 20 * t - 10) / 2 : (2 - Math.pow(2, -20 * t + 10)) / 2,
} as const;

export type EasingName = keyof typeof EASINGS;

export const EASING_OPTIONS: { value: EasingName; label: string }[] = [
  { value: 'ease-in-out-cubic', label: 'Smooth (cubic)' },
  { value: 'ease-in-out-sine', label: 'Gentle (sine)' },
  { value: 'ease-out-quart', label: 'Decelerate (quart)' },
  { value: 'ease-in-out-expo', label: 'Snappy (expo)' },
  { value: 'linear', label: 'Linear' },
];

export interface Scheduler {
  now(): number;
  request(cb: (t: number) => void): number;
  cancel(id: number): void;
}

export const rafScheduler: Scheduler = {
  now: () => performance.now(),
  request: (cb) => requestAnimationFrame(cb),
  cancel: (id) => cancelAnimationFrame(id),
};

/**
 * Drive `frame(progress)` from 0→1 over `durationMs` on animation frames.
 * On abort, renders progress=1 immediately and resolves.
 */
export function animate(
  durationMs: number,
  frame: (t: number) => void,
  signal?: AbortSignal,
  scheduler: Scheduler = rafScheduler,
): Promise<void> {
  return new Promise((resolve) => {
    if (durationMs <= 0 || signal?.aborted) {
      frame(1);
      return resolve();
    }
    const start = scheduler.now();
    let id = 0;
    const finish = () => {
      scheduler.cancel(id);
      signal?.removeEventListener('abort', finish);
      frame(1);
      resolve();
    };
    signal?.addEventListener('abort', finish, { once: true });
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      if (t >= 1) return finish();
      frame(t);
      id = scheduler.request(tick);
    };
    frame(0);
    id = scheduler.request(tick);
  });
}
