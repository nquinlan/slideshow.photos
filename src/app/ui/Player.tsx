import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { PlaybackSettings } from '../db/db';
import { getDisplay } from '../db/repo';
import { SlideshowEngine, type EngineState } from '../player/engine';
import {
  EscapeController,
  enterFullscreen,
  exitFullscreen,
  fullscreenDoc,
  fullscreenSupported,
  onFullscreenChange,
} from '../player/fullscreen';
import { WakeLockGuard } from '../player/wakeLock';
import { useReducedMotion } from './hooks';

interface Props {
  photoIds: string[];
  settings: PlaybackSettings;
  startPhotoId?: string;
  onExit(): void;
}

export interface PlayerHandle {
  element: HTMLDivElement | null;
}

const IDLE_MS = 2500;
const SWIPE_PX = 50;

export const Player = forwardRef<PlayerHandle, Props>(function Player({ photoIds, settings, startPhotoId, onExit }, ref) {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<SlideshowEngine | null>(null);
  const reducedMotion = useReducedMotion();
  const [state, setState] = useState<EngineState>();
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [idle, setIdle] = useState(false);
  const [hint, setHint] = useState<string>();
  const [announce, setAnnounce] = useState('');
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;

  useImperativeHandle(ref, () => ({ element: rootRef.current }), []);

  // Engine lifecycle (photo list fixed for the life of the player).
  useEffect(() => {
    const canvas = canvasRef.current!;
    const root = rootRef.current!;
    const engine = new SlideshowEngine({
      canvas,
      photoIds,
      settings,
      reducedMotion,
      startPhotoId,
      viewport: { width: root.clientWidth || innerWidth, height: root.clientHeight || innerHeight, devicePixelRatio: devicePixelRatio || 1 },
      loadBlob: getDisplay,
      onState: setState,
    });
    engineRef.current = engine;
    void engine.start();
    const ro = new ResizeObserver(() =>
      engine.resize({ width: root.clientWidth, height: root.clientHeight, devicePixelRatio: devicePixelRatio || 1 }),
    );
    ro.observe(root);
    const wake = new WakeLockGuard();
    void wake.start();
    return () => {
      ro.disconnect();
      engine.destroy();
      engineRef.current = null;
      void wake.stop();
      void exitFullscreen();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photoIds]);

  // Live settings / reduced-motion changes.
  useEffect(() => {
    engineRef.current?.updateSettings(settings, reducedMotion);
  }, [settings, reducedMotion]);

  // Full-screen + keyboard. See player/fullscreen.ts for the two-stage Escape design.
  useEffect(() => {
    const esc = new EscapeController(fullscreenDoc);
    setIsFullscreen(!!fullscreenDoc.fullscreenElement);
    const offFs = onFullscreenChange(() => {
      const exited = esc.onFullscreenChange();
      setIsFullscreen(!!fullscreenDoc.fullscreenElement);
      if (exited) {
        setHint('Still playing in the window. Press Esc again to stop, or F to go full screen.');
        wake();
      } else setHint(undefined);
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
      const engine = engineRef.current;
      const outcome = esc.onKeyDown(e.key);
      if (outcome === 'stop') {
        e.preventDefault();
        return onExitRef.current();
      }
      if (outcome === 'ignored-fullscreen') return;
      const target = e.target as HTMLElement | null;
      const onButton = target?.closest('button');
      switch (e.key) {
        case ' ':
        case 'k':
          if (onButton && e.key === ' ') return; // let Space activate the focused control
          e.preventDefault();
          engine?.togglePause();
          setAnnounce(engine?.state.paused ? 'Paused' : 'Playing');
          break;
        case 'ArrowRight':
        case 'PageDown':
          e.preventDefault();
          engine?.next();
          break;
        case 'ArrowLeft':
        case 'PageUp':
          e.preventDefault();
          engine?.prev();
          break;
        case 'f':
        case 'F':
          e.preventDefault();
          void toggleFullscreen();
          break;
        default:
          return;
      }
      wake();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      offFs();
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  // Auto-hide cursor and controls.
  const idleTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  function wake() {
    setIdle(false);
    clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => {
      // Keep controls visible while keyboard focus is inside them.
      if (rootRef.current?.querySelector('.player-controls')?.contains(document.activeElement)) return wake();
      setIdle(true);
    }, IDLE_MS);
  }
  useEffect(() => {
    wake();
    return () => clearTimeout(idleTimer.current);
  }, []);

  useEffect(() => {
    if (!hint) return;
    const t = setTimeout(() => setHint(undefined), 5000);
    return () => clearTimeout(t);
  }, [hint]);

  async function toggleFullscreen() {
    if (fullscreenDoc.fullscreenElement) await exitFullscreen();
    else if (rootRef.current) await enterFullscreen(rootRef.current);
  }

  // Touch: horizontal swipe = next/prev, tap = show/hide controls.
  const touchStart = useRef<{ x: number; y: number; t: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType !== 'touch') return;
    touchStart.current = { x: e.clientX, y: e.clientY, t: performance.now() };
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const s = touchStart.current;
    touchStart.current = null;
    if (!s || e.pointerType !== 'touch' || (e.target as HTMLElement).closest('button')) return;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    if (Math.abs(dx) > SWIPE_PX && Math.abs(dx) > Math.abs(dy) * 1.5) {
      if (dx < 0) engineRef.current?.next();
      else engineRef.current?.prev();
      wake();
    } else if (Math.abs(dx) < 10 && Math.abs(dy) < 10) {
      if (idle) wake();
      else setIdle(true);
    }
  };

  const paused = state?.paused ?? false;
  const counter = state && state.total ? `${state.position + 1} / ${state.total}` : '';

  return (
    <div
      ref={rootRef}
      className={`player${idle ? ' is-idle' : ''}`}
      role="region"
      aria-label="Slideshow"
      onPointerMove={(e) => e.pointerType === 'mouse' && wake()}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      data-testid="player"
      data-fullscreen={isFullscreen ? 'true' : 'false'}
      data-paused={paused ? 'true' : 'false'}
      data-position={state?.position ?? -1}
    >
      <canvas ref={canvasRef} className="player-canvas" aria-hidden="true" />
      {state?.error && <p className="player-error">{state.error}</p>}
      {!state?.ready && !state?.error && <p className="player-loading">Loading…</p>}
      {hint && (
        <p className="player-hint" role="status">
          {hint}
        </p>
      )}
      <div className="visually-hidden" aria-live="polite">
        {announce}
      </div>
      <div className="player-controls" onFocus={wake}>
        <button type="button" onClick={() => engineRef.current?.prev()} aria-label="Previous photo" title="Previous (←)">
          <Icon d="M15.5 5 8.5 12l7 7" stroke />
        </button>
        <button
          type="button"
          onClick={() => engineRef.current?.togglePause()}
          aria-label={paused ? 'Play' : 'Pause'}
          title={paused ? 'Play (Space)' : 'Pause (Space)'}
        >
          {paused ? <Icon d="M8 5v14l11-7z" /> : <Icon d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" />}
        </button>
        <button type="button" onClick={() => engineRef.current?.next()} aria-label="Next photo" title="Next (→)">
          <Icon d="m8.5 5 7 7-7 7" stroke />
        </button>
        <span className="player-counter" aria-label={`Photo ${counter.replace(' / ', ' of ')}`}>
          {counter}
        </span>
        <span className="spacer" />
        {fullscreenSupported() && (
          <button
            type="button"
            onClick={() => void toggleFullscreen()}
            aria-label={isFullscreen ? 'Exit full screen' : 'Enter full screen'}
            title={isFullscreen ? 'Exit full screen (Esc)' : 'Full screen (F)'}
            data-testid="fullscreen-toggle"
          >
            {isFullscreen ? (
              <Icon d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" stroke />
            ) : (
              <Icon d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" stroke />
            )}
          </button>
        )}
        <button type="button" onClick={() => onExitRef.current()} aria-label="Stop slideshow" title="Stop (Esc)">
          <Icon d="M6 6l12 12M18 6 6 18" stroke />
        </button>
      </div>
    </div>
  );
});

function Icon({ d, stroke = false }: { d: string; stroke?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
      <path
        d={d}
        fill={stroke ? 'none' : 'currentColor'}
        stroke={stroke ? 'currentColor' : 'none'}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
