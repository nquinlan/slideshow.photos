/**
 * Panel motion for the Sliding Panels transition.
 *
 * Out: every panel slides out of its own frame at once, so its visible part
 * collapses toward an edge. Neighbouring columns alternate (left column up,
 * next one down, …); a full-bleed photo splits into top and bottom halves that
 * slide into the horizontal centre line. In: the new layout slides in the
 * same way; a full-bleed photo opens outward from the vertical centre line,
 * with a thin black seam that closes as it finishes.
 *
 * Content slides *with* the moving edge (it isn't squashed), and each panel is
 * clipped to its own frame, so panels never overlap.
 */
import { fitRect } from '../shared';
import type { SlideImage } from '../types';
import type { Rect } from './layout';

export interface Motion {
  axis: 'x' | 'y';
  /** Edge the panel collapses toward / opens from: start = top/left, end = bottom/right, center = both halves meet in the middle. */
  anchor: 'start' | 'end' | 'center';
}

/** Group tiles into bands by their leading edge (left edges for columns, top edges for rows). */
function bandIndex(tiles: Rect[], key: 'x' | 'y'): number[] {
  const edges = [...new Set(tiles.map((t) => Math.round(t[key] / 4)))].sort((a, b) => a - b);
  return tiles.map((t) => edges.indexOf(Math.round(t[key] / 4)));
}

export function motionsFor(tiles: Rect[], phase: 'out' | 'in'): Motion[] {
  if (tiles.length === 1) return [phase === 'out' ? { axis: 'y', anchor: 'center' } : { axis: 'x', anchor: 'center' }];
  const columns = bandIndex(tiles, 'x');
  if (new Set(columns).size > 1) {
    return columns.map((c) => ({ axis: 'y', anchor: c % 2 === 0 ? 'start' : 'end' }));
  }
  // A single stack of rows (portrait screens): alternate rows left/right instead.
  return bandIndex(tiles, 'y').map((r) => ({ axis: 'x', anchor: r % 2 === 0 ? 'start' : 'end' }));
}

/**
 * Draw one panel. `visible` is 1 when fully in place and 0 when fully gone.
 * `seam` is the gap (px) between the two halves of a centre-anchored panel.
 */
export function drawPanel(
  ctx: CanvasRenderingContext2D,
  img: SlideImage | null,
  rect: Rect,
  motion: Motion,
  visible: number,
  seam = 0,
) {
  if (!img || visible <= 0) return;
  // Cover the tile, centre-cropped, but never upscale past the original.
  const d = fitRect(img.width, img.height, rect.w, rect.h, 'cover', img.maxScale);
  const dx = rect.x + d.x;
  const dy = rect.y + d.y;
  const hidden = 1 - Math.min(1, visible);
  const blit = (clip: Rect, ox: number, oy: number) => {
    if (clip.w <= 0 || clip.h <= 0) return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(clip.x, clip.y, clip.w, clip.h);
    ctx.clip();
    ctx.drawImage(img.source, dx + ox, dy + oy, d.w, d.h);
    ctx.restore();
  };

  if (motion.anchor !== 'center') {
    const size = motion.axis === 'x' ? rect.w : rect.h;
    const off = hidden * size * (motion.anchor === 'start' ? -1 : 1);
    return motion.axis === 'x' ? blit(rect, off, 0) : blit(rect, 0, off);
  }

  // Centre: two halves slide toward (out) / away from (in) the centre line.
  const g = Math.max(0, seam) / 2;
  if (motion.axis === 'y') {
    const half = rect.h / 2;
    const off = hidden * half;
    blit({ x: rect.x, y: rect.y, w: rect.w, h: half - g }, 0, off);
    blit({ x: rect.x, y: rect.y + half + g, w: rect.w, h: half - g }, 0, -off);
  } else {
    const half = rect.w / 2;
    const off = hidden * half;
    blit({ x: rect.x, y: rect.y, w: half - g, h: rect.h }, off, 0);
    blit({ x: rect.x + half + g, y: rect.y, w: half - g, h: rect.h }, -off, 0);
  }
}
