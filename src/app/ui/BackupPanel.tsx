import { useEffect, useId, useRef, useState } from 'react';
import type { CollectionSummary, LibraryUsage } from '../db/repo';
import type { BackupSummary, ImportResult, OpenBackup } from '../backup/import';
import type { ExportPlan } from '../backup/export';
import { checkImportFits, formatBytes, type ImportEstimate } from '../import/storage';

interface Props {
  collections: CollectionSummary[];
  usage?: LibraryUsage;
  onImported(result: ImportResult): void;
}

type FSAWindow = Window & {
  showSaveFilePicker?: (opts: unknown) => Promise<{ createWritable(): Promise<WritableStream<Uint8Array>> }>;
};

const isAbort = (e: unknown) => (e as Error)?.name === 'AbortError';

/**
 * "Move to another computer": export slideshows (photos, graphics, settings)
 * to a .zip and import one made elsewhere. The zip code is loaded on demand.
 */
export function BackupPanel({ collections, usage, onImported }: Props) {
  return (
    <div className="settings-form backup-panel">
      <ExportSection collections={collections} usage={usage} />
      <ImportSection onImported={onImported} />
    </div>
  );
}

function ExportSection({ collections, usage }: { collections: CollectionSummary[]; usage?: LibraryUsage }) {
  const id = useId();
  const [selected, setSelected] = useState<Set<string>>(() => new Set(collections.map((c) => c.id)));
  const [originals, setOriginals] = useState(false);
  const [plan, setPlan] = useState<ExportPlan>();
  const [progress, setProgress] = useState<{ done: number; total: number }>();
  const [message, setMessage] = useState<{ ok: boolean; text: string }>();
  const abort = useRef<AbortController>(undefined);
  const known = useRef(new Set(collections.map((c) => c.id)));

  // New collections appear selected.
  useEffect(() => {
    setSelected((prev) => {
      const next = new Set([...prev].filter((cid) => collections.some((c) => c.id === cid)));
      for (const c of collections) if (!known.current.has(c.id)) next.add(c.id);
      known.current = new Set(collections.map((c) => c.id));
      return next;
    });
  }, [collections]);

  // Live size estimate for the current choice.
  useEffect(() => {
    let alive = true;
    void import('../backup/export').then(({ planExport }) =>
      planExport({ collectionIds: [...selected], includeOriginals: originals }).then((p) => alive && setPlan(p)),
    );
    return () => {
      alive = false;
    };
  }, [selected, originals]);

  async function exportNow() {
    setMessage(undefined);
    const { planExport, writeExport, suggestedFileName } = await import('../backup/export');
    const name = suggestedFileName();
    // Ask where to save first (needs the click's user activation), then stream straight to disk.
    let target: WritableStream<Uint8Array> | null = null;
    const w = window as FSAWindow;
    if (w.showSaveFilePicker) {
      try {
        const handle = await w.showSaveFilePicker({
          suggestedName: name,
          types: [{ description: 'Slideshow library', accept: { 'application/zip': ['.zip'] } }],
        });
        target = await handle.createWritable();
      } catch (e) {
        if (isAbort(e)) return;
        target = null; // fall back to a download
      }
    }
    const ac = new AbortController();
    abort.current = ac;
    try {
      const p = await planExport({ collectionIds: [...selected], includeOriginals: originals });
      setProgress({ done: 0, total: p.files });
      const blob = await writeExport(p, target, setProgress, ac.signal);
      if (blob) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      }
      const count = p.manifest.collections.length;
      setMessage({ ok: true, text: `Exported ${count} slideshow${count === 1 ? '' : 's'} (${formatBytes(blob?.size ?? p.bytes)}) to ${name}.` });
    } catch (e) {
      await target?.abort?.().catch(() => undefined);
      setMessage(isAbort(e) ? { ok: false, text: 'Export cancelled.' } : { ok: false, text: `Export failed: ${(e as Error).message}` });
    } finally {
      setProgress(undefined);
      abort.current = undefined;
    }
  }

  const busy = !!progress;
  return (
    <fieldset className="field" disabled={busy}>
      <legend>Export</legend>
      <p className="help">
        Save slideshows, their photos, graphics and settings to a .zip file you can import on another computer.
      </p>
      <ul className="backup-list">
        {collections.map((c) => (
          <li key={c.id} className="field-inline">
            <input
              id={`${id}-${c.id}`}
              type="checkbox"
              checked={selected.has(c.id)}
              onChange={(e) => {
                const next = new Set(selected);
                if (e.target.checked) next.add(c.id);
                else next.delete(c.id);
                setSelected(next);
              }}
            />
            <label htmlFor={`${id}-${c.id}`}>
              {c.name} <span className="muted">({c.count})</span>
            </label>
          </li>
        ))}
      </ul>
      {!!usage?.originalBytes && (
        <div className="field-inline">
          <input id={`${id}-orig`} type="checkbox" checked={originals} onChange={(e) => setOriginals(e.target.checked)} />
          <label htmlFor={`${id}-orig`}>Include kept original files</label>
        </div>
      )}
      <div className="actions">
        <button type="button" className="btn" disabled={!selected.size} onClick={() => void exportNow()} data-testid="export-button">
          Export…
        </button>
        {plan && selected.size > 0 && <span className="muted">about {formatBytes(plan.bytes)}</span>}
      </div>
      {progress && (
        <div className="backup-progress">
          <progress max={progress.total} value={progress.done} aria-label="Export progress" />
          <button type="button" className="btn ghost small" onClick={() => abort.current?.abort()}>
            Cancel
          </button>
        </div>
      )}
      {message && (
        <p className={message.ok ? 'muted' : 'error-text'} role="status">
          {message.text}
        </p>
      )}
    </fieldset>
  );
}

