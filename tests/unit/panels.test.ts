import { describe, expect, it } from 'vitest';
import { generateLayout, isValidLayout, maxTilesFor, type Rect } from '../../src/app/formats/panels/layout';
import { assignPhotos, matchCost } from '../../src/app/formats/panels/match';
import { drawPanel, motionsFor } from '../../src/app/formats/panels/motion';
import { SlidingPanelsScene, type SlidingPanelsSettings } from '../../src/app/formats/slidingPanels';
import type { LoadedPhoto, PhotoInfo, SceneContext } from '../../src/app/formats/types';

/** Deterministic, well-mixed PRNG (mulberry32) for reproducible layouts. */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w - 0.5 && b.x < a.x + a.w - 0.5 && a.y < b.y + b.h - 0.5 && b.y < a.y + a.h - 0.5;

describe('Sliding Panels layout', () => {
  const screens = [
    [1920, 1080],
    [3024, 1964],
    [3440, 1440],
    [1080, 1920],
    [800, 600],
  ];

  it('fills the screen with valid, non-overlapping tiles inside the margins', () => {
    for (const [W, H] of screens) {
      for (let seed = 1; seed <= 150; seed++) {
        const gutter = Math.round(W * 0.006);
        const tiles = generateLayout({ width: W, height: H, maxTiles: 6, gutter, margin: 2, fullBleedChance: 0.15, random: rng(seed) });
        expect(tiles.length).toBeGreaterThanOrEqual(1);
        expect(tiles.length).toBeLessThanOrEqual(6);
        expect(isValidLayout(tiles, { width: W, height: H })).toBe(true);
        for (const t of tiles) {
          expect(t.x).toBeGreaterThanOrEqual(2);
          expect(t.y).toBeGreaterThanOrEqual(2);
          expect(t.x + t.w).toBeLessThanOrEqual(W - 2 + 0.5);
          expect(t.y + t.h).toBeLessThanOrEqual(H - 2 + 0.5);
        }
        for (let i = 0; i < tiles.length; i++) for (let j = i + 1; j < tiles.length; j++) expect(overlaps(tiles[i], tiles[j])).toBe(false);
        // Tiles plus gutters cover the screen: no large unexplained holes.
        const area = tiles.reduce((a, t) => a + t.w * t.h, 0);
        expect(area / ((W - 4) * (H - 4))).toBeGreaterThan(0.9);
      }
    }
  });

  it('produces varied layouts, including full-bleed singles and busy grids', () => {
    const counts = new Set<number>();
    for (let seed = 1; seed <= 300; seed++) {
      counts.add(generateLayout({ width: 1920, height: 1080, maxTiles: 6, gutter: 12, margin: 2, fullBleedChance: 0.15, random: rng(seed) }).length);
    }
    expect(counts.has(1)).toBe(true);
    expect([...counts].filter((c) => c >= 3).length).toBeGreaterThanOrEqual(3);
  });

  it('uses fewer tiles on small screens and honours the setting', () => {
    expect(maxTilesFor(390, 6)).toBe(3); // phone
    expect(maxTilesFor(768, 6)).toBe(5); // tablet
    expect(maxTilesFor(1080, 6)).toBe(6); // desktop
    expect(maxTilesFor(1080, 2)).toBe(2);
    const single = generateLayout({ width: 1920, height: 1080, maxTiles: 1, gutter: 12, margin: 2, fullBleedChance: 0, random: rng(3) });
    expect(single).toEqual([{ x: 2, y: 2, w: 1916, h: 1076 }]);
  });

  it('never full-bleeds when the chance is 0 and more tiles are allowed', () => {
    for (let seed = 1; seed <= 100; seed++) {
      expect(generateLayout({ width: 1920, height: 1080, maxTiles: 6, gutter: 12, margin: 2, fullBleedChance: 0, random: rng(seed) }).length).toBeGreaterThan(1);
    }
  });
});

