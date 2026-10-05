/**
 * App-wide import queue. Batches (a file selection, a folder, a Google Photos
 * pick) run one after another through a shared worker pool, so users can keep
 * adding photos while an import is in progress.
 */
import { PipelinePool } from '../pipeline/pool';
import { runImport, type ImportHandle, type ImportOptions, type ImportProgress } from './importer';

export type Batch = Omit<ImportOptions, 'onProgress'> & {
  label: string;
  onDone?: (p: ImportProgress) => void;
};

export interface ImportServiceState {
  progress?: ImportProgress;
  currentLabel?: string;
  queued: { label: string; count: number }[];
  /** Last finished job (shown until dismissed or another one starts). */
  last?: ImportProgress & { label: string };
}

type Listener = (s: ImportServiceState) => void;

export class ImportService {
  private pool?: PipelinePool;
  private queue: Batch[] = [];
  private current?: { batch: Batch; handle: ImportHandle };
  private state: ImportServiceState = { queued: [] };
  private listeners = new Set<Listener>();
  private idleTimer?: ReturnType<typeof setTimeout>;

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    l(this.state);
    return () => this.listeners.delete(l);
  }

  get busy() {
    return !!this.current || this.queue.length > 0;
  }

  enqueue(batch: Batch) {
    this.queue.push(batch);
    this.update({});
    if (!this.current) void this.runNext();
  }

  /** Cancel the running batch and everything queued. Imported photos are kept. */
  cancelAll() {
    this.queue = [];
    this.current?.handle.cancel();
    this.update({});
  }

  dismissLast() {
    this.update({ last: undefined });
  }

  private async runNext() {
    const batch = this.queue.shift();
    if (!batch) {
      // Free worker memory when idle for a while.
      this.idleTimer = setTimeout(() => {
        if (!this.current) {
          this.pool?.destroy();
          this.pool = undefined;
        }
      }, 30_000);
      return;
    }
    clearTimeout(this.idleTimer);
    this.pool ??= new PipelinePool();
    const handle = runImport(this.pool, {
      ...batch,
      onProgress: (progress) => this.update({ progress, currentLabel: batch.label }),
    });
    this.current = { batch, handle };
    this.update({ last: undefined });
    const result = await handle.done;
    this.current = undefined;
    this.update({ progress: undefined, currentLabel: undefined, last: { ...result, label: batch.label } });
    batch.onDone?.(result);
    // A quota failure would fail every queued batch too; stop the queue.
    if (result.status === 'failed') this.queue = [];
    void this.runNext();
  }

  private update(patch: Partial<ImportServiceState>) {
    this.state = {
      ...this.state,
      ...patch,
      queued: this.queue.map((b) => ({ label: b.label, count: b.items.length })),
    };
    for (const l of this.listeners) l(this.state);
  }
}

export const importService = new ImportService();
