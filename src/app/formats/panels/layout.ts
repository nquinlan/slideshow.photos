/**
 * Sliding Panels layouts: random recursive splits of the screen.
 *
 * A region is cut into halves, thirds, or two-thirds/one-third, vertically or
 * horizontally; each part either becomes a tile or is split again. That
 * yields the observed families (three columns with stacked outer columns, a
 * tall half next to a mixed column, a big two-thirds tile beside a stack, a
 * full-bleed single photo) plus variations. The cut axis follows the
 * region's shape so tiles don't skew to extreme ratios on ultrawide or
 * portrait screens, and tile count scales with screen size.
 *
 * Everything is in device pixels of the stage; gutters are a fraction of the
 * stage width.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LayoutOptions {
  width: number;
  height: number;
  maxTiles: number;
  /** Gap between tiles, px. */
  gutter: number;
  /** Gap at the screen edges, px. */
  margin: number;
  /** Probability of a single full-bleed photo. */
  fullBleedChance: number;
  random: () => number;
}

/** Tiles more elongated than this get mismatched photos and heavy crops. */
export const MAX_TILE_ASPECT = 2.4;
/** Smallest tile short side, as a fraction of the screen's short side. */
export const MIN_TILE_FRACTION = 0.18;

/** Fewer, larger tiles on small screens (CSS px of the screen's short side). */
export function maxTilesFor(cssShortSide: number, setting: number): number {
  const cap = cssShortSide < 500 ? 3 : cssShortSide < 900 ? 5 : 6;
  return Math.max(1, Math.min(Math.round(setting), cap));
}

type Kind = 'halves' | 'thirds' | 'twoThirds';

function pick<T>(items: readonly T[], weights: readonly number[], random: () => number): T {
  const total = weights.reduce((a, b) => a + b, 0);
  let r = random() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i];
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}

function split(rect: Rect, budget: number, o: LayoutOptions): Rect[] {
  if (budget <= 1) return [rect];
  const ar = rect.w / rect.h;
  // Cut wide regions into columns and tall regions into rows (mostly).
  const pColumns = ar > 1.3 ? 0.85 : ar < 1 / 1.3 ? 0.15 : 0.5;
  const columns = o.random() < pColumns;
  const kinds: Kind[] = budget >= 3 ? ['halves', 'thirds', 'twoThirds'] : ['halves', 'twoThirds'];
  const kind = pick(kinds, budget >= 3 ? [0.4, 0.3, 0.3] : [0.55, 0.45], o.random);
  const fractions =
    kind === 'halves' ? [0.5, 0.5] : kind === 'thirds' ? [1 / 3, 1 / 3, 1 / 3] : o.random() < 0.5 ? [2 / 3, 1 / 3] : [1 / 3, 2 / 3];

  const length = columns ? rect.w : rect.h;
  const usable = length - o.gutter * (fractions.length - 1);
  const parts: Rect[] = [];
  let at = columns ? rect.x : rect.y;
  fractions.forEach((f, i) => {
    // Last part takes the remainder so rounding never leaves a sliver.
    const size = i === fractions.length - 1 ? (columns ? rect.x + rect.w : rect.y + rect.h) - at : Math.round(usable * f);
    parts.push(columns ? { x: at, y: rect.y, w: size, h: rect.h } : { x: rect.x, y: at, w: rect.w, h: size });
    at += size + o.gutter;
  });

  // Every part gets one tile; extra tiles go to parts in proportion to their size.
  const budgets = parts.map(() => 1);
  for (let extra = budget - parts.length; extra > 0; extra--) {
    budgets[pick(parts.map((_, i) => i), fractions, o.random)]++;
  }
  return parts.flatMap((p, i) => split(p, budgets[i], o));
}

export function isValidLayout(tiles: Rect[], o: Pick<LayoutOptions, 'width' | 'height'>): boolean {
  const minSide = MIN_TILE_FRACTION * Math.min(o.width, o.height);
  return tiles.every((t) => {
    const ar = t.w / t.h;
    return t.w > 0 && t.h > 0 && ar <= MAX_TILE_ASPECT && ar >= 1 / MAX_TILE_ASPECT && Math.min(t.w, t.h) >= minSide;
  });
}

export function generateLayout(o: LayoutOptions): Rect[] {
  const root: Rect = { x: o.margin, y: o.margin, w: o.width - 2 * o.margin, h: o.height - 2 * o.margin };
  const maxTiles = Math.max(1, Math.floor(o.maxTiles));
  if (maxTiles === 1 || o.random() < o.fullBleedChance) return [root];
  for (let attempt = 0; attempt < 40; attempt++) {
    // Favour busier layouts but allow simpler ones.
    const minTiles = Math.min(3, maxTiles);
    const count = minTiles + Math.floor(o.random() * (maxTiles - minTiles + 1));
    const tiles = split(root, count, o);
    if (isValidLayout(tiles, o)) return tiles;
  }
  // Fallback: halves along the long axis (valid on most screens), else full bleed.
  const halves: Rect[] =
    root.w >= root.h
      ? [
          { x: root.x, y: root.y, w: Math.round((root.w - o.gutter) / 2), h: root.h },
          { x: root.x + Math.round((root.w - o.gutter) / 2) + o.gutter, y: root.y, w: root.w - Math.round((root.w - o.gutter) / 2) - o.gutter, h: root.h },
        ]
      : [
          { x: root.x, y: root.y, w: root.w, h: Math.round((root.h - o.gutter) / 2) },
          { x: root.x, y: root.y + Math.round((root.h - o.gutter) / 2) + o.gutter, w: root.w, h: root.h - Math.round((root.h - o.gutter) / 2) - o.gutter },
        ];
  return isValidLayout(halves, o) ? halves : [root];
}