describe('Sliding Panels photo matching', () => {
  const p = (id: string, w: number, h: number, maxScale = 2): PhotoInfo => ({ id, width: w, height: h, maxScale });
  const library = [p('land1', 1920, 1280), p('land2', 1920, 1080), p('port1', 1280, 1920), p('port2', 1080, 1920), p('sq', 1500, 1500)];

  it('matches tile shape to photo orientation and never repeats within a layout', () => {
    const tiles: Rect[] = [
      { x: 0, y: 0, w: 960, h: 540 }, // wide
      { x: 0, y: 0, w: 400, h: 800 }, // tall
      { x: 0, y: 0, w: 500, h: 500 }, // square
    ];
    for (let seed = 1; seed <= 30; seed++) {
      const ids = assignPhotos(tiles, library, { random: () => 0.1 + 0 * seed }); // always take the best match
      expect(ids[0]).toMatch(/^land/);
      expect(ids[1]).toMatch(/^port/);
      expect(ids[2]).toBe('sq');
      expect(new Set(ids).size).toBe(3);
    }
  });

  it('avoids recently shown photos when the library allows', () => {
    const tiles: Rect[] = [{ x: 0, y: 0, w: 960, h: 540 }];
    const ids = assignPhotos(tiles, library, { random: () => 0.1, avoid: new Set(['land1', 'land2']) });
    expect(['land1', 'land2']).not.toContain(ids[0]);
  });

  it('only gives a tile a photo big enough to fill it, searching beyond the random sample', () => {
    const tiny = Array.from({ length: 200 }, (_, i) => p(`tiny${i}`, 300, 200, 1));
    const big = p('big', 2400, 1600, 1.5);
    const tile: Rect = { x: 0, y: 0, w: 1800, h: 1200 };
    for (let seed = 1; seed <= 20; seed++) {
      const ids = assignPhotos([tile], [...tiny, big], { random: rng(seed), sampleSize: 8 });
      expect(ids).toEqual(['big']);
    }
  });

  it('falls back to the closest match when no photo is big enough', () => {
    const ids = assignPhotos([{ x: 0, y: 0, w: 1800, h: 1200 }], [p('a', 300, 200, 1), p('b', 200, 300, 1)], { random: () => 0.1 });
    expect(ids).toEqual(['a']); // same shape as the tile
  });

  it('penalises photos that would need upscaling past their original', () => {
    const tile: Rect = { x: 0, y: 0, w: 1800, h: 1200 };
    expect(matchCost(p('tiny', 600, 400, 1), tile)).toBeGreaterThan(matchCost(p('big', 1920, 1280, 1), tile));
  });

  it('copes with a library smaller than the layout', () => {
    const tiles: Rect[] = [
      { x: 0, y: 0, w: 100, h: 100 },
      { x: 0, y: 0, w: 100, h: 100 },
    ];
    expect(assignPhotos(tiles, [p('only', 100, 100)], { random: Math.random })).toEqual(['only', 'only']);
  });
});

