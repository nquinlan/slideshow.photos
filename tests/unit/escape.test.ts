import { describe, expect, it } from 'vitest';
import { EscapeController, GRACE_MS } from '../../src/app/player/fullscreen';

function harness() {
  const doc = { fullscreenElement: null as Element | null };
  let now = 1000;
  const ctrl = new EscapeController(doc, () => now);
  return {
    doc,
    ctrl,
    advance: (ms: number) => (now += ms),
    enterFs: () => {
      doc.fullscreenElement = {} as Element;
      ctrl.onFullscreenChange();
    },
    exitFs: () => {
      doc.fullscreenElement = null;
      return ctrl.onFullscreenChange();
    },
  };
}

describe('two-stage Escape', () => {
  it('first Escape (browser exits full-screen) keeps playing; second stops', () => {
    const h = harness();
    h.enterFs();
    // Browser handles Esc → fullscreenchange. Some browsers also deliver the keydown afterwards.
    expect(h.exitFs()).toBe(true);
    expect(h.ctrl.onKeyDown('Escape')).toBe('ignored-fullscreen'); // same physical press
    h.advance(GRACE_MS + 50);
    expect(h.ctrl.onKeyDown('Escape')).toBe('stop');
  });

  it('ignores an Escape keydown delivered while still full-screen (Firefox)', () => {
    const h = harness();
    h.enterFs();
    expect(h.ctrl.onKeyDown('Escape')).toBe('ignored-fullscreen');
  });

  it('a single Escape stops playback when it never went full-screen (e.g. iPhone)', () => {
    const h = harness();
    expect(h.ctrl.onKeyDown('Escape')).toBe('stop');
  });

  it('re-entering full-screen re-arms the first stage', () => {
    const h = harness();
    h.enterFs();
    h.exitFs();
    h.advance(1000);
    h.enterFs();
    expect(h.ctrl.onKeyDown('Escape')).toBe('ignored-fullscreen');
    h.exitFs();
    h.advance(1000);
    expect(h.ctrl.onKeyDown('Escape')).toBe('stop');
  });

  it('other keys pass through', () => {
    expect(harness().ctrl.onKeyDown(' ')).toBe('not-escape');
  });
});
