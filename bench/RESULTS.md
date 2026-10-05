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

## Speed and memory (pending: run locally)

```
npm run bench                                    # Chromium, all configs
npm run bench -- --browsers=chromium,webkit,firefox --only=0
```

The script reports the following for each config: average display and thumbnail size, wall time per photo, median and p95 worker time, peak RSS, and RSS in the first and last quarter of the run. Comparing the first and last quarter shows whether memory stays flat during long imports. It also reports which decoder path was used (`native-resize`, `native` or `heic-wasm`) and an EXIF orientation check.

**Expected peak memory, from the design:** each of up to 4 workers holds one source file and one decoded target-size bitmap (≤ 2560×1920×4 ≈ 20 MB) at a time. When `createImageBitmap` resize is supported (Chromium; Firefox and Safari are feature-detected), the full-resolution bitmap is never materialised. Peak should therefore sit around 100–200 MB above baseline, independent of collection size.

| Browser | Config | ms/photo (wall) | Worker median | Peak RSS | First-quarter / last-quarter RSS |
|---|---|---|---|---|---|
| _fill in from `npm run bench`_ | | | | | |
