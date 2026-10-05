import { useEffect, useState } from 'react';
import type { CornerLogo as CornerLogoSettings, Graphic } from '../db/db';
import { getGraphicFile } from '../db/repo';

/**
 * A graphic that stays on screen during playback, over every format. Drawn as
 * a plain <img> of the uploaded file (byte-for-byte), so SVGs stay vector and
 * crisp at any size; PNGs are never enlarged past their native size.
 */
export function CornerLogo({ settings, graphic }: { settings: CornerLogoSettings; graphic: Graphic | undefined }) {
  const [url, setUrl] = useState<string>();
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

  if (!graphic || !url) return null;
  const [v, h] = settings.position.split('-') as ['top' | 'bottom', 'left' | 'right'];
  // PNG: at most its native pixel width (in CSS px at this device's pixel ratio).
  const nativeCss = graphic.type === 'png' ? `${graphic.width / (globalThis.devicePixelRatio || 1)}px` : 'none';
  return (
    <div
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
