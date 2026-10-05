import { describe, expect, it } from 'vitest';
import { FORMATS, effectiveFormat, getFormat } from '../../src/app/formats';
import { EASINGS, animate, fitRect, stageSize, type Scheduler } from '../../src/app/formats/shared';
import { drawTile, layoutTiles, slidingTiles, tileProgress, type SlidingTilesSettings } from '../../src/app/formats/slidingTiles';
import { defaultSettings, resolveSettings } from '../../src/app/formats/types';

const base: SlidingTilesSettings = {
  ...(defaultSettings(slidingTiles.settingsSchema) as SlidingTilesSettings),
};

describe('SlideshowFormat registry & interface contract', () => {
  it('every format has a unique id, a name and a valid settings schema', () => {
    const ids = new Set<string>();
    for (const f of FORMATS) {
      expect(f.id).toMatch(/^[a-z0-9-]+$/);
      expect(ids.has(f.id)).toBe(false);
      ids.add(f.id);
      expect(f.name.length).toBeGreaterThan(0);
      expect(typeof f.create).toBe('function');
      for (const field of f.settingsSchema) {
        if (field.type === 'number') {
          expect(field.default).toBeGreaterThanOrEqual(field.min);
          expect(field.default).toBeLessThanOrEqual(field.max);
        }
        if (field.type === 'select') expect(field.options.map((o) => o.value)).toContain(field.default);
      }
    }
  });

  it('falls back to crossfade when reduced motion is requested', () => {
    expect(effectiveFormat('sliding-tiles', false).id).toBe('sliding-tiles');
    expect(effectiveFormat('sliding-tiles', true).id).toBe('crossfade');
    expect(getFormat('does-not-exist').id).toBe(FORMATS[0].id);
  });

  it('resolveSettings clamps numbers, rejects unknown options and drops unknown keys', () => {
    const r = resolveSettings(slidingTiles.settingsSchema, { cols: 99, direction: 'sideways', easing: 'linear', bogus: 1 });
    expect(r.cols).toBe(16);
    expect(r.direction).toBe(base.direction);
    expect(r.easing).toBe('linear');
    expect('bogus' in r).toBe(false);
  });
});

describe('Sliding Tiles layout', () => {
  it('tiles exactly cover the stage with integer, non-overlapping rects', () => {
    for (const [cols, rows, W, H] of [[6, 4, 1920, 1080], [7, 5, 1366, 768], [16, 12, 3840, 2160], [1, 1, 10, 10]]) {
      const tiles = layoutTiles(W, H, { ...base, cols, rows });
      expect(tiles).toHaveLength(cols * rows);
      const area = tiles.reduce((a, t) => a + t.w * t.h, 0);
      expect(area).toBe(W * H);
      for (const t of tiles) {
        expect(Number.isInteger(t.x) && Number.isInteger(t.w)).toBe(true);
        expect(t.x + t.w).toBeLessThanOrEqual(W);
        expect(t.y + t.h).toBeLessThanOrEqual(H);
      }
    }
  });

  it('sweep stagger starts at the leading edge of the movement', () => {
    const left = layoutTiles(600, 400, { ...base, cols: 3, rows: 1, direction: 'left', stagger: 'sweep' });
    expect(left.map((t) => t.order)).toEqual([0, 0.5, 1]);
    const right = layoutTiles(600, 400, { ...base, cols: 3, rows: 1, direction: 'right', stagger: 'sweep' });
    expect(right.map((t) => t.order)).toEqual([1, 0.5, 0]);
  });

  it('random layouts are deterministic per seed', () => {
    const s = { ...base, direction: 'random' as const, stagger: 'random' as const };
    expect(layoutTiles(800, 600, s, 7)).toEqual(layoutTiles(800, 600, s, 7));
    expect(layoutTiles(800, 600, s, 7)).not.toEqual(layoutTiles(800, 600, s, 8));
  });

  it('every tile reaches progress 1 by the end, 0 at the start', () => {
    for (const order of [0, 0.3, 1]) {
      expect(tileProgress(0, order, 0.5, EASINGS.linear)).toBe(0);
      expect(tileProgress(1, order, 0.5, EASINGS.linear)).toBe(1);
    }
    expect(tileProgress(0.5, 1, 0.5, EASINGS.linear)).toBe(0); // last tile hasn't started
  });

  it('drawTile blits only inside the tile cell, covering it fully', () => {
    const calls: number[][] = [];
    const ctx = { drawImage: (...a: unknown[]) => calls.push(a.slice(1) as number[]) } as unknown as CanvasRenderingContext2D;
    const from = {} as CanvasImageSource;
    const to = {} as CanvasImageSource;
    for (const dir of ['left', 'right', 'up', 'down'] as const) {
      for (const p of [0, 0.25, 0.5, 0.99, 1]) {
        calls.length = 0;
        const tile = { x: 100, y: 50, w: 80, h: 60, dir, order: 0 };
        drawTile(ctx, from, to, tile, p);
        let area = 0;
        for (const [, , sw, sh, dx, dy, dw, dh] of calls) {
          expect(dw).toBe(sw);
          expect(dh).toBe(sh);
          expect(dx).toBeGreaterThanOrEqual(tile.x);
          expect(dy).toBeGreaterThanOrEqual(tile.y);
          expect(dx + dw).toBeLessThanOrEqual(tile.x + tile.w);
          expect(dy + dh).toBeLessThanOrEqual(tile.y + tile.h);
          area += dw * dh;
        }
        expect(area).toBe(tile.w * tile.h);
      }
    }
  });
});

describe('shared helpers', () => {
  it('fitRect contain/cover', () => {
    expect(fitRect(400, 300, 800, 800, 'contain')).toEqual({ x: 0, y: 100, w: 800, h: 600 });
    const cover = fitRect(400, 300, 800, 800, 'cover');
    expect(cover.h).toBe(800);
    expect(cover.x).toBeLessThan(0);
  });

  it('stageSize uses device pixels but caps at 4K', () => {
    expect(stageSize({ width: 1920, height: 1080, devicePixelRatio: 1 })).toEqual({ width: 1920, height: 1080 });
    const big = stageSize({ width: 2560, height: 1440, devicePixelRatio: 2 });
    expect(big.width * big.height).toBeLessThanOrEqual(3840 * 2160 + 4000);
  });

  it('animate drives 0→1 and jumps to the end on abort', async () => {
    let now = 0;
    const queue: ((t: number) => void)[] = [];
    const sched: Scheduler = { now: () => now, request: (cb) => queue.push(cb), cancel: () => undefined };
    const seen: number[] = [];
    const p = animate(100, (t) => seen.push(t), undefined, sched);
    for (const t of [50, 100]) {
      now = t;
      queue.shift()!(t);
    }
    await p;
    expect(seen).toEqual([0, 0.5, 1]);

    const ac = new AbortController();
    const seen2: number[] = [];
    const p2 = animate(1000, (t) => seen2.push(t), ac.signal, sched);
    ac.abort();
    await p2;
    expect(seen2.at(-1)).toBe(1);
  });
});
