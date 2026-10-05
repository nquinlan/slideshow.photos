import { useId, useState } from 'react';
import type { AppSettings } from '../db/db';
import type { LibraryUsage } from '../db/repo';
import { formatBytes, type StorageInfo } from '../import/storage';
import { TIER_LABELS, longEdgeCap, type QualityTier } from '../pipeline/sizing';

interface Props {
  settings: AppSettings;
  usage?: LibraryUsage;
  storage?: StorageInfo;
  onChange(patch: Partial<AppSettings>): void;
  onRequestPersist(): void;
  onDeleteOriginals(): void;
}

const TIER_HELP: Record<QualityTier, string> = {
  screen: 'Sized for this screen (up to 2560px). Smallest storage; looks sharp here.',
  high: '2560px on the long edge. Good for larger or high-DPI displays you may cast to later.',
  '4k': '3840px on the long edge. For 4K TVs and monitors; roughly 2.5× the storage of Screen-fit.',
};

export function LibrarySettings({ settings, usage, storage, onChange, onRequestPersist, onDeleteOriginals }: Props) {
  const id = useId();
  const [confirmOriginals, setConfirmOriginals] = useState(false);
  return (
    <div className="settings-form">
      <fieldset className="field">
        <legend>Import quality</legend>
        {(Object.keys(TIER_LABELS) as QualityTier[]).map((t) => (
          <div className="radio" key={t}>
            <input
              type="radio"
              id={`${id}-${t}`}
              name={`${id}-tier`}
              value={t}
              checked={settings.tier === t}
              onChange={() => onChange({ tier: t })}
            />
            <label htmlFor={`${id}-${t}`}>
              {TIER_LABELS[t]}
              {t === 'screen' && <span className="muted"> — {longEdgeCap('screen')}px on this display</span>}
              <span className="help">{TIER_HELP[t]}</span>
            </label>
          </div>
        ))}
        <p className="help">
          Photos are stored at the quality chosen when they were added; changing this only affects new imports.{' '}
          <strong>To upgrade photos you already added</strong>, choose a higher quality and add the same files (or pick
          them again in Google Photos). Matching photos are re-processed and replaced in place — they keep their place in
          every collection. Because originals aren't kept by default, this needs access to the original files.
        </p>
      </fieldset>

      <div className="field">
        <div className="field-inline">
          <input
            type="checkbox"
            id={`${id}-orig`}
            checked={settings.keepOriginals}
            onChange={(e) => (e.target.checked ? setConfirmOriginals(true) : onChange({ keepOriginals: false }))}
          />
          <label htmlFor={`${id}-orig`}>Also keep original files</label>
        </div>
        {confirmOriginals && !settings.keepOriginals && (
          <div className="callout warn" role="alert">
            <p>
              Originals are usually 5–15× larger than the slideshow copies (a 1,000-photo collection can need several
              GB) and may contain location data. Browsers can clear site data when the device runs low on space.
            </p>
            <div className="actions">
              <button
                type="button"
                className="btn"
                onClick={() => {
                  onChange({ keepOriginals: true });
                  setConfirmOriginals(false);
                }}
              >
                Keep originals
              </button>
              <button type="button" className="btn ghost" onClick={() => setConfirmOriginals(false)}>
                Cancel
              </button>
            </div>
          </div>
        )}
        <p className="help">Off by default. Only affects photos added while it's on.</p>
        {usage && usage.originalBytes > 0 && (
          <button type="button" className="btn ghost small" onClick={onDeleteOriginals}>
            Delete kept originals ({formatBytes(usage.originalBytes)})
          </button>
        )}
      </div>

      <div className="field">
        <h3 className="field-title">Storage</h3>
        {usage && (
          <p>
            {usage.photos.toLocaleString()} photos · slideshow copies {formatBytes(usage.displayBytes)} · thumbnails{' '}
            {formatBytes(usage.thumbBytes)}
            {usage.originalBytes > 0 && <> · originals {formatBytes(usage.originalBytes)}</>}
          </p>
        )}
        {storage?.supported ? (
          <>
            <p>
              Browser storage used: {formatBytes(storage.usage)} of {formatBytes(storage.quota)} available to this site.
            </p>
            <p>
              {storage.persisted ? (
                'Storage is persistent: the browser won’t clear it automatically.'
              ) : (
                <>
                  Storage isn't marked persistent yet, so the browser may clear it under storage pressure.{' '}
                  <button type="button" className="btn ghost small" onClick={onRequestPersist}>
                    Make storage persistent
                  </button>
                </>
              )}
            </p>
          </>
        ) : (
          <p className="muted">This browser doesn't report storage usage.</p>
        )}
      </div>
    </div>
  );
}
