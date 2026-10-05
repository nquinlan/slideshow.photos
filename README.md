# Tessera: offline photo slideshows

A static web app (no backend). Build a photo collection from local files and Google Photos, then play it full-screen with the **Sliding Tiles** transition. Photos are processed on the device into screen-sized WebP copies, stored in IndexedDB, and play offline.

- Landing page: `/`, with no JavaScript apart from an inline service-worker registration.
- App: `/app`, built with React.
- "Tessera" is a placeholder product name. Change it in `src/site.ts`.

## Quick start

```bash
npm install
cp .env.example .env.local      # optional: Google Photos client id, site URL
npm run dev                     # http://localhost:4321 (the service worker is disabled in dev)
npm run build && npm run preview  # production build, service worker included
```

| Script | What it does |
|---|---|
| `npm run build` | `astro build`, then `scripts/build-sw.mjs` (Workbox precache service worker) |
| `npm test` | Unit tests (Vitest): storage, importer, format interface, engine, Escape logic |
| `npm run test:e2e` | Playwright tests against `astro preview`: import, offline reload, two-stage Escape. Run `npx playwright install` first |
| `npm run bench` | In-browser pipeline benchmark. Needs `bench/samples/`; see `bench/RESULTS.md` |
| `npm run spike` | Google Picker feasibility spike; see `spike/README.md` |
| `npm run gen:assets` | Regenerate icons, OG image and manifest |

Requires Node 22+.

## Google Cloud setup (OAuth client for the Picker)

