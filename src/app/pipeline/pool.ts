/**
 * Fixed-size Web Worker pool for the image pipeline.
 *
 * Each worker processes one image at a time, so peak memory is bounded by
 * `size × (one source file + one decoded derivative)` no matter how many
 * photos are queued. Callers should still feed the queue lazily (see
 * import/importer.ts) rather than enqueueing 1,000 files at once, so that
 * cancellation is cheap.
 *
 * If the browser can't run the pipeline in a worker (no OffscreenCanvas in
 * workers, e.g. older Safari), the pool permanently falls back to running it
 * on the main thread, one image at a time.
 */
import type { ProcessOptions, ProcessResult, WorkerResponse } from './types';

export function defaultPoolSize(): number {
  const hc = globalThis.navigator?.hardwareConcurrency ?? 2;
  return Math.max(1, Math.min(4, hc - 1));
}

interface Task {
  jobId: number;
  blob: Blob;
  options: ProcessOptions;
  resolve: (r: ProcessResult) => void;
  reject: (e: Error) => void;
  signal?: AbortSignal;
}

interface Slot {
  worker: Worker;
  task?: Task;
}

export class AbortError extends Error {
  constructor() {
    super('Aborted');
    this.name = 'AbortError';
  }
}

export class PipelinePool {
  private slots: Slot[] = [];
  private queue: Task[] = [];
  private nextId = 1;
  private mainThread = false;
  private mainBusy = false;
  private destroyed = false;
  private everSucceeded = false;

  constructor(
    readonly size = defaultPoolSize(),
    private workerFactory: () => Worker = () =>
      new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'image-pipeline' }),
  ) {}

  get pending(): number {
    return this.queue.length + this.slots.filter((s) => s.task).length + (this.mainBusy ? 1 : 0);
  }

  process(blob: Blob, options: ProcessOptions, signal?: AbortSignal): Promise<ProcessResult> {
    if (this.destroyed) return Promise.reject(new Error('Pool destroyed'));
    if (signal?.aborted) return Promise.reject(new AbortError());
    return new Promise<ProcessResult>((resolve, reject) => {
      const task: Task = { jobId: this.nextId++, blob, options, resolve, reject, signal };
      signal?.addEventListener(
        'abort',
        () => {
          const i = this.queue.indexOf(task);
          if (i >= 0) {
            this.queue.splice(i, 1);
            reject(new AbortError());
          }
          // In-flight tasks finish in the worker; their result is dropped by the caller.
        },
        { once: true },
      );
      this.queue.push(task);
      this.pump();
    });
  }

  destroy() {
    this.destroyed = true;
    for (const s of this.slots) {
      s.worker.terminate();
      s.task?.reject(new AbortError());
    }
    for (const t of this.queue) t.reject(new AbortError());
    this.slots = [];
    this.queue = [];
  }

  private pump() {
    if (this.mainThread) return void this.pumpMain();
    while (this.queue.length) {
      let slot = this.slots.find((s) => !s.task);
      if (!slot && this.slots.length < this.size) slot = this.spawn();
      if (!slot) return;
      const task = this.queue.shift()!;
      slot.task = task;
      slot.worker.postMessage({ jobId: task.jobId, blob: task.blob, options: task.options });
    }
  }

  private spawn(): Slot {
    const slot: Slot = { worker: this.workerFactory() };
    slot.worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const task = slot.task;
      slot.task = undefined;
      if (!task || task.jobId !== e.data.jobId) return this.pump();
      if (e.data.ok) {
        this.everSucceeded = true;
        task.resolve(e.data.result);
      }
      else if (e.data.code === 'unsupported') {
        // Retry this and everything after it on the main thread.
        this.switchToMainThread();
        this.queue.unshift(task);
      } else task.reject(new Error(e.data.error));
      this.pump();
    };
    slot.worker.onerror = (ev) => {
      // Worker crashed (e.g. OOM on a huge image) or failed to load as a module.
      ev.preventDefault?.();
      const task = slot.task;
      slot.worker.terminate();
      this.slots = this.slots.filter((s) => s !== slot);
      if (task) {
        if (this.slots.length === 0 && !this.everSucceeded) {
          this.switchToMainThread();
          this.queue.unshift(task);
        } else task.reject(new Error(ev.message || 'Image worker crashed'));
      }
      this.pump();
    };
    this.slots.push(slot);
    return slot;
  }

  private switchToMainThread() {
    if (this.mainThread) return;
    this.mainThread = true;
    for (const s of this.slots) s.worker.terminate();
    this.slots = [];
  }

  private async pumpMain() {
    if (this.mainBusy) return;
    const { processImage } = await import('./processor');
    while (this.queue.length && !this.destroyed) {
      const task = this.queue.shift()!;
      this.mainBusy = true;
      try {
        task.resolve(await processImage(task.blob, task.options));
      } catch (e) {
        task.reject(e as Error);
      } finally {
        this.mainBusy = false;
      }
      // Yield so the UI stays responsive between images.
      await new Promise((r) => setTimeout(r, 0));
    }
  }
}
