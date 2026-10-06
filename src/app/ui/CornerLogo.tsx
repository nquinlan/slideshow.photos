import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CornerLogo as CornerLogoSettings, Graphic } from '../db/db';
import { getGraphicFile } from '../db/repo';
import type { Box } from '../formats/types';
import { cornerKeepOut } from '../graphics/graphics';

/**
 * A graphic that stays on screen during playback, over every format. Drawn as
 * a plain <img> of the uploaded file (byte-for-byte), so SVGs stay vector and
 * crisp at any size; bitmaps (PNG, JPEG, …) are never enlarged past their native size.
 * Reports the area it covers (see cornerKeepOut) so graphics can be drawn clear of it.
 */
export function CornerLogo({
  settings,
  graphic,
  onKeepOut,
}: {
  settings: CornerLogoSettings;
  graphic: Graphic | undefined;
  onKeepOut(area: Box | null): void;
}) {
  const [url, setUrl] = useState<string>();
  const ref = useRef<HTMLDivElement>(null);
  const onKeepOutRef = useRef(onKeepOut);
  onKeepOutRef.current = onKeepOut;
  useEffect(() => {
    if (!graphic) return;
    let u: string | undefined;
    let alive = true;
    void getGraphicFile(graphic.id).then((b) => {
      if (!b || !alive) return;
      u = URL.createObjectURL(b);
      setUrl(u);
    });
    return () => {
      alive = false;
      if (u) URL.revokeObjectURL(u);
      setUrl(undefined);
    };
  }, [graphic?.id]);

  // Measure on screen (covers plate padding, safe-area insets and the native-size cap),
  // again whenever the logo or the stage changes size.
  useLayoutEffect(() => {
    const el = ref.current;
    const stage = el?.parentElement;
    if (!el || !stage) return;
    const measure = () => {
      const l = el.getBoundingClientRect();
      const s = stage.getBoundingClientRect();
      onKeepOutRef.current(cornerKeepOut({ x: l.left - s.left, y: l.top - s.top, w: l.width, h: l.height }, s));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    ro.observe(stage);
    return () => {
      ro.disconnect();
      onKeepOutRef.current(null);
    };
  }, [url, settings.position]);

  if (!graphic || !url) return null;
  const [v, h] = settings.position.split('-') as ['top' | 'bottom', 'left' | 'right'];
  // Bitmap: at most its native pixel width (in CSS px at this device's pixel ratio).
  const nativeCss = graphic.type !== 'svg' ? `${graphic.width / (globalThis.devicePixelRatio || 1)}px` : 'none';
  return (
    <div
      ref={ref}
      className={`corner-logo${settings.plate ? ' has-plate' : ''}`}
      style={{
        [v]: 'max(2.5vmin, env(safe-area-inset-' + v + '))',
        [h]: '2.5vmin',
        opacity: settings.opacity,
        background: settings.plate ? graphic.background : 'transparent',
      }}
      aria-hidden="true"
      data-testid="corner-logo"
    >
      <img src={url} alt="" style={{ width: `${settings.sizePct}vw`, maxWidth: nativeCss }} />
    </div>
  );
}
