/**
 * Import runner shared by local files and Google Photos.
 *
 * - Items are pulled lazily from the list by a fixed number of "lanes", so
 *   only ~pool.size source files are ever resident in memory at once.
 * - Cheap dedupe first (quickKey / Google id) to skip reading bytes; content
 *   hash dedupe after processing.
 * - Each photo is committed atomically; a QuotaExceededError stops the job
 *   with everything imported so far intact.
 * - Progress is persisted to the `jobs` table so an interrupted import can be
 *   reported and resumed (re-selecting the same files skips finished ones;
 *   Google jobs keep the remaining media ids).
 */
import { getDB, isQuotaError, uid, type ImportJob, type JobStatus, type PhotoSource } from '../db/db';
import { addProcessedPhoto, canUpgrade, findPhotoByGoogleId, findPhotoByQuickKey, linkPhoto } from '../db/repo';
import { AbortError, type PipelinePool } from '../pipeline/pool';
import { DEFAULT_QUALITY, longEdgeCap, type QualityTier } from '../pipeline/sizing';

export interface ImportItem {
  /** Stable id within this job (e.g. file path or Google media id). */
  key: string;
  name: string;
  quickKey?: string;
  googleId?: string;
  /** Source size in bytes when known up front (for estimates). */
  size?: number;
  /**
   * The original photo's pixel size when the bytes we load are a pre-sized
   * rendition (Google Photos), so playback knows how far it may scale up.
   */
  originalSize?: { width: number; height: number };
  /** Fetch the source bytes. `cap` lets remote sources request a pre-sized rendition. */
  load(signal: AbortSignal, cap: number): Promise<Blob>;
}

/** An error that will affect every remaining item (e.g. downloads blocked): stop the job. */
export class FatalImportError extends Error {}

/** Thrown by an ImportItem.load when the Google token/URLs expired: the job pauses. */
export class AuthExpiredError extends Error {
  constructor(message = 'Google sign-in expired') {
    super(message);
    this.name = 'AuthExpiredError';
  }
}

export type ItemOutcome = 'imported' | 'upgraded' | 'duplicate' | 'failed';

export interface ImportProgress {
  jobId: string;
  collectionId: string;
  source: PhotoSource;
  status: JobStatus;
  total: number;
  imported: number;
  /** Existing photos re-processed at a higher quality tier. */
  upgraded: number;
  skipped: number;
  failed: number;
  active: { key: string; name: string; stage: 'reading' | 'processing' | 'saving' }[];
  recent: { name: string; outcome: ItemOutcome; error?: string }[];
  error?: string;
  /** Keys not yet completed when the job stopped (for resume). */
  remainingKeys?: string[];
}

export interface ImportOptions {
  collectionId: string;
  source: PhotoSource;
  items: ImportItem[];
  tier: QualityTier;
  keepOriginals: boolean;
  /** Parallel lanes; defaults to pool size + 1 so reading overlaps processing. */
  lanes?: number;
  /** Extra data to persist on the job record (e.g. the Google session). */
  jobExtra?: Partial<ImportJob>;
  onProgress?: (p: ImportProgress) => void;
}

export interface ImportHandle {
  readonly jobId: string;
  cancel(): void;
  done: Promise<ImportProgress>;
}

const RECENT_MAX = 30;