describe('Sliding Panels motion', () => {
  it('full-bleed: out squeezes to the horizontal centre line, in opens from the vertical one', () => {
    const one = [{ x: 0, y: 0, w: 1920, h: 1080 }];
    expect(motionsFor(one, 'out')).toEqual([{ axis: 'y', anchor: 'center' }]);
    expect(motionsFor(one, 'in')).toEqual([{ axis: 'x', anchor: 'center' }]);
  });

  it('grids alternate direction by column; single stacks alternate by row', () => {
    const cols: Rect[] = [
      { x: 0, y: 0, w: 600, h: 500 },
      { x: 0, y: 520, w: 600, h: 500 },
      { x: 620, y: 0, w: 600, h: 1020 },
      { x: 1240, y: 0, w: 600, h: 1020 },
    ];
    expect(motionsFor(cols, 'out').map((m) => `${m.axis}:${m.anchor}`)).toEqual(['y:start', 'y:start', 'y:end', 'y:start']);
    const rows: Rect[] = [
      { x: 0, y: 0, w: 1080, h: 900 },
      { x: 0, y: 920, w: 1080, h: 900 },
    ];
    expect(motionsFor(rows, 'out').map((m) => `${m.axis}:${m.anchor}`)).toEqual(['x:start', 'x:end']);
  });

  function recorder() {
    const ops: { clip?: Rect; draw?: Rect }[] = [];
    let clip: Rect | undefined;
    const ctx = {
      save() {},
      restore() {
        clip = undefined;
      },
      beginPath() {},
      rect(x: number, y: number, w: number, h: number) {
        clip = { x, y, w, h };
      },
      clip() {
        ops.push({ clip });
      },
      drawImage(_s: unknown, x: number, y: number, w: number, h: number) {
        ops.push({ draw: { x, y, w, h } });
      },
    } as unknown as CanvasRenderingContext2D;
    return { ctx, ops };
  }
  const img = { source: {} as CanvasImageSource, width: 1600, height: 900, maxScale: 1 };
  const tile: Rect = { x: 100, y: 50, w: 800, h: 450 };

  it('draws nothing when fully hidden and the cover-fitted image when fully visible', () => {
    const r = recorder();
    drawPanel(r.ctx, img, tile, { axis: 'y', anchor: 'start' }, 0);
    expect(r.ops).toEqual([]);
    drawPanel(r.ctx, img, tile, { axis: 'y', anchor: 'start' }, 1);
    expect(r.ops).toEqual([{ clip: tile }, { draw: { x: 100, y: 50, w: 800, h: 450 } }]);
  });

  it('edge-anchored panels slide their content toward the edge, clipped to the tile', () => {
    const r = recorder();
    drawPanel(r.ctx, img, tile, { axis: 'y', anchor: 'start' }, 0.5);
    expect(r.ops).toEqual([{ clip: tile }, { draw: { x: 100, y: 50 - 225, w: 800, h: 450 } }]);
    const r2 = recorder();
    drawPanel(r2.ctx, img, tile, { axis: 'y', anchor: 'end' }, 0.5);
    expect(r2.ops[1]).toEqual({ draw: { x: 100, y: 50 + 225, w: 800, h: 450 } });
  });

  it('centre-anchored panels split into two clipped halves with a seam', () => {
    const r = recorder();
    drawPanel(r.ctx, img, tile, { axis: 'x', anchor: 'center' }, 0.5, 10);
    const clips = r.ops.filter((o) => o.clip).map((o) => o.clip!);
    expect(clips).toEqual([
      { x: 100, y: 50, w: 395, h: 450 },
      { x: 505, y: 50, w: 395, h: 450 },
    ]);
    const draws = r.ops.filter((o) => o.draw).map((o) => o.draw!.x);
    expect(draws).toEqual([100 + 200, 100 - 200]); // left half pushed right, right half pushed left
  });

  it('always covers its tile edge to edge, even with a photo too small to fill it (no gaps)', () => {
    const r = recorder();
    drawPanel(r.ctx, { source: {} as CanvasImageSource, width: 400, height: 225, maxScale: 1 }, tile, { axis: 'y', anchor: 'start' }, 1);
    expect(r.ops[1]).toEqual({ draw: { x: 100, y: 50, w: 800, h: 450 } });
  });
});

