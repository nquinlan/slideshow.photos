# Tessera: offline photo slideshows

A static web app (no backend). Build a photo collection from local files and Google Photos, then play it full-screen as a **Sliding Panels** collage, **Floating** photos, or a **Crossfade**. Photos are processed on the device into screen-sized WebP copies, stored in IndexedDB, and play offline.

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

**What users are asked for:** the single read-only scope above. It only covers items the user picks in Google's picker. Tokens last about 1 hour, are kept in memory only, and can't be silently refreshed without a backend. If access expires mid-import, the import pauses and offers "Sign in and resume". There is no countdown; it only matters if an import runs that long.

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
    formats/               plugin interface; Sliding Panels (panels/ layout, matching, motion), Floating, Crossfade
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

- **Formats.** All formats draw on Canvas 2D; each one's file comments explain its rendering approach.
  - **Sliding Panels** (default): a collage of up to 6 photos in a random layout, matched to panel shape and cover-cropped. It holds still for the interval, then the panels slide out to black, there's a short black beat, and a new layout slides in (about 0.9 s total). `→` skips ahead; `←` goes back through earlier layouts.
  - **Floating:** photos drift across the screen at three depths, with parallax. Each photo is pre-rendered once into a sprite, so each frame is one `drawImage` per photo. `→` brings in another photo.
  - **Crossfade:** one photo at a time.
- **No upscaling.**
  - **Crossfade:** photos are never drawn larger than their original resolution. A small photo is shown centred at its native size instead.
  - **Floating:** photos are capped at their original size.
  - **Sliding Panels:** panels are always filled edge to edge. Each panel only gets a photo big enough to fill it, from anywhere in the collection. A photo is enlarged only when nothing in the collection is big enough.
- **Memory.**
  - Crossfade keeps only the current photo and the next 3 decoded.
  - Sliding Panels and Floating decode each photo only as large as the area it fills.
  - Everything is `close()`d as soon as it leaves the screen.
- **Full-screen and Escape.** Play starts full-screen. The first Esc is consumed by the browser and playback continues in the window, with a button to go full-screen again. The second Esc stops. Pages can't intercept the first Esc, and the Keyboard Lock API is deliberately not used; see the comments in `src/app/player/fullscreen.ts`.
- **Controls.** Space pauses. ←/→ and PageUp/PageDown navigate. F toggles full-screen. Swipe navigates on touch screens. The cursor and controls hide after 2.5 s idle. Screen Wake Lock is held while playing.
- **Reduced motion.** `prefers-reduced-motion` switches playback to Crossfade.

### Logos and sponsor graphics

Under **Logos & graphics** in the sidebar you can upload PNG, JPEG, SVG, WebP, GIF, AVIF, BMP or HEIC/HEIF files (up to 25 MB each).

- **Stored byte-for-byte.** Graphics are never resized, re-encoded or stripped. The one exception is HEIC/HEIF, which most browsers can't display: it's converted once, losslessly, to PNG. An SVG missing `width`/`height` is drawn from an in-memory copy with those attributes added, because Firefox can't draw it to a canvas otherwise. The stored file is never changed.
- **Shown whole.** A graphic is always contained, never cropped. It sits on its **background colour** at its **size within its space** (default 80%). SVGs scale freely; bitmaps (PNG, JPEG, etc.) are never enlarged past their native size. JPEGs follow their EXIF rotation. Animated GIF/WebP files animate as a corner logo but show their first frame in the slideshow. An SVG loaded as an image can't run scripts.
- **Share per collection.** Each collection sets how often each graphic appears: 0–50%, with all graphics together capped at 90%.
  - **Crossfade:** % of slides.
  - **Sliding Panels:** % of layouts.
  - **Floating:** % of drifting items.

  Appearances are spaced evenly rather than at random: 10% means about every 10th step.
- **Mixed in or full screen** (per graphic):
  - **Mixed in:** in Sliding Panels the graphic takes the panel where it shows largest; in Floating it drifts by as a card in its colour.
  - **Full screen** (e.g. a ready-made sponsor slide): it takes the whole screen. In Floating the drift pauses while it fades in, holds for the interval, and fades out.
- **Corner logo** (per collection): one graphic stays on screen over every format. You choose the corner, size, opacity and an optional plate in its colour.

### Moving a library to another computer

**Settings → Move to another computer.**

- **Export** saves the chosen slideshows to a `.zip`, with an estimated size shown first. It contains:
  - `manifest.json` with slideshow settings, order, and photo and graphic details;
  - the stored photo copies and thumbnails;
  - the graphics, byte-for-byte;
  - kept originals, if you choose to include them.

  In Chrome and Edge it streams straight to the file you choose; other browsers build the file, then download it. Zip64 is used, so exports over 4 GB work.
- **Import** shows what's inside first: the slideshows, how many photos are new to this computer, and the storage needed. Then it adds them:
  - Photos already on the device are reused rather than duplicated, and graphics are matched by their exact bytes.
  - Slideshows are added as new collections in their original order, renamed if the name is taken.
  - The file is treated as untrusted: only listed paths are read and every setting is validated.
  - If the import fails or is cancelled, everything it added is removed.
  - Device settings such as import quality aren't changed.

### Adding a slideshow format

Implement `SlideshowFormat` in `src/app/formats/types.ts` as one of two kinds:

- **`kind: 'transition'`** for formats that animate one photo into the next. The engine owns the playlist, timing and preloading. `create(ctx, settings)` returns `{ init, transition, resize, setRenderOptions, destroy }`.
- **`kind: 'scene'`** for formats with several photos on screen or their own rhythm. `create(ctx, settings)` gets:
  - a `PhotoLibrary`, which lists every photo's size and decodes any photo no larger than the box you pass;
  - the timing settings and a random source;
  - an `onStatus` callback.

  It returns `{ start, pause, resume, next, prev, resize, setRenderOptions, setTiming, destroy }`.

Every format also declares:
- `settingsSchema`: the settings UI is generated from it, and values are stored per collection;
- `uses`: which global settings apply (interval label, transition speed, shuffle, fit, backdrop). The UI hides the rest.

Then add the format to `FORMATS` in `src/app/formats/index.ts`. The player core doesn't change; `tests/unit/engine.test.ts` registers both kinds at runtime to prove this.

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
