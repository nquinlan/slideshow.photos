/**
 * Image pipeline: source bytes -> oriented, metadata-free display derivative
 * plus a small thumbnail. Runs inside a Web Worker (OffscreenCanvas) and,
 * as a fallback, on the main thread.
 *
 * Steps:
 *  1. Hash source bytes (SHA-256) for dedupe.
 *  2. Read dimensions from the header (no decode) + EXIF orientation/date (meta.ts).
 *  3. Decode *directly at the target size* via createImageBitmap's
 *     resizeWidth/resizeHeight so we never hold a full-resolution bitmap
 *     when the browser supports it. HEIC goes through a lazily loaded
 *     WASM decoder when the browser can't decode it natively.
 *  4. Draw to a canvas and re-encode (WebP if the encoder exists, else
 *     JPEG). Re-encoding from pixels drops *all* metadata, including GPS.
 */
import { encodeAs } from './encode';
import { readImageMeta } from './meta';
import { fitLongEdge, orientedSize, THUMB_LONG_EDGE } from './sizing';
import type { OutputFormat, ProcessOptions, ProcessResult } from './types';

type AnyCanvas = OffscreenCanvas | HTMLCanvasElement;

// 2x1 JPEG with EXIF orientation 6 (rotate 90° CW => displays as 1x2).
const ORIENTATION_PROBE =
  '/9j/4QC8RXhpZgAASUkqAAgAAAAGABIBAwABAAAABgAAABoBBQABAAAAVgAAABsBBQABAAAAXgAAACgBAwABAAAAAgAAABMCAwABAAAAAQAAAGmHBAABAAAAZgAAAAAAAAA4YwAA6AMAADhjAADoAwAABgAAkAcABAAAADAyMTABkQcABAAAAAECAwAAoAcABAAAADAxMDABoAMAAQAAAP//AAACoAQAAQAAAAIAAAADoAQAAQAAAAEAAAAAAAAA/+IB8ElDQ19QUk9GSUxFAAEBAAAB4GxjbXMEIAAAbW50clJHQiBYWVogB+IAAwAUAAkADgAdYWNzcE1TRlQAAAAAc2F3c2N0cmwAAAAAAAAAAAAAAAAAAPbWAAEAAAAA0y1oYW5keem/Vlo+AbaDI4VVRvdPqgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKZGVzYwAAAPwAAAAkY3BydAAAASAAAAAid3RwdAAAAUQAAAAUY2hhZAAAAVgAAAAsclhZWgAAAYQAAAAUZ1hZWgAAAZgAAAAUYlhZWgAAAawAAAAUclRSQwAAAcAAAAAgZ1RSQwAAAcAAAAAgYlRSQwAAAcAAAAAgbWx1YwAAAAAAAAABAAAADGVuVVMAAAAIAAAAHABzAFIARwBCbWx1YwAAAAAAAAABAAAADGVuVVMAAAAGAAAAHABDAEMAMAAAWFlaIAAAAAAAAPbWAAEAAAAA0y1zZjMyAAAAAAABDD8AAAXd///zJgAAB5AAAP2S///7of///aIAAAPcAADAcVhZWiAAAAAAAABvoAAAOPIAAAOPWFlaIAAAAAAAAGKWAAC3iQAAGNpYWVogAAAAAAAAJKAAAA+FAAC2xHBhcmEAAAAAAAMAAAACZmkAAPKnAAANWQAAE9AAAApb/9sAQwAQCwwODAoQDg0OEhEQExgoGhgWFhgxIyUdKDozPTw5Mzg3QEhcTkBEV0U3OFBtUVdfYmdoZz5NcXlwZHhcZWdj/9sAQwEREhIYFRgvGhovY0I4QmNjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2Nj/8AAEQgAAQACAwEiAAIRAQMRAf/EABUAAQEAAAAAAAAAAAAAAAAAAAAG/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/EABUBAQEAAAAAAAAAAAAAAAAAAAUG/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AnQB6vf/Z';

export interface Capabilities {
  /** createImageBitmap honours imageOrientation:'from-image'. */
  appliesExif: boolean;
  /**
   * How resizeWidth/resizeHeight interact with orientation:
   *  'oriented' – sizes refer to the oriented output (spec behaviour)
   *  'raw'      – sizes refer to the stored (pre-rotation) pixels
   *  'none'     – resize options unsupported or unreliable
   */
  resize: 'oriented' | 'raw' | 'none';
  webp: boolean;
  offscreen: boolean;
}

let capsPromise: Promise<Capabilities> | undefined;

