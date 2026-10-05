# Third-party software

Versions are those locked at the time of writing (`package-lock.json` is authoritative).

## Shipped to browsers

| Package | Version | License | Used for |
|---|---|---|---|
| [react](https://github.com/facebook/react), react-dom, scheduler | 19.3.0 | MIT | App UI |
| [dexie](https://github.com/dexie/Dexie.js) | 4.4.6 | Apache-2.0 | IndexedDB storage |
| [exifr](https://github.com/MikeKovarik/exifr) (lite build) | 7.1.3 | MIT | Reading EXIF orientation and capture date before metadata is stripped |
| [image-size](https://codeberg.org/image-size/image-size) | 2.0.4 | MIT | Reading image dimensions from headers, so decoding can happen at the target size |
| [@zip.js/zip.js](https://github.com/gildas-lormeau/zip.js) | 2.23.0 | BSD-3-Clause | Library export/import (.zip, streaming, Zip64) |
| [@tanstack/react-virtual](https://github.com/TanStack/virtual), virtual-core | 3.14 / 3.17 | MIT | Virtualized thumbnail grid |
| [workbox-window](https://github.com/GoogleChrome/workbox), plus workbox-core, -precaching and -routing (inlined into `sw.js`) | 7.4.1 | MIT | Service worker registration, updates, precaching |
| Astro client runtime ([astro](https://github.com/withastro/astro)) | 7.3.5 | MIT | Island hydration for `/app` |
| **[heic-to](https://github.com/hoppergee/heic-to)** | 1.6.5 | **LGPL-3.0** | HEIC/HEIF decoding where the browser can't decode it natively |
| ↳ [libheif](https://github.com/strukturag/libheif) 1.23.5 (compiled to JS/WASM inside heic-to) | — | **LGPL-3.0** | |
| ↳ [libde265](https://github.com/strukturag/libde265) 1.0.16 (inside heic-to) | — | **LGPL-3.0** | HEVC decoding for HEIC |

### LGPL notes (HEIC decoder)

There is no permissively licensed HEIC decoder for browsers: every option, `heic2any` included, bundles libheif. Its `MIT` label covers only its wrapper code. To meet LGPL-3.0:

- The decoder is used unmodified, as a separate lazily loaded chunk (`/_astro/heic-to-*.js`). It is only fetched when a HEIC file is imported in a browser that can't decode HEIC natively, which currently means every engine except Safari.
- Users can replace that chunk with their own build of heic-to or libheif. The source is available from the links above, and build instructions are in heic-to's README.
- If you need to avoid LGPL entirely, remove the `heic-to` import in `src/app/pipeline/processor.ts`. HEIC then works only in Safari, and other browsers report it as an unreadable file.

## Development and build only (not shipped)

| Package | License |
|---|---|
| astro, @astrojs/react, @astrojs/sitemap, vite | MIT |
| typescript | Apache-2.0 |
| vitest, jsdom | MIT |
| fake-indexeddb | Apache-2.0 |
| @playwright/test, playwright-core | Apache-2.0 |
| workbox-build | MIT |
| sharp (bundles libvips, LGPL-3.0, as a prebuilt binary) | Apache-2.0 |

## External services

- **Google Identity Services** (`https://accounts.google.com/gsi/client`) and the **Google Photos Picker API** are loaded or called only when the user chooses "Add from Google Photos". They are governed by Google's terms, including the Photos API User Data and Developer Policy.

## Benchmark sample images

`bench/samples/` is not committed. It holds photos downloaded from [Lorem Picsum](https://picsum.photos), which serves images from Unsplash under the Unsplash License, plus `libheif`'s `examples/example.heic`. The e2e fixtures in `tests/e2e/fixtures/` are synthetic images generated for this project.
