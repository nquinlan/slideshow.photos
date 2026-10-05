import { describe, expect, it } from 'vitest';
import { FloatingScene, LAYERS, chooseX, drifterSize, type FloatingSettings } from '../../src/app/formats/floating';
import type { Surface } from '../../src/app/formats/shared';
import type { LoadedPhoto, PhotoInfo, SceneContext } from '../../src/app/formats/types';

function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('Floating helpers', () => {
  it('chooseX spreads entries away from photos near the entry edge', () => {
    const x = chooseX(1920, 400, [300, 500], rng(1), 16);
    expect(x).toBeGreaterThan(1000);
    expect(x).toBeLessThanOrEqual(1920 - 200);
    expect(x).toBeGreaterThanOrEqual(200);
  });

  it('drifterSize scales by depth layer and never upscales past the original', () => {
    expect(drifterSize({ width: 1600, height: 1200, maxScale: 2 }, 400, 1)).toEqual({ w: 400, h: 300 });
    expect(drifterSize({ width: 1200, height: 1600, maxScale: 2 }, 400, 0.5)).toEqual({ w: 150, h: 200 });
    // A 200x150 original can't be shown larger than 200 px wide.
    expect(drifterSize({ width: 200, height: 150, maxScale: 1 }, 800, 1)).toEqual({ w: 200, h: 150 });
  });

  it('depth layers get smaller and dimmer with distance', () => {
    for (let i = 1; i < LAYERS.length; i++) {
      expect(LAYERS[i].scale).toBeGreaterThan(LAYERS[i - 1].scale);
      expect(LAYERS[i].dim).toBeLessThan(LAYERS[i - 1].dim);
    }
  });
});

describe('Floating scene', () => {
  function harness(over: Partial<FloatingSettings> = {}, photoCount = 30) {
    let rafQueue: [number, (t: number) => void][] = [];
    let ids = 0;
    let now = 0;
    const loaded: string[] = [];
    const closed: string[] = [];
    const surfaces: { width: number; height: number }[] = [];
    const draws: number[] = [];
    const ctx2dStub = (onDraw?: () => void) =>
      new Proxy({}, { get: (_t, k) => (k === 'drawImage' ? () => onDraw?.() : () => undefined), set: () => true });
    const canvas = { width: 0, height: 0, getContext: () => ctx2dStub(() => draws.push(now)) } as unknown as HTMLCanvasElement;
    const photos: PhotoInfo[] = Array.from({ length: photoCount }, (_, i) => ({ id: `p${i}`, width: 1600, height: 1200, maxScale: 2 }));
    let seq = 0;
    const statuses: number[] = [];
    const ctx: SceneContext = {
      canvas,
      viewport: { width: 1920, height: 1080, devicePixelRatio: 1 },
      render: { fit: 'contain', backdrop: 'black' },
      timing: { intervalMs: 5000, transitionMs: 900 },
      shuffle: false,
      random: rng(7),
      onStatus: (s) => statuses.push(s.position),
      library: {
        photos,
        load: async (id, box) => {
          const key = `${id}#${seq++}`;
          loaded.push(key);
          const w = box?.width ?? 1600;
          return { id, source: {} as CanvasImageSource, width: w, height: Math.round((w * 3) / 4), maxScale: 2, close: () => closed.push(key) } as LoadedPhoto;
        },
      },
    };
    const settings: FloatingSettings = { crossSeconds: 20, density: 8, sizePct: 36, direction: 'down', depth: true, borders: true, ...over };
    const scene = new FloatingScene(ctx, settings, {
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
      createSurface: (w, h) => {
        const s = { width: w, height: h, getContext: () => ctx2dStub() };
        surfaces.push(s);
        return s as unknown as Surface;
      },
    });
    const settle = () => new Promise((r) => setTimeout(r, 0));
    /** Advance the fake clock; `step` ≤ 100 ms (the scene caps a frame's dt at 0.1 s). */
    async function advance(ms: number, step = 16) {
      const end = now + ms;
      while (now < end) {
        now = Math.min(end, now + step);
        const frames = rafQueue;
        rafQueue = [];
        frames.forEach(([, cb]) => cb(now));
        await settle();
      }
    }
    return { scene, advance, settle, loaded, closed, surfaces, statuses, draws };
  }

  it('starts with the screen populated and releases each decoded photo once its sprite is rendered', async () => {
    const h = harness();
    await h.scene.start();
    await h.settle();
    expect(h.scene.count).toBe(8);
    expect(h.closed.length).toBe(h.loaded.length); // bitmaps are freed; only sprites remain
  });

  it('keeps photos flowing: drifters leave and new ones arrive at about the density', async () => {
    const h = harness();
    await h.scene.start();
    await h.advance(60_000, 100); // three full crossings
    expect(h.statuses.length).toBeGreaterThan(15); // ~8 per 20 s crossing
    expect(h.scene.count).toBeGreaterThan(3);
    expect(h.scene.count).toBeLessThan(16);
    // Sprites of photos that left the screen are shrunk to 1x1 (released).
    expect(h.surfaces.filter((s) => s.width === 1).length).toBeGreaterThan(5);
  });

  it('pause freezes motion and spawning; next spawns immediately', async () => {
    const h = harness();
    await h.scene.start();
    await h.advance(1000);
    h.scene.pause();
    const before = h.statuses.length;
    await h.advance(30_000, 100);
    expect(h.statuses.length).toBe(before);
    h.scene.next();
    await h.settle();
    await h.settle();
    expect(h.statuses.length).toBe(before + 1);
  });

  it('destroy releases every sprite and decoded photo', async () => {
    const h = harness();
    await h.scene.start();
    await h.advance(5000);
    h.scene.destroy();
    await h.settle();
    await h.settle();
    expect(h.closed.sort()).toEqual(h.loaded.sort());
    expect(h.surfaces.every((s) => s.width === 1 && s.height === 1)).toBe(true);
  });

  it('upward direction and flat depth work too', async () => {
    // A 3-photo library shows 3 at a time (repeats allowed only for libraries this small).
    const h = harness({ direction: 'up', depth: false }, 3);
    await h.scene.start();
    expect(h.scene.count).toBe(3);
    await h.advance(30_000, 100);
    expect(h.statuses.length).toBeGreaterThanOrEqual(3);
  });

  it('spreads the initial photos across the screen (regression: all started at x = 0)', async () => {
    const h = harness();
    await h.scene.start();
    const xs = (h.scene as unknown as { drifters: { x: number; sprite: { w: number } }[] }).drifters.map((d) => d.x);
    expect(xs.length).toBe(8);
    for (const x of xs) {
      expect(x).toBeGreaterThan(0);
      expect(x).toBeLessThan(1920);
    }
    // Spread out, not clustered: they span at least half the width.
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(960);
  });

  it('never shows the same photo twice at once, even when the library is barely big enough', async () => {
    const h = harness({ density: 10 }, 13);
    await h.scene.start();
    for (let second = 0; second < 90; second++) {
      await h.advance(1000, 100);
      const ids = h.scene.ids;
      expect(new Set(ids).size).toBe(ids.length);
    }
    expect(h.statuses.length).toBeGreaterThan(10); // still flowing
  });

  it('caps photos on screen below the library size', async () => {
    const h = harness({ density: 20 }, 8);
    await h.scene.start();
    expect(h.scene.count).toBe(5); // 8 photos − 3 kept free for entering
  });
});
