import { useEffect, useId, useState } from 'react';
import { DEFAULT_GRAPHICS, type CollectionGraphics, type Corner, type Graphic } from '../db/db';
import { addGraphic, deleteGraphic, getGraphicFile, updateGraphic } from '../db/repo';
import { GRAPHIC_ACCEPT, GraphicFileError, MAX_TOTAL_SHARE } from '../graphics/graphics';

interface Props {
  graphics: Graphic[];
  settings: CollectionGraphics | undefined;
  onSettingsChange(next: CollectionGraphics): void;
  /** Reload the library after uploads/edits/deletes. */
  onLibraryChange(): void;
}

const CORNERS: { value: Corner; label: string }[] = [
  { value: 'top-left', label: 'Top left' },
  { value: 'top-right', label: 'Top right' },
  { value: 'bottom-left', label: 'Bottom left' },
  { value: 'bottom-right', label: 'Bottom right' },
];

/**
 * Logos and sponsor graphics. The library (file, colour, size, full screen)
 * is shared by all collections; how often each appears and the corner logo
 * are per collection.
 */
export function GraphicsPanel({ graphics, settings, onSettingsChange, onLibraryChange }: Props) {
  const id = useId();
  const cfg = settings ?? DEFAULT_GRAPHICS;
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const total = graphics.reduce((a, g) => a + (cfg.share[g.id] ?? 0), 0);

  const setShare = (gid: string, pct: number) => onSettingsChange({ ...cfg, share: { ...cfg.share, [gid]: pct } });

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setError(undefined);
    setBusy(true);
    const share = { ...cfg.share };
    const problems: string[] = [];
    for (const f of Array.from(files)) {
      try {
        const g = await addGraphic(f);
        share[g.id] = 10; // new graphics start included in this slideshow
      } catch (e) {
        problems.push(`${f.name}: ${e instanceof GraphicFileError ? e.message : 'could not be saved.'}`);
      }
    }
    setBusy(false);
    if (problems.length) setError(problems.join(' '));
    onSettingsChange({ ...cfg, share });
    onLibraryChange();
  }

  async function remove(g: Graphic) {
    if (!confirm(`Delete “${g.name}” from all slideshows?`)) return;
    await deleteGraphic(g.id);
    const share = { ...cfg.share };
    delete share[g.id];
    onSettingsChange({ ...cfg, share, corner: cfg.corner?.graphicId === g.id ? null : cfg.corner });
    onLibraryChange();
  }

  async function edit(g: Graphic, patch: Partial<Pick<Graphic, 'name' | 'background' | 'scalePct' | 'fullScreen'>>) {
    await updateGraphic(g.id, patch);
    onLibraryChange();
  }

  const corner = cfg.corner;
  return (
    <details className="graphics-panel" open={graphics.length > 0 || undefined}>
      <summary>Logos &amp; graphics</summary>
      <p className="help">
        Show your logo or sponsors between photos. Images (PNG, JPEG, SVG, WebP and more) are used exactly as uploaded and
        always shown whole on their background colour. SVG stays sharp at any size.
      </p>
      <label className="btn small upload">
        {busy ? 'Adding…' : 'Add images'}
        <input
          type="file"
          accept={GRAPHIC_ACCEPT}
          multiple
          className="visually-hidden"
          disabled={busy}
          onChange={(e) => {
            void upload(e.target.files);
            e.target.value = '';
          }}
          data-testid="graphic-upload"
        />
      </label>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}

      {graphics.length > 0 && (
        <>
          <p className="help">
            How often each appears: % of slides (Crossfade), of layouts (Sliding Panels) or of drifting items (Floating).
          </p>
          {total / 100 > MAX_TOTAL_SHARE && (
            <p className="help notice">Graphics are capped at {MAX_TOTAL_SHARE * 100}% of the show; shares are scaled down.</p>
          )}
          <ul className="graphics-list">
            {graphics.map((g) => (
              <GraphicRow
                key={g.id}
                graphic={g}
                share={cfg.share[g.id] ?? 0}
                onShare={(pct) => setShare(g.id, pct)}
                onEdit={(patch) => void edit(g, patch)}
                onDelete={() => void remove(g)}
              />
            ))}
          </ul>

          <fieldset className="field corner-logo-settings">
            <legend>Corner logo</legend>
            <label htmlFor={`${id}-corner`} className="visually-hidden">
              Corner logo graphic
            </label>
            <select
              id={`${id}-corner`}
              value={corner?.graphicId ?? ''}
              onChange={(e) =>
                onSettingsChange({
                  ...cfg,
                  corner: e.target.value
                    ? { position: 'bottom-right', sizePct: 12, opacity: 0.9, plate: false, ...corner, graphicId: e.target.value }
                    : null,
                })
              }
              data-testid="corner-logo-select"
            >
              <option value="">None</option>
              {graphics.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
            {corner && (
              <>
                <div className="field">
                  <label htmlFor={`${id}-pos`}>Position</label>
                  <select
                    id={`${id}-pos`}
                    value={corner.position}
                    onChange={(e) => onSettingsChange({ ...cfg, corner: { ...corner, position: e.target.value as Corner } })}
                  >
                    {CORNERS.map((c) => (
                      <option key={c.value} value={c.value}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                </div>
                <Slider
                  id={`${id}-csize`}
                  label="Size"
                  min={4}
                  max={35}
                  value={corner.sizePct}
                  format={(v) => `${v}% of width`}
                  onChange={(v) => onSettingsChange({ ...cfg, corner: { ...corner, sizePct: v } })}
                />
                <Slider
                  id={`${id}-cop`}
                  label="Opacity"
                  min={20}
                  max={100}
                  value={Math.round(corner.opacity * 100)}
                  format={(v) => `${v}%`}
                  onChange={(v) => onSettingsChange({ ...cfg, corner: { ...corner, opacity: v / 100 } })}
                />
                <div className="field-inline">
                  <input
                    id={`${id}-plate`}
                    type="checkbox"
                    checked={corner.plate}
                    onChange={(e) => onSettingsChange({ ...cfg, corner: { ...corner, plate: e.target.checked } })}
                  />
                  <label htmlFor={`${id}-plate`}>Background plate in the graphic’s colour</label>
                </div>
              </>
            )}
          </fieldset>
        </>
      )}
    </details>
  );
}

function GraphicRow({
  graphic: g,
  share,
  onShare,
  onEdit,
  onDelete,
}: {
  graphic: Graphic;
  share: number;
  onShare(pct: number): void;
  onEdit(patch: Partial<Pick<Graphic, 'name' | 'background' | 'scalePct' | 'fullScreen'>>): void;
  onDelete(): void;
}) {
  const id = useId();
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    let u: string | undefined;
    let alive = true;
    void getGraphicFile(g.id).then((b) => {
      if (!b || !alive) return;
      u = URL.createObjectURL(b);
      setUrl(u);
    });
    return () => {
      alive = false;
      if (u) URL.revokeObjectURL(u);
    };
  }, [g.id]);

  return (
    <li className="graphic-row" data-testid="graphic-row">
      <div className="graphic-preview" style={{ background: g.background }}>
        {url && <img src={url} alt={g.name} style={{ maxWidth: `${g.scalePct}%`, maxHeight: `${g.scalePct}%` }} />}
      </div>
      <div className="graphic-fields">
        <input
          className="graphic-name"
          defaultValue={g.name}
          aria-label="Graphic name"
          onBlur={(e) => e.target.value.trim() && e.target.value !== g.name && onEdit({ name: e.target.value.trim() })}
        />
        <Slider
          id={`${id}-share`}
          label="In this slideshow"
          min={0}
          max={50}
          value={share}
          format={(v) => (v ? `${v}%` : 'Off')}
          onChange={onShare}
        />
        <div className="graphic-inline">
          <label className="color-field">
            <input type="color" value={toHex(g.background)} onChange={(e) => onEdit({ background: e.target.value })} />
            Background
          </label>
          <span className="field-inline">
            <input
              id={`${id}-full`}
              type="checkbox"
              checked={g.fullScreen}
              onChange={(e) => onEdit({ fullScreen: e.target.checked })}
            />
            <label htmlFor={`${id}-full`}>Full screen</label>
          </span>
        </div>
        <Slider
          id={`${id}-scale`}
          label="Size in its space"
          min={30}
          max={100}
          value={g.scalePct}
          format={(v) => `${v}%`}
          onChange={(v) => onEdit({ scalePct: v })}
        />
        <button type="button" className="btn ghost small danger" onClick={onDelete}>
          Delete
        </button>
      </div>
    </li>
  );
}

function Slider(props: {
  id: string;
  label: string;
  min: number;
  max: number;
  value: number;
  format(v: number): string;
  onChange(v: number): void;
}) {
  return (
    <div className="field">
      <label htmlFor={props.id}>
        {props.label} <output htmlFor={props.id}>{props.format(props.value)}</output>
      </label>
      <input
        id={props.id}
        type="range"
        min={props.min}
        max={props.max}
        step={1}
        value={props.value}
        aria-valuetext={props.format(props.value)}
        onChange={(e) => props.onChange(Number(e.target.value))}
      />
    </div>
  );
}

/** <input type=color> needs #rrggbb. */
function toHex(c: string): string {
  if (/^#[0-9a-f]{6}$/i.test(c)) return c;
  if (/^#[0-9a-f]{3}$/i.test(c)) return `#${[...c.slice(1)].map((x) => x + x).join('')}`;
  return '#000000';
}
