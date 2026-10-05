import { useId } from 'react';
import type { PlaybackSettings } from '../db/db';
import { FORMATS, REDUCED_MOTION_FORMAT_ID, getFormat } from '../formats';
import { resolveSettings, type SettingField } from '../formats/types';
import { useReducedMotion } from './hooks';

interface Props {
  settings: PlaybackSettings;
  onChange(next: PlaybackSettings): void;
}

/** Slideshow settings. Format-specific controls are generated from the format's settingsSchema. */
export function SlideshowSettings({ settings, onChange }: Props) {
  const id = useId();
  const reducedMotion = useReducedMotion();
  const format = getFormat(settings.formatId);
  const formatValues = resolveSettings(format.settingsSchema, settings.formatSettings[format.id]);
  // When reduced motion swaps in Crossfade, show the settings that will actually apply.
  const uses = (reducedMotion ? getFormat(REDUCED_MOTION_FORMAT_ID) : format).uses;
  const set = (patch: Partial<PlaybackSettings>) => onChange({ ...settings, ...patch });
  const setFormatValue = (key: string, value: unknown) =>
    set({ formatSettings: { ...settings.formatSettings, [format.id]: { ...formatValues, [key]: value } } });

  return (
    <form className="settings-form" onSubmit={(e) => e.preventDefault()} aria-label="Slideshow settings">
      <div className="field">
        <label htmlFor={`${id}-format`}>Format</label>
        <select id={`${id}-format`} value={format.id} onChange={(e) => set({ formatId: e.target.value })}>
          {FORMATS.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
        <p className="help">{format.description}</p>
        {reducedMotion && format.id !== REDUCED_MOTION_FORMAT_ID && (
          <p className="help notice">Your system is set to reduce motion, so photos will crossfade instead.</p>
        )}
      </div>

      {uses.interval && (
        <Range
          id={`${id}-interval`}
          label={uses.interval}
          min={2}
          max={60}
          step={1}
          value={settings.intervalSec}
          format={(v) => `${v}s`}
          onChange={(v) => set({ intervalSec: v })}
        />
      )}
      {uses.transition && (
        <Range
          id={`${id}-transition`}
          label="Transition speed"
          min={300}
          max={4000}
          step={100}
          value={settings.transitionMs}
          format={(v) => `${(v / 1000).toFixed(1)}s`}
          onChange={(v) => set({ transitionMs: v })}
        />
      )}
      {uses.shuffle && (
        <div className="field field-inline">
          <input
            id={`${id}-shuffle`}
            type="checkbox"
            checked={settings.shuffle}
            onChange={(e) => set({ shuffle: e.target.checked })}
          />
          <label htmlFor={`${id}-shuffle`}>Shuffle</label>
        </div>
      )}
      {(uses.fit || uses.backdrop) && (
        <div className="field-row">
          {uses.fit && (
            <div className="field">
              <label htmlFor={`${id}-fit`}>Fit</label>
              <select id={`${id}-fit`} value={settings.fit} onChange={(e) => set({ fit: e.target.value as PlaybackSettings['fit'] })}>
                <option value="contain">Whole photo</option>
                <option value="cover">Fill screen (crop)</option>
              </select>
            </div>
          )}
          {uses.backdrop && (
            <div className="field">
              <label htmlFor={`${id}-backdrop`}>Background</label>
              <select
                id={`${id}-backdrop`}
                value={settings.backdrop}
                onChange={(e) => set({ backdrop: e.target.value as PlaybackSettings['backdrop'] })}
              >
                <option value="blur">Blurred photo</option>
                <option value="black">Black</option>
              </select>
            </div>
          )}
        </div>
      )}

      {format.settingsSchema.length > 0 && (
        <details className="format-options">
          <summary>{format.name} options</summary>
          {format.settingsSchema.map((f) => (
            <SchemaField key={f.key} idPrefix={id} field={f} value={formatValues[f.key]} onChange={(v) => setFormatValue(f.key, v)} />
          ))}
        </details>
      )}
    </form>
  );
}

function Range(props: {
  id: string;
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  format(v: number): string;
  onChange(v: number): void;
  help?: string;
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
        step={props.step}
        value={props.value}
        onChange={(e) => props.onChange(Number(e.target.value))}
        aria-valuetext={props.format(props.value)}
      />
      {props.help && <p className="help">{props.help}</p>}
    </div>
  );
}

function SchemaField({
  idPrefix,
  field,
  value,
  onChange,
}: {
  idPrefix: string;
  field: SettingField;
  value: unknown;
  onChange(v: unknown): void;
}) {
  const id = `${idPrefix}-f-${field.key}`;
  if (field.type === 'number') {
    const decimals = field.step < 1 ? 2 : 0;
    return (
      <Range
        id={id}
        label={field.label}
        min={field.min}
        max={field.max}
        step={field.step}
        value={value as number}
        format={(v) => `${v.toFixed(decimals)}${field.unit ?? ''}`}
        onChange={onChange}
        help={field.help}
      />
    );
  }
  if (field.type === 'select') {
    return (
      <div className="field">
        <label htmlFor={id}>{field.label}</label>
        <select id={id} value={value as string} onChange={(e) => onChange(e.target.value)}>
          {field.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        {field.help && <p className="help">{field.help}</p>}
      </div>
    );
  }
  return (
    <div className="field field-inline">
      <input id={id} type="checkbox" checked={value as boolean} onChange={(e) => onChange(e.target.checked)} />
      <label htmlFor={id}>{field.label}</label>
    </div>
  );
}