export function detectCapabilities(): Promise<Capabilities> {
  capsPromise ??= (async () => {
    const offscreen = typeof OffscreenCanvas !== 'undefined' && !!new OffscreenCanvas(1, 1).getContext('2d');
    const probe = new Blob([base64ToBytes(ORIENTATION_PROBE)], { type: 'image/jpeg' });
    let appliesExif = false;
    try {
      const b = await createImageBitmap(probe, { imageOrientation: 'from-image' });
      appliesExif = b.width === 1 && b.height === 2;
      b.close();
    } catch {
      /* createImageBitmap(Blob) missing entirely: main-thread fallback handles it */
    }
    let resize: Capabilities['resize'] = 'none';
    try {
      // Ask for the oriented 1x2 image scaled 2x => expect 2x4.
      const b = await createImageBitmap(probe, {
        imageOrientation: 'from-image',
        resizeWidth: 2,
        resizeHeight: 4,
        resizeQuality: 'high',
      });
      if (appliesExif && b.width === 2 && b.height === 4) resize = 'oriented';
      else if (appliesExif && b.width === 4 && b.height === 2) resize = 'raw';
      else if (!appliesExif && b.width === 2 && b.height === 4) resize = 'oriented';
      b.close();
    } catch {
      resize = 'none';
    }
    let webp = false;
    try {
      const c = makeCanvas(2, 2);
      (c.getContext('2d') as CanvasRenderingContext2D).fillRect(0, 0, 1, 1);
      const out = await encodeCanvas(c, 'image/webp', 0.8);
      webp = out.type === 'image/webp';
    } catch {
      webp = false;
    }
    return { appliesExif, resize, webp, offscreen };
  })();
  return capsPromise;
}

export class PipelineError extends Error {
  constructor(
    message: string,
    public code: 'unsupported' | 'decode' | 'encode',
  ) {
    super(message);
  }
}

export async function processImage(blob: Blob, opts: ProcessOptions): Promise<ProcessResult> {
  const t0 = performance.now();
  const caps = await detectCapabilities();
  const buf = new Uint8Array(await blob.arrayBuffer());

  const hashP = opts.skipHash ? Promise.resolve('') : sha256Hex(buf);

  const meta = await readImageMeta(buf);
  const { orientation, takenAt } = meta;
  const rawDims = meta.width && meta.height ? { width: meta.width, height: meta.height } : undefined;

  const heic = isHeicBytes(buf);
  let decoder: ProcessResult['decoder'] = 'native';
  let bitmap: ImageBitmap;
  let srcW: number;
  let srcH: number;
  let manualOrientation = 0;
  const tDec = performance.now();

  try {
    if (rawDims && caps.resize !== 'none' && !heic) {
      const o = orientedSize(rawDims.width, rawDims.height, orientation);
      srcW = o.width;
      srcH = o.height;
      const target = fitLongEdge(srcW, srcH, opts.cap);
      const swap = caps.resize === 'raw' && orientation !== undefined && orientation >= 5;
      bitmap = await createImageBitmap(blob, {
        imageOrientation: 'from-image',
        resizeWidth: swap ? target.height : target.width,
        resizeHeight: swap ? target.width : target.height,
        resizeQuality: 'high',
      });
      decoder = 'native-resize';
      if (!caps.appliesExif && orientation && orientation > 1) manualOrientation = orientation;
    } else {
      bitmap = await decodeFull(blob, buf, heic, caps);
      decoder = heic && !(await nativeHeicOk(blob)) ? 'heic-wasm' : 'native';
      if (!caps.appliesExif && orientation && orientation > 1 && decoder === 'native') manualOrientation = orientation;
      const o =
        manualOrientation >= 5
          ? { width: bitmap.height, height: bitmap.width }
          : { width: bitmap.width, height: bitmap.height };
      srcW = o.width;
      srcH = o.height;
    }
  } catch (e) {
    throw new PipelineError(`Could not decode image: ${(e as Error).message ?? e}`, 'decode');
  }
  const decodeMs = performance.now() - tDec;

  const tEnc = performance.now();
  const preferred: OutputFormat = opts.format ?? (caps.webp ? 'webp' : 'jpeg');
  const target = fitLongEdge(srcW, srcH, opts.cap);

  let display: Blob;
  let format: OutputFormat = preferred;
  let thumb: Blob;
  let thumbSize: { width: number; height: number };
  try {
    const canvas = makeCanvas(target.width, target.height);
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    drawOriented(ctx, bitmap, manualOrientation, target.width, target.height);
    bitmap.close();
    const encoded = await encodeAs((type, q) => encodeCanvas(canvas, type, q), preferred, opts.quality);
    display = encoded.blob;
    format = encoded.format;

    thumbSize = fitLongEdge(target.width, target.height, THUMB_LONG_EDGE);
    const tc = makeCanvas(thumbSize.width, thumbSize.height);
    const tctx = tc.getContext('2d') as CanvasRenderingContext2D;
    tctx.imageSmoothingEnabled = true;
    tctx.imageSmoothingQuality = 'high';
    tctx.drawImage(canvas as CanvasImageSource, 0, 0, thumbSize.width, thumbSize.height);
    // Same format as the display copy (known to work by now).
    thumb = (await encodeAs((type, q) => encodeCanvas(tc, type, q), format, 0.78)).blob;
    releaseCanvas(canvas);
    releaseCanvas(tc);
  } catch (e) {
    throw new PipelineError(`Could not encode image: ${(e as Error).message ?? e}`, 'encode');
  }

  return {
    display,
    thumb,
    width: target.width,
    height: target.height,
    thumbWidth: thumbSize.width,
    thumbHeight: thumbSize.height,
    contentHash: await hashP,
    format,
    sourceWidth: srcW,
    sourceHeight: srcH,
    takenAt,
    timings: { decode: decodeMs, encode: performance.now() - tEnc, total: performance.now() - t0 },
    decoder,
  };
}

