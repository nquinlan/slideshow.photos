import { describe, expect, it } from 'vitest';
import { DEFAULT_PLAYBACK, type PlaybackSettings } from '../../src/app/db/db';
import { FORMATS } from '../../src/app/formats';
import type {
  FormatInstance,
  LoadedPhoto,
  SceneContext,
  SceneFormat,
  SceneInstance,
  SlideImage,
  TransitionFormat,
} from '../../src/app/formats/types';
import { SlideshowEngine, shuffledOrder, type EngineState } from '../../src/app/player/engine';

/** A recording format registered at runtime — no core changes needed to add one. */
const log: string[] = [];
const recorder: TransitionFormat = {
  kind: 'transition',
  uses: { interval: 'Interval', transition: true, shuffle: true, fit: true, backdrop: true },
  id: 'test-recorder',
  name: 'Recorder',
  description: 'test',
  settingsSchema: [{ key: 'speed', label: 'Speed', type: 'number', min: 1, max: 3, step: 1, default: 2 }],
  create: (_ctx, settings): FormatInstance => ({
    init: (img: SlideImage) => void log.push(`init:${(img.source as unknown as { id: string }).id}:${settings.speed}`),
    transition: async (img: SlideImage, ms: number) => void log.push(`to:${(img.source as unknown as { id: string }).id}:${ms}`),
    resize: () => void log.push('resize'),
    setRenderOptions: () => void log.push('render'),
    destroy: () => void log.push('destroy'),
  }),
};
FORMATS.push(recorder);

const flush = () => new Promise((r) => setTimeout(r, 0));

function setup(ids: string[], over: Partial<PlaybackSettings> = {}, broken: string[] = []) {
  log.length = 0;
  const closed: string[] = [];
  const timers: (() => void)[] = [];
  const states: EngineState[] = [];
  const settings: PlaybackSettings = { ...DEFAULT_PLAYBACK, formatId: 'test-recorder', transitionMs: 500, ...over };
  const engine = new SlideshowEngine({
    canvas: {} as HTMLCanvasElement,
    photos: ids.map((id) => ({ id, width: 10, height: 10, maxScale: 1.5 })),
    settings,
    reducedMotion: false,
    viewport: { width: 100, height: 100, devicePixelRatio: 1 },
    loadBlob: async (id) => (broken.includes(id) ? undefined : new Blob([id])),
    decode: async (b) => {
      const id = await b.text();
      return { source: { id } as unknown as CanvasImageSource, width: 10, height: 10, close: () => closed.push(id) };
    },
    onState: (s) => states.push(s),
    setTimer: (cb) => timers.push(cb),
    clearTimer: () => (timers.length = 0),
    lookahead: 2,
  });
  return { engine, closed, timers, states, settings };
}

