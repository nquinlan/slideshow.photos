/**
 * Node half of the pipeline benchmark.
 *   npm run bench               # chromium, all configs
 *   npm run bench -- --browsers=chromium,webkit,firefox
 * Writes bench/out/results.json and prints a markdown summary.
 */
import { build } from 'vite';
import { chromium, webkit, firefox } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const samplesDir = path.join(root, 'bench/samples');
const files = fs.readdirSync(samplesDir).filter((f) => /\.(jpe?g|png|heic|webp)$/i.test(f)).sort();
fs.writeFileSync(path.join(samplesDir, 'manifest.json'), JSON.stringify(files));

const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1] ?? d;
const browsers = arg('browsers', 'chromium').split(',');
const only = arg('only', '');

const CONFIGS = [
  { cap: 1920, quality: 0.82, format: 'webp' }, // first = memory-profiled run (≈ Screen-fit on a 1080p display)
  { cap: 1920, quality: 0.80, format: 'webp' },
  { cap: 1920, quality: 0.85, format: 'webp' },
  { cap: 2560, quality: 0.80, format: 'webp' },
  { cap: 2560, quality: 0.85, format: 'webp' },
  { cap: 3840, quality: 0.82, format: 'webp' },
  { cap: 1920, quality: 0.85, format: 'jpeg' },
  { cap: 2560, quality: 0.85, format: 'jpeg' },
];

// Build the bench page once, then serve it through Playwright request routing on a fake
// https origin. No local port is bound (works inside restrictive sandboxes) and the
// origin is a secure context, so crypto.subtle / OffscreenCanvas behave as in production.
const outDir = path.join(root, 'bench/out/dist');
await build({
  root,
  configFile: false,
  logLevel: 'warn',
  base: '/',
  build: { outDir, emptyOutDir: true, rollupOptions: { input: path.join(root, 'bench/index.html') } },
  worker: { format: 'es' },
});
const ORIGIN = 'https://bench.test';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.heic': 'image/heic', '.webp': 'image/webp' };
async function serve(context) {
  await context.route(`${ORIGIN}/**`, (route) => {
    const url = new URL(route.request().url());
    const rel = decodeURIComponent(url.pathname);
    const file = rel.startsWith('/bench/samples/') ? path.join(root, rel) : path.join(outDir, rel);
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return route.fulfill({ status: 404 });
    route.fulfill({ status: 200, body: fs.readFileSync(file), headers: { 'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream' } });
  });
}

/** Sum RSS (MB) of every process whose command line points into our Playwright browsers dir. */
function sampleRss() {
  try {
    const out = execFileSync('ps', ['-axo', 'rss=,command='], { encoding: 'utf8', maxBuffer: 1 << 24 });
    let total = 0, max = 0;
    for (const line of out.split('\n')) {
      if (!line.includes('.playwright-browsers')) continue;
      const kb = parseInt(line.trim(), 10) || 0;
      total += kb;
      max = Math.max(max, kb);
    }
    return { total: total / 1024, max: max / 1024 };
  } catch {
    return { total: NaN, max: NaN };
  }
}

const results = [];
for (const name of browsers) {
  const type = { chromium, webkit, firefox }[name];
  const configs = only ? CONFIGS.filter((_, i) => only.split(',').includes(String(i))) : CONFIGS;
  for (let i = 0; i < configs.length; i++) {
    const cfg = configs[i];
    // Fresh browser per config so memory numbers are not polluted by previous runs.
    const browser = await type.launch();
    const context = await browser.newContext();
    await serve(context);
    const page = await context.newPage();
    page.on('pageerror', (e) => console.error('[page]', e.message));
    page.on('console', (m) => m.type() === 'error' && console.error('[console]', m.text()));
    await page.goto(`${ORIGIN}/bench/index.html`);
    await page.waitForFunction(() => document.getElementById('log')?.textContent === 'ready', null, { timeout: 60000 });
    const caps = await page.evaluate(() => window.detectCapabilities());
    const baseline = sampleRss();
    const samples = [];
    const timer = setInterval(() => samples.push(sampleRss()), 150);
    const res = await page.evaluate((c) => window.runBench(c), cfg);
    clearInterval(timer);
    await browser.close();
    const n = res.rows.length;
    const sum = (k) => res.rows.reduce((a, r) => a + r[k], 0);
    const sorted = res.rows.map((r) => r.ms).sort((a, b) => a - b);
    const peak = Math.max(...samples.map((s) => s.total));
    const q = Math.floor(samples.length / 4) || 1;
    const avg = (arr) => arr.reduce((a, s) => a + s.total, 0) / arr.length;
    const summary = {
      browser: name,
      cfg: res.cfg,
      caps,
      photos: n,
      errors: res.errors,
      avgSrcKB: sum('srcBytes') / n / 1024,
      avgDisplayKB: sum('outBytes') / n / 1024,
      avgThumbKB: sum('thumbBytes') / n / 1024,
      bytesPerPixel: sum('outBytes') / res.rows.reduce((a, r) => a + r.width * r.height, 0),
      projected1000MB: ((sum('outBytes') + sum('thumbBytes')) / n) * 1000 / 1e6,
      wallSec: res.wallMs / 1000,
      throughputMsPerPhoto: res.wallMs / n,
      workerMsMedian: sorted[Math.floor(n / 2)],
      workerMsP95: sorted[Math.floor(n * 0.95)],
      baselineRssMB: baseline.total,
      peakRssMB: peak,
      rssFirstQuarterMB: avg(samples.slice(0, q)),
      rssLastQuarterMB: avg(samples.slice(-q)),
      decoders: res.rows.reduce((a, r) => ((a[r.decoder] = (a[r.decoder] || 0) + 1), a), {}),
      outTypes: [...new Set(res.rows.map((r) => r.outType))],
      orientationCheck: res.rows
        .filter((r) => r.name.startsWith('exif'))
        .map((r) => `${r.name.slice(0, 5)} src ${r.srcW}x${r.srcH} -> ${r.width}x${r.height}`),
    };
    results.push(summary);
    console.log(
      `${name.padEnd(8)} ${String(cfg.cap).padStart(4)}px ${cfg.format} q${cfg.quality.toFixed(2)} | ` +
        `display ${summary.avgDisplayKB.toFixed(0)} KB, thumb ${summary.avgThumbKB.toFixed(1)} KB, ` +
        `1000 photos ≈ ${summary.projected1000MB.toFixed(0)} MB | ${summary.throughputMsPerPhoto.toFixed(0)} ms/photo wall ` +
        `(worker median ${summary.workerMsMedian.toFixed(0)} ms) | peak RSS ${peak.toFixed(0)} MB ` +
        `(baseline ${baseline.total.toFixed(0)}) | errors ${res.errors.length}`,
    );
  }
}
fs.mkdirSync(path.join(root, 'bench/out'), { recursive: true });
fs.writeFileSync(path.join(root, 'bench/out/results.json'), JSON.stringify(results, null, 2));
