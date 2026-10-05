import { describe, expect, it } from 'vitest';
import { DEFAULT_PLAYBACK, type PlaybackSettings } from '../../src/app/db/db';
import { FORMATS } from '../../src/app/formats';
import type { FormatInstance, SlideImage, SlideshowFormat } from '../../src/app/formats/types';
import { SlideshowEngine, shuffledOrder, type EngineState } from '../../src/app/player/engine';

/** A recording format registered at runtime — no core changes needed to add one. */
const log: string[] = [];
const recorder: SlideshowFormat = {
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
    FORMATS.push({
      ...recorder,
      id: 'test-maxscale',
      create: (ctx, st) => ({ ...recorder.create(ctx, st), init: (img: SlideImage) => void seen.push(img.maxScale) }),
    });
    const { engine } = setup(['a', 'b'], { formatId: 'test-maxscale' });
    await engine.start();
    expect(seen).toEqual([1.5]); // decoded at the stored 10x10 size
  });
});
