/**
 * Browser half of the pipeline benchmark. Driven by bench/run-bench.mjs via
 * Playwright: it calls window.runBench(config) and reads the result.
 */
import { PipelinePool } from '../src/app/pipeline/pool';
import { detectCapabilities } from '../src/app/pipeline/processor';
import type { OutputFormat } from '../src/app/pipeline/types';

interface BenchConfig {
  cap: number;
  quality: number;
  format: OutputFormat;
  poolSize?: number;
}

const log = document.getElementById('log')!;

async function runBench(cfg: BenchConfig) {
  const files: string[] = await (await fetch('/bench/samples/manifest.json')).json();
  const pool = new PipelinePool(cfg.poolSize);
  const rows: Record<string, unknown>[] = [];
  const errors: string[] = [];
  const t0 = performance.now();
  let next = 0;
  // Bounded feed: never more than 2× pool size files resident at once.
  const inflight = pool.size * 2;
  async function lane() {
    while (next < files.length) {
      const name = files[next++];
      const blob = await (await fetch('/bench/samples/' + encodeURIComponent(name))).blob();
      try {
        const r = await pool.process(blob, { cap: cfg.cap, quality: cfg.quality, format: cfg.format });
        rows.push({
          name,
          srcBytes: blob.size,
          outBytes: r.display.size,
          thumbBytes: r.thumb.size,
          width: r.width,
          height: r.height,
          srcW: r.sourceWidth,
          srcH: r.sourceHeight,
          outType: r.display.type,
          ms: r.timings.total,
          decoder: r.decoder,
        });
      } catch (e) {
        errors.push(`${name}: ${(e as Error).message}`);
      }
      log.textContent = `${cfg.cap}px ${cfg.format} q${cfg.quality}: ${rows.length + errors.length}/${files.length}`;
    }
  }
  await Promise.all(Array.from({ length: inflight }, lane));
  const wallMs = performance.now() - t0;
  pool.destroy();
  return { cfg: { ...cfg, poolSize: pool.size }, wallMs, rows, errors };
}

Object.assign(window, { runBench, detectCapabilities });
log.textContent = 'ready';
