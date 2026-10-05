/**
 * Post-build: generate the Workbox service worker over the static output.
 *
 * Precaches the whole app shell (landing page, /app, JS/CSS chunks incl. the
 * lazily-loaded image worker and HEIC decoder, icons, manifest) so that after
 * the first visit /app loads and works with no network. Photos themselves
 * live in IndexedDB, not the SW cache. Google sign-in/API calls are never
 * cached.
 *
 * Update strategy: skipWaiting is OFF – a new version waits until the user
 * clicks "Reload to update" in the app (it never reloads mid-slideshow).
 */
import { generateSW } from 'workbox-build';
import fs from 'node:fs';
import path from 'node:path';

const outDir = path.resolve(process.env.OUT_DIR ?? 'dist');

// Vite emits the HEIC decoder twice: once for the image worker and once for the
// rare main-thread fallback (old Safari, which decodes HEIC natively anyway).
// Precache only the copy the worker imports.
const astroDir = path.join(outDir, '_astro');
const workerSrc = fs
  .readdirSync(astroDir)
  .filter((f) => /^worker[-.].*\.js$/.test(f))
  .map((f) => fs.readFileSync(path.join(astroDir, f), 'utf8'))
  .join('\n');
const unusedHeic = fs
  .readdirSync(astroDir)
  .filter((f) => f.startsWith('heic-to') && !workerSrc.includes(f))
  .map((f) => `_astro/${f}`);

const { count, size, warnings } = await generateSW({
  globDirectory: outDir,
  globPatterns: ['**/*.{html,js,mjs,css,svg,png,webmanifest,wasm,txt,xml,ico,woff2}'],
  globIgnores: ['sw.js', 'workbox-*.js', 'spike/**', 'og.png', ...unusedHeic],
  swDest: path.join(outDir, 'sw.js'),
  // The HEIC decoder chunk (libheif WASM inlined) is ~3 MB; precache it so HEIC import works offline.
  maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
  // Hashed Astro/Vite assets don't need Workbox's revision query.
  dontCacheBustURLsMatching: /\/_astro\//,
  // Workbox's precache route resolves /app → /app.html (cleanURLs, on by default)
  // and / → /index.html. Ignore query strings when matching.
  directoryIndex: 'index.html',
  ignoreURLParametersMatching: [/.*/],
  cleanupOutdatedCaches: true,
  clientsClaim: true,
  skipWaiting: false,
  inlineWorkboxRuntime: true,
  sourcemap: false,
});

for (const w of warnings) console.warn('[sw]', w);
console.log(`[sw] precached ${count} files, ${(size / 1024 / 1024).toFixed(2)} MB → ${path.join(outDir, 'sw.js')}`);
