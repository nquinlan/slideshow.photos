import { describe, expect, it } from 'vitest';
import { FORMATS, effectiveFormat, getFormat } from '../../src/app/formats';
import { slidingPanels } from '../../src/app/formats/slidingPanels';
import { animate, drawGraphic, fitRect, stageSize, type Scheduler } from '../../src/app/formats/shared';
import { resolveSettings } from '../../src/app/formats/types';
import { toPhotoInfo } from '../../src/app/player/photos';

describe('SlideshowFormat registry & interface contract', () => {
  it('every format has a unique id, a kind, a name and a valid settings schema', () => {
    const ids = new Set<string>();
    for (const f of FORMATS) {
      expect(f.id).toMatch(/^[a-z0-9-]+$/);
      expect(ids.has(f.id)).toBe(false);
      ids.add(f.id);
      expect(['transition', 'scene']).toContain(f.kind);
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

  it('Sliding Panels is the default and falls back to crossfade for reduced motion', () => {
    expect(FORMATS[0].id).toBe('sliding-panels');
    expect(effectiveFormat('sliding-panels', false).id).toBe('sliding-panels');
    expect(effectiveFormat('sliding-panels', true).id).toBe('crossfade');
    // Removed/unknown ids (e.g. the old sliding-tiles) fall back to the default.
    expect(getFormat('sliding-tiles').id).toBe('sliding-panels');
  });

  it('resolveSettings clamps numbers, rejects unknown options and drops unknown keys', () => {
    const r = resolveSettings(slidingPanels.settingsSchema, { maxTiles: 99, fullScreen: 'always', gutterPct: 1.2, bogus: 1 });
    expect(r.maxTiles).toBe(6);
    expect(r.fullScreen).toBe('sometimes');
    expect(r.gutterPct).toBe(1.2);
    expect('bogus' in r).toBe(false);
  });
});

describe('shared helpers', () => {
  it('fitRect contain/cover', () => {
    expect(fitRect(400, 300, 800, 800, 'contain')).toEqual({ x: 0, y: 100, w: 800, h: 600 });
    const cover = fitRect(400, 300, 800, 800, 'cover');
    expect(cover.h).toBe(800);
    expect(cover.x).toBeLessThan(0);
  });

  it('fitRect never scales beyond maxScale (no upscaling small photos)', () => {
    // 640x480 photo on a 1920x1080 stage: contain would scale 2.25x; capped at 1 it stays centred at native size.
    expect(fitRect(640, 480, 1920, 1080, 'contain', 1)).toEqual({ x: 640, y: 300, w: 640, h: 480 });
    expect(fitRect(640, 480, 1920, 1080, 'cover', 1)).toEqual({ x: 640, y: 300, w: 640, h: 480 });
    // A capped 2560px copy of a 4032px original may fill a 2880px stage (scale 1.125 <= 1.575).
    const r = fitRect(2560, 1920, 2880, 1800, 'contain', 4032 / 2560);
    expect(r.h).toBe(1800);
  });

  it('drawGraphic shows a graphic whole on its colour; PNGs are never enlarged, SVGs scale', () => {
    const calls: { fill?: unknown[]; draw?: number[]; color?: string }[] = [];
    const ctx = {
      set fillStyle(c: string) {
        calls.push({ color: c });
      },
      fillRect: (...a: number[]) => calls.push({ fill: a }),
      drawImage: (_s: unknown, ...a: number[]) => calls.push({ draw: a }),
    } as unknown as CanvasRenderingContext2D;
    const graphic = { id: 'g', width: 400, height: 100, kind: 'raster' as const, background: '#ff0', scalePct: 50, fullScreen: false };
    const rect = { x: 0, y: 0, w: 1000, h: 1000 };
    // PNG 400x100, 50% of a 1000px space = 500px box: contained at native 400x100 (not enlarged).
    drawGraphic(ctx, { source: {} as CanvasImageSource, width: 400, height: 100, maxScale: 1, graphic }, rect);
    expect(calls).toEqual([{ color: '#ff0' }, { fill: [0, 0, 1000, 1000] }, { draw: [300, 450, 400, 100] }]);
    calls.length = 0;
    // SVG: scales up to fill the 500px box, still whole (contain).
    drawGraphic(ctx, { source: {} as CanvasImageSource, width: 400, height: 100, maxScale: Infinity, graphic: { ...graphic, kind: 'vector' } }, rect);
    expect(calls[2]).toEqual({ draw: [250, 437.5, 500, 125] });
  });

  it('toPhotoInfo allows scaling up to the original, never below 1', () => {
    expect(toPhotoInfo({ id: 'a', width: 2560, height: 1920, sourceWidth: 4032, sourceHeight: 3024 }).maxScale).toBeCloseTo(1.575);
    expect(toPhotoInfo({ id: 'b', width: 640, height: 480, sourceWidth: 640, sourceHeight: 480 }).maxScale).toBe(1);
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
