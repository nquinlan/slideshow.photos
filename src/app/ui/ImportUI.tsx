import { useEffect, useRef } from 'react';
import type { ImportJob } from '../db/db';
import type { ImportServiceState } from '../import/service';
import { formatBytes, type ImportEstimate, type StorageInfo } from '../import/storage';
import { TIER_LABELS, type QualityTier } from '../pipeline/sizing';

export function StorageMeter({ info }: { info?: StorageInfo }) {
  if (!info?.supported || !info.quota) return null;
  const pct = Math.min(100, (info.usage / info.quota) * 100);
  const level = pct > 90 ? 'danger' : pct > 75 ? 'warn' : 'ok';
  return (
    <div className={`storage-meter ${level}`} title={`${formatBytes(info.usage)} of ${formatBytes(info.quota)} used`}>
      <span className="storage-label">
        {formatBytes(info.usage)} <span className="muted">/ {formatBytes(info.quota)}</span>
      </span>
      <meter min={0} max={info.quota} low={info.quota * 0.75} high={info.quota * 0.9} optimum={0} value={info.usage} aria-label="Storage used" />
    </div>
  );
}

export function ImportPanel({ state, onCancel, onDismiss }: { state: ImportServiceState; onCancel(): void; onDismiss(): void }) {
  const p = state.progress;
  const last = state.last;
  if (!p && !last) return null;

  if (!p && last) {
    const tone = last.status === 'failed' ? 'error' : last.status === 'paused' ? 'warn' : 'ok';
    return (
      <section className={`import-panel ${tone}`} aria-label="Import result" role="status">
        <div className="import-head">
          <strong>
            {last.status === 'done' && 'Import complete'}
            {last.status === 'cancelled' && 'Import cancelled'}
            {last.status === 'failed' && 'Import stopped'}
            {last.status === 'paused' && 'Import paused'}
          </strong>
          <button type="button" className="btn ghost small" onClick={onDismiss} aria-label="Dismiss import result">
            Dismiss
          </button>
        </div>
        <p>{summary(last)}</p>
        {last.error && <p className="error-text">{last.error}</p>}
        <FailedList recent={last.recent} />
      </section>
    );
  }

  const done = p!.imported + p!.upgraded + p!.skipped + p!.failed;
  return (
    <section className="import-panel" aria-label="Import progress" data-testid="import-panel">
      <div className="import-head">
        <strong>
          Adding photos{state.currentLabel ? ` — ${state.currentLabel}` : ''}: {done} of {p!.total}
        </strong>
        <button type="button" className="btn ghost small" onClick={onCancel}>
          Cancel
        </button>
      </div>
      <progress max={p!.total} value={done} aria-label="Import progress" />
      <p className="muted">{summary(p!)}</p>
      {p!.active.length > 0 && (
        <ul className="import-active" aria-label="In progress">
          {p!.active.map((a) => (
            <li key={a.key}>
              <span className={`stage stage-${a.stage}`}>{a.stage}</span> {a.name}
            </li>
          ))}
        </ul>
      )}
      {state.queued.length > 0 && (
        <p className="muted">
          Queued next: {state.queued.map((q) => `${q.label} (${q.count})`).join(', ')}
        </p>
      )}
      <FailedList recent={p!.recent} />
    </section>
  );
}

function summary(p: { imported: number; upgraded: number; skipped: number; failed: number }) {
  const parts = [`${p.imported} added`];
  if (p.upgraded) parts.push(`${p.upgraded} upgraded`);
  if (p.skipped) parts.push(`${p.skipped} already in library`);
  if (p.failed) parts.push(`${p.failed} couldn't be read`);
  return parts.join(' · ');
}

function FailedList({ recent }: { recent: { name: string; outcome: string; error?: string }[] }) {
  const failed = recent.filter((r) => r.outcome === 'failed');
  if (!failed.length) return null;
  return (
    <details className="import-failed">
      <summary>Show files that couldn't be read</summary>
      <ul>
        {failed.map((f, i) => (
          <li key={i}>
            {f.name}: <span className="muted">{f.error}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

export interface PendingImport {
  label: string;
  count: number;
  estimate: ImportEstimate;
  tier: QualityTier;
  keepOriginals: boolean;
}

/** Shown before large imports, or whenever the estimate is close to the quota. */
export function ImportConfirmDialog({
  pending,
  onConfirm,
  onCancel,
  onTierChange,
}: {
  pending: PendingImport;
  onConfirm(): void;
  onCancel(): void;
  onTierChange(t: QualityTier): void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  const { estimate } = pending;
  return (
    <dialog ref={ref} className="dialog" aria-labelledby="import-confirm-title" onCancel={onCancel} data-testid="import-confirm">
      <h2 id="import-confirm-title">
        Add {pending.count.toLocaleString()} photo{pending.count === 1 ? '' : 's'}?
      </h2>
      <p>
        Estimated storage: <strong>about {formatBytes(estimate.bytes)}</strong>
        {Number.isFinite(estimate.freeBytes) && <> · {formatBytes(estimate.freeBytes)} available</>}
      </p>
      {pending.keepOriginals && <p className="muted">Includes the original files (you chose to keep originals).</p>}
      {estimate.level === 'tight' && (
        <p className="callout warn">This will use most of the remaining space. Consider a smaller quality tier.</p>
      )}
      {estimate.level === 'over' && (
        <p className="callout error">
          This probably won't fit. Photos added before space runs out are kept safely, but the rest will be skipped. Try
          a smaller quality tier, turn off "keep originals", or free up space.
        </p>
      )}
      <label className="field">
        Quality
        <select value={pending.tier} onChange={(e) => onTierChange(e.target.value as QualityTier)}>
          {(Object.keys(TIER_LABELS) as QualityTier[]).map((t) => (
            <option key={t} value={t}>
              {TIER_LABELS[t]}
            </option>
          ))}
        </select>
      </label>
      <div className="actions">
        <button type="button" className="btn primary" onClick={onConfirm} autoFocus>
          Add photos
        </button>
        <button type="button" className="btn ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </dialog>
  );
}

export function InterruptedJobs({ jobs, onDismiss }: { jobs: ImportJob[]; onDismiss(id: string): void }) {
  if (!jobs.length) return null;
  return (
    <>
      {jobs.map((j) => (
        <section key={j.id} className="import-panel warn" role="status">
          <div className="import-head">
            <strong>{j.status === 'paused' ? 'Import paused' : 'Import was interrupted'}</strong>
            <button type="button" className="btn ghost small" onClick={() => onDismiss(j.id)}>
              Dismiss
            </button>
          </div>
          <p>
            {j.imported + j.skipped} of {j.total} photos were saved before it stopped.{' '}
            {j.source === 'local'
              ? 'To finish, add the same files or folder again — photos already saved are skipped instantly.'
              : 'To finish, use “Add from Google Photos” and sign in again; photos already saved are skipped.'}
          </p>
        </section>
      ))}
    </>
  );
}