async function decodeFull(blob: Blob, buf: Uint8Array, heic: boolean, caps: Capabilities): Promise<ImageBitmap> {
  if (heic && !(await nativeHeicOk(blob))) {
    // Lazily loaded (~3 MB WASM, LGPL-3.0 libheif) only when needed.
    const { heicTo } = await import('heic-to');
    return heicTo({
      blob: new Blob([buf as BlobPart], { type: 'image/heic' }),
      type: 'bitmap',
      options: { imageOrientation: 'from-image' },
    });
  }
  return createImageBitmap(blob, caps.appliesExif ? { imageOrientation: 'from-image' } : undefined);
}

let nativeHeic: boolean | undefined;
async function nativeHeicOk(blob: Blob): Promise<boolean> {
  if (nativeHeic !== undefined) return nativeHeic;
  try {
    const b = await createImageBitmap(blob);
    b.close();
    nativeHeic = true;
  } catch {
    nativeHeic = false;
  }
  return nativeHeic;
}

/** Draw `src` into a w×h canvas applying an EXIF orientation transform. */
function drawOriented(ctx: CanvasRenderingContext2D, src: CanvasImageSource, o: number, w: number, h: number) {
  // For 5-8 the source is drawn with swapped axes.
  const [dw, dh] = o >= 5 ? [h, w] : [w, h];
  switch (o) {
    case 2: ctx.setTransform(-1, 0, 0, 1, w, 0); break;
    case 3: ctx.setTransform(-1, 0, 0, -1, w, h); break;
    case 4: ctx.setTransform(1, 0, 0, -1, 0, h); break;
    case 5: ctx.setTransform(0, 1, 1, 0, 0, 0); break;
    case 6: ctx.setTransform(0, 1, -1, 0, w, 0); break;
    case 7: ctx.setTransform(0, -1, -1, 0, w, h); break;
    case 8: ctx.setTransform(0, -1, 1, 0, 0, h); break;
    default: ctx.setTransform(1, 0, 0, 1, 0, 0);
  }
  ctx.drawImage(src, 0, 0, dw, dh);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

function makeCanvas(w: number, h: number): AnyCanvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function releaseCanvas(c: AnyCanvas) {
  // Safari in particular holds canvas backing stores until GC; shrink now.
  c.width = 1;
  c.height = 1;
}

function encodeCanvas(c: AnyCanvas, type: string, quality: number): Promise<Blob> {
  if ('convertToBlob' in c) return c.convertToBlob({ type, quality });
  return new Promise((resolve, reject) =>
    (c as HTMLCanvasElement).toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), type, quality),
  );
}

export function isHeicBytes(b: Uint8Array): boolean {
  if (b.length < 12) return false;
  if (String.fromCharCode(b[4], b[5], b[6], b[7]) !== 'ftyp') return false;
  const brand = String.fromCharCode(b[8], b[9], b[10], b[11]);
  return ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1'].includes(brand);
}

async function sha256Hex(buf: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', buf as BufferSource));
  let s = '';
  for (const x of d) s += x.toString(16).padStart(2, '0');
  return s;
}

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