function ImportSection({ onImported }: { onImported(result: ImportResult): void }) {
  const [open, setOpen] = useState<OpenBackup>();
  const [fits, setFits] = useState<ImportEstimate>();
  const [progress, setProgress] = useState<{ label: string; done: number; total: number }>();
  const [message, setMessage] = useState<{ ok: boolean; text: string }>();
  const abort = useRef<AbortController>(undefined);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => () => void open?.close(), [open]);

  async function choose(file: File | undefined) {
    if (!file) return;
    setMessage(undefined);
    try {
      const { openBackup } = await import('../backup/import');
      const o = await openBackup(file);
      setOpen(o);
      setFits(await checkImportFits(o.summary.bytesNeeded));
    } catch (e) {
      setMessage({ ok: false, text: (e as Error).message });
    }
  }

  async function importNow() {
    if (!open) return;
    const { importBackup } = await import('../backup/import');
    const ac = new AbortController();
    abort.current = ac;
    const labels = { graphics: 'Adding graphics', photos: 'Adding photos', slideshows: 'Creating slideshows' };
    try {
      const r = await importBackup(open, (p) => setProgress({ label: labels[p.phase], done: p.done, total: p.total }), ac.signal);
      setMessage({ ok: true, text: describe(r) });
      onImported(r);
    } catch (e) {
      setMessage({ ok: false, text: isAbort(e) ? 'Import cancelled. Nothing was imported.' : (e as Error).message });
    } finally {
      setProgress(undefined);
      abort.current = undefined;
      void open.close();
      setOpen(undefined);
    }
  }

  return (
    <fieldset className="field">
      <legend>Import</legend>
      <p className="help">
        Add slideshows from an export made on another computer. Photos already here are reused, not duplicated. Device
        settings such as import quality aren’t changed.
      </p>
      {!open && !progress && (
        <div className="actions">
          <button type="button" className="btn" onClick={() => fileInput.current?.click()}>
            Import from file…
          </button>
          <input
            ref={fileInput}
            type="file"
            accept=".zip,application/zip"
            className="visually-hidden"
            tabIndex={-1}
            onChange={(e) => {
              void choose(e.target.files?.[0]);
              e.target.value = '';
            }}
            data-testid="import-file"
          />
        </div>
      )}
      {open && !progress && <ImportSummary summary={open.summary} fits={fits} onImport={() => void importNow()} onCancel={() => setOpen(undefined)} />}
      {progress && (
        <div className="backup-progress">
          <span>
            {progress.label}… {progress.done} of {progress.total}
          </span>
          <progress max={progress.total || 1} value={progress.done} aria-label="Import progress" />
          <button type="button" className="btn ghost small" onClick={() => abort.current?.abort()}>
            Cancel
          </button>
        </div>
      )}
      {message && (
        <p className={message.ok ? 'muted' : 'error-text'} role="status" data-testid="import-message">
          {message.text}
        </p>
      )}
    </fieldset>
  );
}

function ImportSummary({
  summary: s,
  fits,
  onImport,
  onCancel,
}: {
  summary: BackupSummary;
  fits?: ImportEstimate;
  onImport(): void;
  onCancel(): void;
}) {
  const reused = s.photos - s.newPhotos;
  return (
    <div className="callout" data-testid="import-summary">
      <p>
        <strong>
          {s.collections.length} slideshow{s.collections.length === 1 ? '' : 's'}
        </strong>
        : {s.collections.map((c) => `${c.name} (${c.photos})`).join(', ') || 'none'}
      </p>
      <p>
        {s.photos} photo{s.photos === 1 ? '' : 's'}
        {reused > 0 && <> ({reused} already on this computer)</>}
        {s.graphics > 0 && <> · {s.graphics} graphic{s.graphics === 1 ? '' : 's'}</>} · needs about {formatBytes(s.bytesNeeded)}
      </p>
      {fits?.level === 'tight' && <p className="notice">This will use most of the remaining storage.</p>}
      {fits?.level === 'over' && (
        <p className="error-text">This probably won’t fit in the remaining storage. If it runs out, nothing is imported.</p>
      )}
      <div className="actions">
        <button type="button" className="btn primary" onClick={onImport} data-testid="import-confirm">
          Import
        </button>
        <button type="button" className="btn ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function describe(r: ImportResult): string {
  const parts = [`Imported ${r.collections.map((c) => `“${c.name}”`).join(', ') || 'no slideshows'}`];
  parts.push(`${r.photosAdded} new photo${r.photosAdded === 1 ? '' : 's'}`);
  if (r.photosReused) parts.push(`${r.photosReused} already here`);
  if (r.graphicsAdded) parts.push(`${r.graphicsAdded} graphic${r.graphicsAdded === 1 ? '' : 's'}`);
  if (r.skipped) parts.push(`${r.skipped} unreadable item${r.skipped === 1 ? '' : 's'} skipped`);
  return parts.join(' · ') + '.';
}