1. In the [Google Cloud console](https://console.cloud.google.com/), create a project (or pick an existing one).
2. Under **APIs & Services → Library**, enable the **Google Photos Picker API**.
3. Under **APIs & Services → OAuth consent screen** (Google Auth Platform):
   - User type **External**. Fill in the app name, support email and authorized domain.
   - **Data access / Scopes:** add only `https://www.googleapis.com/auth/photospicker.mediaitems.readonly`.
   - While the app is in **Testing**, add your Google account under **Test users**. Publishing for everyone may require Google's verification for this scope.
4. Under **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type **Web application**.
   - **Authorized JavaScript origins:** `http://localhost:4321` (dev and preview), `http://localhost:5173` (spike), and your production origin, for example `https://slideshow.example.com`.
   - **Authorized redirect URIs:** none needed. The token model uses a popup.
5. Copy the **Client ID**, not the secret, into `.env.local` as `PUBLIC_GOOGLE_CLIENT_ID=...`, then rebuild. Never put the client secret anywhere in this project; the token flow doesn't use one.

**What users are asked for:** the single read-only scope above. It only covers items the user picks in Google's picker. Tokens last about 1 hour, are kept in memory only, and can't be silently refreshed without a backend. Imports are therefore bounded sessions: the app shows the time left, pauses if access expires, and offers "Sign in and resume".

### Google Photos download works browser-only

Verified with the spike on 2026-10-05 (`spike/README.md` has the details):

- The documented `Authorization: Bearer` download works directly from the browser, so no proxy or backend is needed.
- Sized renditions of HEIC originals arrive as JPEG.
- Picker sessions last 7 days, so an import can resume after the 1-hour token expires by signing in again.

## Architecture

```
src/
  pages/index.astro        landing page (static, SEO, JSON-LD)
  pages/app.astro          mounts the React app (client:only)
  pages/robots.txt.ts      robots.txt with the sitemap URL
  layouts/Base.astro       <head>: title, description, canonical, OG/Twitter, manifest
  app/
    pipeline/              image processing
      processor.ts         decode at target size → orient → re-encode WebP/JPEG (+ thumbnail, SHA-256)
      worker.ts, pool.ts   Web Worker pool (hardwareConcurrency-1, max 4), main-thread fallback
      sizing.ts            tiers, caps, estimates
    db/                    Dexie schema + repository (atomic per-photo writes, dedupe, GC)
    import/                importer (lanes, dedupe, quota handling, resumable jobs), local file
                           pickers (File System Access → <input> fallback), import queue, storage estimates
    google/                GIS token auth, Picker REST client, sized media download
    formats/               SlideshowFormat plugin interface, Sliding Tiles, Crossfade
    player/                engine (playlist, preload window, timing), full-screen/Escape, wake lock
    ui/                    React components
scripts/build-sw.mjs       Workbox generateSW over dist/
```

### Image pipeline

- **Decode at the target size.** Header dimensions (image-size) and EXIF orientation (exifr) are read first. Then `createImageBitmap(blob, {resizeWidth, resizeHeight, imageOrientation})` decodes straight to the target size, so a 48 MP photo never becomes a full-size bitmap. Browser quirks (whether EXIF is applied, whether resize happens before or after orientation) are detected once with a 2×1 probe JPEG, with manual canvas transforms as a fallback.
- **Re-encode and strip metadata.** Re-encoding from pixels via `OffscreenCanvas.convertToBlob` drops all metadata, including GPS. WebP is used when the encoder exists (feature-detected); otherwise JPEG. Quality is 0.82.
- **Tiers.** Screen-fit (default) is `min(max(screen) × DPR, 2560)`; High is 2560; 4K is 3840. Images are never upscaled. Thumbnails are 320 px.
- **Dedupe.**
  - `name|size|mtime` skips re-reading files that were already imported.
  - A SHA-256 of the source bytes catches the same photo under another name.
  - Google media ids catch repeat picks.
  - Choosing a higher tier and re-adding the same files upgrades photos in place.
- **HEIC.** Native decode where supported (Safari). Elsewhere, a lazily loaded `heic-to` (libheif, LGPL; see `THIRD_PARTY.md`).
- **Storage safety.**
  - `navigator.storage.persist()` is requested on the first import, and a meter shows `storage.estimate()`.
  - Imports of 25+ photos, or any import that's close to the quota, show an estimate first.
  - Each photo commits in one transaction, so a `QuotaExceededError` stops the job with everything imported so far intact.

### Playback

- **Canvas 2D.** Rationale is in `src/app/formats/slidingTiles.ts`. Each slide is composed once (contain or cover, over a blurred or black backdrop); each frame is then about 2 × tiles sub-rect blits.
- **Memory.** Only the current photo and the next 3 are decoded; others are `close()`d.
- **Full-screen and Escape.** Play starts full-screen. The first Esc is consumed by the browser and playback continues in the window, with a button to go full-screen again. The second Esc stops. Pages can't intercept the first Esc, and the Keyboard Lock API is deliberately not used; see the comments in `src/app/player/fullscreen.ts`.
- **Controls.** Space pauses. ←/→ and PageUp/PageDown navigate. F toggles full-screen. Swipe navigates on touch screens. The cursor and controls hide after 2.5 s idle. Screen Wake Lock is held while playing.
- **Reduced motion.** `prefers-reduced-motion` switches playback to Crossfade.

### Adding a slideshow format

Implement `SlideshowFormat` (`src/app/formats/types.ts`): `id`, `name`, `settingsSchema` and `create(ctx, settings)`, which returns `{ init, transition, resize, setRenderOptions, destroy }`. Then add it to `FORMATS` in `src/app/formats/index.ts`. The settings UI is generated from the schema, and values are stored per collection. The player core doesn't change; `tests/unit/engine.test.ts` registers a format at runtime to prove this.

## Offline and PWA

`scripts/build-sw.mjs` precaches the landing page, `/app`, all JS and CSS (including the image worker and HEIC decoder), icons and the manifest, about 3.6 MB. After the first visit, `/app` loads with no network. Photos live in IndexedDB, not in the service-worker cache.

New versions wait until the user clicks **Reload to update**, so the app never reloads mid-slideshow. "Add from Google Photos" is disabled with an explanation while offline.

### Deploying

Any static host works, for example Netlify, Cloudflare Pages, Vercel or GitHub Pages:

- Upload `dist/`.
- Set `SITE_URL` at build time.
- Make sure `/app` serves `app.html`. Most hosts do this by default ("clean URLs").
- Serve `sw.js` with `Cache-Control: no-cache`.

## Browser support

The targets are current Chrome, Edge, Safari and Firefox:

- **Folder selection:** `showDirectoryPicker` in Chromium; `<input webkitdirectory>` everywhere else. Drag-and-drop of files and folders also works.
- **No OffscreenCanvas in workers:** the pipeline falls back to the main thread, one image at a time.
- **Fullscreen API missing** (iPhone Safari): playback runs windowed, and a single Esc stops.

## Privacy

All processing is local. There are no analytics. Google code is loaded only after the user interacts with "Add from Google Photos". Stored copies carry no EXIF or GPS data.

## Testing status

- **Unit tests:** 47 passing (`npm test`).
- **E2E (Playwright):** 12/12 passing (2026-10-05). Covered:
  - In Chromium, Firefox and WebKit: import, dedupe, EXIF orientation, metadata stripping (GPS, camera and date verified by parsing the stored bytes), and playback.
  - In Chromium only: full-screen/Escape and offline.
- **Google Photos import:** verified end to end by hand on 2026-10-05 (sign-in → pick → import into the library), plus the browser-only download spike (`spike/README.md`).
- **Offline in Firefox and Safari: check by hand.** Playwright supports service workers only in Chromium. Its offline mode either bypasses the worker (Firefox) or aborts the page load (WebKit, [microsoft/playwright#42775](https://github.com/microsoft/playwright/issues/42775)). To check: load `/app` once, wait for "Ready to work offline", go offline, reload.
- **Benchmark:** sizes and speed measured in Chromium (`bench/RESULTS.md`). Memory is still to be measured.
- **Not yet run:** Lighthouse, and the memory benchmark (`npm run bench -- --only=0`).
