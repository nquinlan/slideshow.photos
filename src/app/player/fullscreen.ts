/**
 * Full-screen handling and the two-stage Escape behaviour.
 *
 * Why two stages, and why we don't fight the browser:
 *  - While an element is full-screen, browsers reserve Escape to exit
 *    full-screen. Pages cannot preventDefault() it. Chrome and Safari don't
 *    deliver that keydown to the page at all; Firefox may deliver it, and
 *    some browsers deliver it *after* `fullscreenchange` has already fired.
 *  - We deliberately do NOT use the Keyboard Lock API
 *    (`navigator.keyboard.lock(['Escape'])`, Chromium-only). It would turn
 *    the exit into "press and hold Esc", which breaks a convention users rely
 *    on and only works in one engine.
 *
 * So:
 *  1st Escape (full-screen): the browser exits full-screen. We observe
 *     `fullscreenchange`, keep playing in the window, and show a hint plus a
 *     button to go full-screen again.
 *  2nd Escape (windowed): the keydown reaches us; we stop playback.
 *
 * Guard: an Escape keydown that arrives while we're still full-screen, or
 * within GRACE_MS after leaving it, is the *same* key press the browser used
 * to exit full-screen, so it is ignored.
 */

export const GRACE_MS = 250;

export interface FullscreenDoc {
  readonly fullscreenElement: Element | null;
}

export type EscapeOutcome = 'ignored-fullscreen' | 'stop' | 'not-escape';

export class EscapeController {
  private lastExitAt = -Infinity;
  private wasFullscreen = false;

  constructor(
    private doc: FullscreenDoc,
    private now: () => number = () => performance.now(),
  ) {
    this.wasFullscreen = !!doc.fullscreenElement;
  }

  /** Call on every `fullscreenchange`. Returns true if we just left full-screen. */
  onFullscreenChange(): boolean {
    const isFs = !!this.doc.fullscreenElement;
    const exited = this.wasFullscreen && !isFs;
    if (exited) this.lastExitAt = this.now();
    this.wasFullscreen = isFs;
    return exited;
  }

  onKeyDown(key: string): EscapeOutcome {
    if (key !== 'Escape' && key !== 'Esc') return 'not-escape';
    if (this.doc.fullscreenElement) return 'ignored-fullscreen';
    if (this.now() - this.lastExitAt < GRACE_MS) return 'ignored-fullscreen';
    return 'stop';
  }
}

// --- Fullscreen API with WebKit-prefixed fallbacks (older Safari / iPadOS) ---

type WebkitDoc = Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
  webkitFullscreenEnabled?: boolean;
};
type WebkitEl = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };

export const fullscreenDoc: FullscreenDoc = {
  get fullscreenElement() {
    const d = document as WebkitDoc;
    return d.fullscreenElement ?? d.webkitFullscreenElement ?? null;
  },
};

export function fullscreenSupported(): boolean {
  const d = document as WebkitDoc;
  return !!(d.fullscreenEnabled ?? d.webkitFullscreenEnabled);
}

export async function enterFullscreen(el: HTMLElement): Promise<boolean> {
  const e = el as WebkitEl;
  try {
    if (e.requestFullscreen) await e.requestFullscreen({ navigationUI: 'hide' });
    else if (e.webkitRequestFullscreen) await e.webkitRequestFullscreen();
    else return false;
    return true;
  } catch {
    // Denied (no user activation, iframe without allowfullscreen, iPhone Safari…):
    // playback continues windowed.
    return false;
  }
}

export async function exitFullscreen() {
  const d = document as WebkitDoc;
  if (!fullscreenDoc.fullscreenElement) return;
  try {
    if (d.exitFullscreen) await d.exitFullscreen();
    else await d.webkitExitFullscreen?.();
  } catch {
    /* already exited */
  }
}

export function onFullscreenChange(cb: () => void): () => void {
  document.addEventListener('fullscreenchange', cb);
  document.addEventListener('webkitfullscreenchange', cb);
  return () => {
    document.removeEventListener('fullscreenchange', cb);
    document.removeEventListener('webkitfullscreenchange', cb);
  };
}