describe('Sliding Panels scene cycle', () => {
  function harness(photoCount = 12) {
    let now = 0;
    let rafQueue: [number, (t: number) => void][] = [];
    let timers: { id: number; at: number; cb: () => void }[] = [];
    let ids = 0;
    const loaded: string[] = [];
    const closed: string[] = [];
    const positions: number[] = [];
    const canvas = {
      width: 0,
      height: 0,
      getContext: () =>
        new Proxy(
          {},
          {
            get: (_t, k) => (k === 'canvas' ? canvas : () => undefined),
            set: () => true,
          },
        ),
    } as unknown as HTMLCanvasElement;
    const photos: PhotoInfo[] = Array.from({ length: photoCount }, (_, i) => ({
      id: `p${i}`,
      width: i % 2 ? 1080 : 1920,
      height: i % 2 ? 1920 : 1080,
      maxScale: 2,
    }));
    let seq = 0;
    const ctx: SceneContext = {
      canvas,
      viewport: { width: 1920, height: 1080, devicePixelRatio: 1 },
      render: { fit: 'contain', backdrop: 'black' },
      timing: { intervalMs: 5000, transitionMs: 900 },
      shuffle: false,
      random: rng(42),
      onStatus: (s) => positions.push(s.position),
      library: {
        photos,
        load: async (id) => {
          const key = `${id}#${seq++}`;
          loaded.push(key);
          const info = photos.find((p) => p.id === id)!;
          return { id, source: {} as CanvasImageSource, width: info.width, height: info.height, maxScale: 2, close: () => closed.push(key) } as LoadedPhoto;
        },
      },
    };
    const settings: SlidingPanelsSettings = { maxTiles: 6, gutterPct: 0.6, fullScreen: 'sometimes' };
    const scene = new SlidingPanelsScene(ctx, settings, {
      scheduler: {
        now: () => now,
        request: (cb) => {
          rafQueue.push([++ids, cb]);
          return ids;
        },
        cancel: (id) => {
          rafQueue = rafQueue.filter(([i]) => i !== id);
        },
      },
      setTimeout: (cb, ms) => {
        timers.push({ id: ++ids, at: now + ms, cb });
        return ids;
      },
      clearTimeout: (id) => {
        timers = timers.filter((t) => t.id !== id);
      },
      now: () => now,
    });
    const settle = () => new Promise((r) => setTimeout(r, 0));
    /** Advance the fake clock in 16 ms frames, running due timers and animation frames. */
    async function advance(ms: number) {
      const end = now + ms;
      while (now < end) {
        now = Math.min(end, now + 16);
        const due = timers.filter((t) => t.at <= now);
        timers = timers.filter((t) => t.at > now);
        due.forEach((t) => t.cb());
        const frames = rafQueue;
        rafQueue = [];
        frames.forEach(([, cb]) => cb(now));
        await settle();
      }
    }
    return { scene, advance, settle, positions, loaded, closed, pendingTimers: () => timers.length };
  }

  it('holds for the interval, transitions in ~0.9 s, and loops with new layouts', async () => {
    const h = harness();
    await h.scene.start();
    await h.advance(600); // initial slide-in (0.47 × 900 ms)
    expect(h.positions).toEqual([0]);
    await h.advance(4900);
    expect(h.positions).toEqual([0]); // still holding
    await h.advance(200 + 1000); // hold ends at 5000 ms, transition ~900 ms
    expect(h.positions).toEqual([0, 1]);
    await h.advance(5000 + 1000);
    expect(h.positions).toEqual([0, 1, 2]);
  });

  it('next skips the hold; prev returns to the previous layout', async () => {
    const h = harness();
    await h.scene.start();
    await h.advance(600);
    h.scene.next();
    await h.advance(1000);
    expect(h.positions.at(-1)).toBe(1);
    h.scene.prev();
    await h.advance(1000);
    expect(h.positions.at(-1)).toBe(0);
    h.scene.prev(); // already at the first layout: ignored
    await h.advance(1000);
    expect(h.positions.at(-1)).toBe(0);
  });

  it('pausing freezes the hold and resuming continues with the remaining time', async () => {
    const h = harness();
    await h.scene.start();
    await h.advance(600);
    await h.advance(2000);
    h.scene.pause();
    expect(h.pendingTimers()).toBe(0);
    await h.advance(20000);
    expect(h.positions).toEqual([0]);
    h.scene.resume();
    await h.advance(2000);
    expect(h.positions).toEqual([0]);
    await h.advance(1000 + 1000);
    expect(h.positions).toEqual([0, 1]);
  });

  it('closes every decoded photo by the time it is destroyed', async () => {
    const h = harness();
    await h.scene.start();
    await h.advance(600);
    for (let i = 0; i < 3; i++) {
      h.scene.next();
      await h.advance(1000);
    }
    h.scene.destroy();
    await h.settle();
    await h.settle();
    expect(h.closed.sort()).toEqual(h.loaded.sort());
  });

  it('works with a single-photo collection', async () => {
    const h = harness(1);
    await h.scene.start();
    await h.advance(600 + 5000 + 1000);
    expect(h.positions).toEqual([0, 1]);
  });
});