export function runImport(pool: PipelinePool, opts: ImportOptions): ImportHandle {
  const jobId = uid();
  const ac = new AbortController();
  const cap = longEdgeCap(opts.tier);
  const p: ImportProgress = {
    jobId,
    collectionId: opts.collectionId,
    source: opts.source,
    status: 'running',
    total: opts.items.length,
    imported: 0,
    upgraded: 0,
    skipped: 0,
    failed: 0,
    active: [],
    recent: [],
  };
  const completed = new Set<string>();
  let stopReason: { status: JobStatus; error?: string } | undefined;

  const emit = () => opts.onProgress?.({ ...p, active: [...p.active], recent: [...p.recent] });
  const record = (name: string, outcome: ItemOutcome, error?: string) => {
    p.recent.unshift({ name, outcome, error });
    if (p.recent.length > RECENT_MAX) p.recent.pop();
  };

  const jobCreated = Date.now();
  let lastPersist = 0;
  const persist = async (force = false) => {
    const now = Date.now();
    if (!force && now - lastPersist < 750) return;
    lastPersist = now;
    const remaining = opts.items.filter((i) => !completed.has(i.key)).map((i) => i.key);
    const job: ImportJob = {
      id: jobId,
      collectionId: opts.collectionId,
      source: opts.source,
      status: p.status,
      createdAt: jobCreated,
      updatedAt: now,
      total: p.total,
      imported: p.imported,
      skipped: p.skipped,
      failed: p.failed,
      tier: opts.tier,
      error: p.error,
      ...opts.jobExtra,
    };
    if (job.google) job.google = { ...job.google, remainingIds: remaining };
    try {
      await getDB().jobs.put(job);
    } catch {
      /* job bookkeeping must never break an import (e.g. when quota is full) */
    }
  };
  const stop = (status: JobStatus, error?: string) => {
    if (stopReason) return;
    stopReason = { status, error };
    ac.abort();
  };

  async function processItem(item: ImportItem) {
    const signal = ac.signal;
    const active: ImportProgress['active'][number] = { key: item.key, name: item.name, stage: 'reading' };
    p.active.push(active);
    emit();
    try {
      // 1. Cheap dedupe without touching bytes (unless a higher tier was requested).
      const known =
        (item.quickKey && (await findPhotoByQuickKey(item.quickKey))) ||
        (item.googleId && (await findPhotoByGoogleId(item.googleId))) ||
        undefined;
      if (known && !canUpgrade(known, cap)) {
        await linkPhoto(opts.collectionId, known.id);
        p.skipped++;
        record(item.name, 'duplicate');
        completed.add(item.key);
        return;
      }
      // 2. Read + process.
      const blob = await item.load(signal, cap);
      if (signal.aborted) return;
      active.stage = 'processing';
      emit();
      const r = await pool.process(blob, { cap, quality: DEFAULT_QUALITY }, signal);
      if (signal.aborted) return;
      // 3. Commit atomically.
      active.stage = 'saving';
      emit();
      const res = await addProcessedPhoto(
        opts.collectionId,
        {
          contentHash: r.contentHash,
          quickKey: item.quickKey,
          googleId: item.googleId,
          source: opts.source,
          name: item.name,
          width: r.width,
          height: r.height,
          sourceWidth: Math.max(r.sourceWidth, item.originalSize?.width ?? 0),
          sourceHeight: Math.max(r.sourceHeight, item.originalSize?.height ?? 0),
          format: r.format,
          tier: opts.tier,
          cap,
          displayBytes: r.display.size,
          thumbBytes: r.thumb.size,
          originalBytes: opts.keepOriginals ? blob.size : undefined,
          takenAt: r.takenAt,
        },
        { display: r.display, thumb: r.thumb, original: opts.keepOriginals ? blob : undefined },
      );
      if (res.status === 'added') {
        p.imported++;
        record(item.name, 'imported');
      } else if (res.status === 'upgraded') {
        p.upgraded++;
        record(item.name, 'upgraded');
      } else {
        p.skipped++;
        record(item.name, 'duplicate');
      }
      completed.add(item.key);
    } catch (e) {
      if (e instanceof AbortError || signal.aborted) return;
      if (e instanceof AuthExpiredError) return stop('paused', e.message);
      if (e instanceof FatalImportError) return stop('failed', e.message);
      if (isQuotaError(e)) {
        return stop(
          'failed',
          'Storage is full. Photos imported so far are safe. Free up space (remove photos or delete kept originals) or choose a smaller quality tier, then add the remaining photos again.',
        );
      }
      p.failed++;
      completed.add(item.key);
      record(item.name, 'failed', (e as Error).message);
    } finally {
      p.active = p.active.filter((a) => a !== active);
      emit();
      void persist();
    }
  }

  const done = (async () => {
    await persist(true);
    emit();
    let next = 0;
    const lanes = opts.lanes ?? pool.size + 1;
    await Promise.all(
      Array.from({ length: Math.max(1, lanes) }, async () => {
        while (!ac.signal.aborted && next < opts.items.length) await processItem(opts.items[next++]);
      }),
    );
    p.status = stopReason?.status ?? 'done';
    p.error = stopReason?.error;
    p.active = [];
    p.remainingKeys = opts.items.filter((i) => !completed.has(i.key)).map((i) => i.key);
    await persist(true);
    emit();
    return { ...p };
  })();

  return {
    jobId,
    cancel: () => stop('cancelled'),
    done,
  };
}

/** On startup: jobs left "running" were interrupted by a reload/crash. */
export async function markInterruptedJobs(): Promise<ImportJob[]> {
  const db = getDB();
  const running = await db.jobs.where('status').equals('running').toArray();
  for (const j of running) await db.jobs.update(j.id, { status: 'interrupted', updatedAt: Date.now() });
  return db.jobs.where('status').anyOf('interrupted', 'paused').toArray();
}

export async function dismissJob(id: string) {
  await getDB().jobs.delete(id);
}