describe('SlideshowEngine', () => {
  it('inits the format with the first photo and advances on the timer', async () => {
    const { engine, timers } = setup(['a', 'b', 'c']);
    await engine.start();
    expect(log).toEqual(['init:a:2']);
    expect(timers).toHaveLength(1);
    timers.shift()!();
    await flush();
    await flush();
    expect(log).toContain('to:b:500');
    expect(engine.state.position).toBe(1);
  });

  it('wraps around and supports prev', async () => {
    const { engine } = setup(['a', 'b', 'c']);
    await engine.start();
    engine.prev();
    await flush();
    await flush();
    expect(engine.state.photoId).toBe('c');
  });

  it('pausing stops the timer; manual navigation still works while paused', async () => {
    const { engine, timers } = setup(['a', 'b', 'c']);
    await engine.start();
    engine.pause();
    expect(timers).toHaveLength(0);
    engine.next();
    await flush();
    await flush();
    expect(engine.state.photoId).toBe('b');
    expect(engine.state.paused).toBe(true);
    expect(timers).toHaveLength(0);
    engine.resume();
    expect(timers).toHaveLength(1);
  });

  it('keeps only current + lookahead decoded and closes the rest', async () => {
    const { engine, closed } = setup(['a', 'b', 'c', 'd', 'e', 'f']);
    await engine.start();
    await flush();
    for (let i = 0; i < 3; i++) {
      engine.next();
      await flush();
      await flush();
      await flush();
    }
    expect(engine.state.photoId).toBe('d');
    // a, b, c have scrolled out of the window [d, e, f].
    expect(closed.sort()).toEqual(['a', 'b', 'c']);
  });

  it('skips photos that cannot be loaded', async () => {
    const { engine } = setup(['a', 'b', 'c'], {}, ['b']);
    await engine.start();
    engine.next();
    for (let i = 0; i < 6; i++) await flush();
    expect(engine.state.photoId).toBe('c');
  });

  it('starts on the requested photo and shuffles as a permutation', async () => {
    expect(shuffledOrder(50).sort((x, y) => x - y)).toEqual(Array.from({ length: 50 }, (_, i) => i));
    const { engine } = setup(['a', 'b', 'c', 'd'], { shuffle: true });
    expect(new Set(['a', 'b', 'c', 'd'])).toContain(engine.state.photoId);
  });

  it('recreates the format only when the format or its settings change', async () => {
    const { engine, settings } = setup(['a', 'b']);
    await engine.start();
    log.length = 0;
    engine.updateSettings({ ...settings, fit: 'cover' });
    expect(log).toEqual(['render']);
    engine.updateSettings({ ...settings, formatSettings: { 'test-recorder': { speed: 3 } } });
    expect(log).toContain('destroy');
    expect(log).toContain('init:a:3');
  });

  it('reports a clear error for empty collections', async () => {
    const { engine, states } = setup([]);
    await engine.start();
    expect(states.at(-1)?.error).toMatch(/no photos/);
  });

  it('passes each photo\'s upscale limit to the format, relative to the decoded size', async () => {
    const seen: (number | undefined)[] = [];
    const maxScaleFormat: TransitionFormat = {
      ...recorder,
      id: 'test-maxscale',
      create: (ctx, st) => ({ ...recorder.create(ctx, st), init: (img: SlideImage) => void seen.push(img.maxScale) }),
    };
    FORMATS.push(maxScaleFormat);
    const { engine } = setup(['a', 'b'], { formatId: 'test-maxscale' });
    await engine.start();
    expect(seen).toEqual([1.5]); // decoded at the stored 10x10 size
  });

  it('runs scene formats: delegates controls, reports status, and they load via the library', async () => {
    const calls: string[] = [];
    const loaded: LoadedPhoto[] = [];
    let ctxSeen: SceneContext | undefined;
    const scene: SceneFormat = {
      kind: 'scene',
      id: 'test-scene',
      name: 'Scene',
      description: 'test',
      settingsSchema: [],
      uses: { interval: 'Hold', transition: true, shuffle: false, fit: false, backdrop: false },
      create: (ctx): SceneInstance => {
        ctxSeen = ctx;
        return {
          start: async () => {
            const p = await ctx.library.load('b', { width: 5, height: 5 });
            if (p) loaded.push(p);
            ctx.onStatus({ position: 7 });
          },
          pause: () => void calls.push('pause'),
          resume: () => void calls.push('resume'),
          next: () => void calls.push('next'),
          prev: () => void calls.push('prev'),
          resize: () => void calls.push('resize'),
          setRenderOptions: () => void calls.push('render'),
          setTiming: (t) => void calls.push(`timing:${t.intervalMs}`),
          destroy: () => {
            calls.push('destroy');
            loaded.forEach((p) => p.close());
          },
        };
      },
    };
    FORMATS.push(scene);
    const { engine, closed, settings, states, timers } = setup(['a', 'b', 'c'], { formatId: 'test-scene', intervalSec: 4 });
    await engine.start();
    expect(ctxSeen?.library.photos.map((p) => p.id)).toEqual(['a', 'b', 'c']);
    expect(ctxSeen?.timing).toEqual({ intervalMs: 4000, transitionMs: 500 });
    expect(loaded.map((p) => p.id)).toEqual(['b']);
    expect(states.at(-1)).toMatchObject({ ready: true, position: 7, total: 0 });
    expect(timers).toHaveLength(0); // scenes own their timing

    engine.next();
    engine.prev();
    engine.pause();
    engine.resume();
    engine.updateSettings({ ...settings, intervalSec: 9 });
    expect(calls).toEqual(['next', 'prev', 'pause', 'resume', 'render', 'timing:9000']);

    // Switching to a transition format tears the scene down and plays the playlist.
    engine.updateSettings({ ...settings, intervalSec: 9, formatId: 'test-recorder' });
    expect(calls).toContain('destroy');
    expect(closed).toContain('b');
    for (let i = 0; i < 4; i++) await flush();
    expect(log).toContain('init:a:2');
    expect(engine.state.total).toBe(3);
  });

  it('transition formats show graphics at their share without skipping photos', async () => {
    log.length = 0;
    const timers: (() => void)[] = [];
    const g = { id: 'logo', width: 4, height: 1, kind: 'vector' as const, background: '#000', scalePct: 80, fullScreen: false };
    const closedGraphics: string[] = [];
    const engine = new SlideshowEngine({
      canvas: {} as HTMLCanvasElement,
      photos: ['a', 'b', 'c', 'd'].map((id) => ({ id, width: 10, height: 10, maxScale: 1 })),
      settings: { ...DEFAULT_PLAYBACK, formatId: 'test-recorder', transitionMs: 500 },
      reducedMotion: false,
      viewport: { width: 100, height: 100, devicePixelRatio: 1 },
      loadBlob: async (id) => new Blob([id]),
      decode: async (b) => {
        const id = await b.text();
        return { source: { id } as unknown as CanvasImageSource, width: 10, height: 10, close: () => undefined };
      },
      graphics: [{ info: g, share: 0.5 }],
      loadGraphic: async () => new Blob(['svg']),
      decodeGraphic: async (info) => ({ id: info.id, source: { id: 'LOGO' } as unknown as CanvasImageSource, width: 4, height: 1, graphic: info, close: () => closedGraphics.push(info.id) }),
      onState: () => undefined,
      setTimer: (cb) => timers.push(cb),
      clearTimer: () => (timers.length = 0),
      random: () => 0.5,
    });
    await engine.start();
    for (let i = 0; i < 8; i++) {
      timers.shift()?.();
      for (let k = 0; k < 6; k++) await flush();
    }
    const shown = log.filter((l) => l.startsWith('to:')).map((l) => l.split(':')[1]);
    // Every other step is the logo, and photos still advance in order around it.
    expect(shown.filter((x) => x === 'LOGO').length).toBe(4);
    expect(shown.filter((x) => x !== 'LOGO')).toEqual(['b', 'c', 'd', 'a']);
    expect(closedGraphics.length).toBeGreaterThanOrEqual(3); // released when the next slide replaces them
    engine.destroy();
  });
});
