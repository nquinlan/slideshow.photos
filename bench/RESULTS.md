# Milestone 0: image pipeline benchmark

## What was measured

- **Samples:** 207 real photographs from Lorem Picsum (Unsplash): 120 at 4032×3024 and 50 at 3024×4032 (12 MP phone sizes), 30 at 5000×3333 (16.7 MP), 6 copies with EXIF orientation 6, 8 or 3, and 1 PNG. Sources average 1.0 MB.
- **Size (measured):** `bench/size-proxy.mjs` runs each config through sharp. sharp uses libwebp and libjpeg-turbo, the same encoder families behind Chromium's `canvas.convertToBlob`, with the same caps, fit-inside resize and 320 px thumbnails.
- **Speed and memory (not yet measured):** `bench/run-bench.mjs` runs the real worker pool in Playwright browsers and samples browser process RSS. It could not run in the sandbox where this was built, because browsers can't launch there. Run `npm run bench` locally and paste the results below.

## Derivative size (measured, sharp proxy, 207 photos)

| Long-edge cap | Format | Quality | Avg display | Avg thumb | Bytes/px | **1,000 photos** |
|---|---|---|---|---|---|---|
| 1920 | WebP | 0.80 | 225 KB | 9.8 KB | 0.085 | 240 MB |
| 1920 | WebP | **0.82** | **246 KB** | 9.8 KB | 0.092 | **261 MB** |
| 1920 | WebP | 0.85 | 283 KB | 9.8 KB | 0.106 | 300 MB |
| 2560 | WebP | 0.80 | 343 KB | 9.8 KB | 0.073 | 362 MB |
| 2560 | WebP | **0.82** | **375 KB** | 9.8 KB | 0.080 | **395 MB** |
| 2560 | WebP | 0.85 | 432 KB | 9.8 KB | 0.092 | 453 MB |
| 2880 | WebP | 0.82 | 442 KB | 9.8 KB | 0.074 | 463 MB |
| 3840 | WebP | 0.82 | 643 KB | 9.8 KB | 0.060 | 668 MB |
| 1920 | JPEG | 0.85 | 385 KB | 12.9 KB | 0.145 | 408 MB |
| 2560 | JPEG | 0.85 | 615 KB | 13.1 KB | 0.130 | 644 MB |

For comparison, keeping originals averaged 1.0 MB per photo for these re-encoded samples, and is typically 2.5–5 MB for real phone photos.

## Conclusions and defaults

- **Default cap: Screen-fit = `min(max(w, h) × DPR, 2560)`.**
  - A 1080p display gets 1920 px, about **260 MB per 1,000 photos**.
  - A Retina laptop or 1440p display gets 2560 px, about **395 MB per 1,000 photos**.
  - Both are within the "hundreds of MB" budget, and neither shows visible softening at its own resolution, because the stage canvas is never larger than the screen.
- **Default quality: WebP 0.82.**
  - Going from 0.80 to 0.85 costs **+15–25%** in bytes, which is hard to see in a moving slideshow.
  - 0.82 sits mid-range and keeps 2560 px under 400 MB per 1,000 photos.
- **The JPEG fallback costs about 1.6× WebP** at equal settings. WebP encoding is feature-detected per browser; older Safari versions fall back to JPEG.
- **4K (3840) is opt-in.** It costs about 2.5× Screen-fit (≈670 MB per 1,000 photos) and only helps on 4K screens.
- **Thumbnails cost about 10 KB each**, roughly 10 MB per 1,000 photos.
- **Pre-import estimates use 0.12 bytes/px for WebP and 0.19 for JPEG.** That is about 30% more pessimistic than measured, because real camera photos carry more sensor noise than Picsum's re-encoded JPEGs, and noise compresses worse.

## In-browser results (measured, Chromium, 2026-10-05)

`npm run bench` on the developer's Mac. Pool size 4 (`hardwareConcurrency - 1`, max 4). 208 files: the 207 JPEG/PNG samples plus one HEIC.

- **Errors:** 0 in every config.
- **Decoders:** 207 files took `native-resize`, so they were decoded straight at the target size and the full-resolution bitmap never existed. The HEIC took `heic-wasm`, the lazily loaded decoder, which ran successfully inside the worker.
- **Detected capabilities:** `appliesExif: true`, `resize: oriented`, `webp: true`, `offscreen: true`.
- **EXIF orientation:**
  - The orientation-6 and orientation-8 samples are stored as 3024×4032 pixels and came out correctly as 4032×3024 → 1920×1440.
  - The orientation-3 samples were also oriented correctly.

| Cap | Format | Quality | Avg display | 1,000 photos | Wall time per photo (4 workers) | Worker median / p95 |
|---|---|---|---|---|---|---|
| 1920 | WebP | 0.80 | 201 KB | 216 MB | 97 ms | 343 / 575 ms |
| 1920 | WebP | **0.82** | **220 KB** | **236 MB** | **89 ms** | 330 / 490 ms |
| 1920 | WebP | 0.85 | 255 KB | 271 MB | 100 ms | 353 / 597 ms |
| 2560 | WebP | 0.80 | 315 KB | 333 MB | 151 ms | 571 / 825 ms |
| 2560 | WebP | 0.85 | 398 KB | 418 MB | 146 ms | 558 / 818 ms |
| 3840 | WebP | 0.82 | 588 KB | 612 MB | 234 ms | 910 / 1239 ms |
| 1920 | JPEG | 0.85 | 362 KB | 384 MB | 50 ms | 165 / 261 ms |
| 2560 | JPEG | 0.85 | 587 KB | 615 MB | 55 ms | 197 / 261 ms |

What this tells us:

- **The sharp proxy was a good stand-in.** Chromium's canvas WebP came out about 8–10% *smaller* than sharp at the same settings, so the size conclusions above hold, slightly conservatively.
- **Import time for 1,000 photos at the default (Screen-fit, WebP 0.82):**

  | Screen | Cap | Time |
  |---|---|---|
  | 1080p | 1920 | ≈ 1.5 min |
  | Retina / 1440p | 2560 | ≈ 2.5 min (interpolated) |
  | 4K tier | 3840 | ≈ 4 min |

- **WebP encoding is the main cost.** It takes about twice as long as JPEG but saves about 40% of storage. Storage is the hard constraint, so WebP stays the default; the JPEG path remains the fallback where canvas can't encode WebP (Safari).
- **Quality 0.80 vs 0.85 barely changes speed** but changes size by 25%. That confirms 0.82 as the default.

## Memory (pending)

The first run's memory column read 0 MB because the sampler only looked for processes under the sandbox's custom browser folder. That is fixed in `run-bench.mjs`. Re-run the memory-profiled config:

```
npm run bench -- --only=0                                   # Chromium, 1920px WebP 0.82
npm run bench -- --browsers=chromium,webkit,firefox --only=0
```

**Expected peak memory, from the design:**

- Up to 4 workers each hold one source file and one target-size bitmap at a time. That's ≤ 2560×1920×4 ≈ 20 MB per worker at Screen-fit.
- Peak should therefore be about 100–200 MB above the browser baseline, regardless of collection size.
- First-quarter and last-quarter RSS should be similar. A rising last quarter would indicate a leak.

| Browser | Peak RSS | Baseline | First-quarter / last-quarter RSS |
|---|---|---|---|
| _fill in from `npm run bench -- --only=0`_ | | | |
