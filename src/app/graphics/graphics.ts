/**
 * Logo / sponsor graphics: validation, sizing, and how often they appear.
 *
 * Files are stored exactly as uploaded, with one exception: HEIC/HEIF, which
 * most browsers can't display, is converted once to a lossless PNG. The only
 * other transformation is at render time and in memory: an SVG whose root has
 * no absolute width/height gets them added to a *copy*, because Firefox can't
 * draw such SVGs to a canvas.
 */
import { imageSize } from 'image-size';
import type { GraphicInfo } from '../formats/types';
import type { CollectionGraphics, Graphic, GraphicType } from '../db/db';
import { isHeicBytes } from '../pipeline/processor';
import { orientedSize } from '../pipeline/sizing';

export const MAX_GRAPHIC_BYTES = 25 * 1024 * 1024;
/** Combined share is capped so photos always make up most of the show. */
export const MAX_TOTAL_SHARE = 0.9;

export class GraphicFileError extends Error {}

export const GRAPHIC_MIME: Record<GraphicType, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
};

/** For the file picker. HEIC/HEIF is accepted too (converted to PNG). */
export const GRAPHIC_ACCEPT =
  '.png,.jpg,.jpeg,.webp,.gif,.avif,.bmp,.svg,.heic,.heif,image/png,image/jpeg,image/webp,image/gif,image/avif,image/bmp,image/svg+xml,image/heic,image/heif';

const UNSUPPORTED = 'This file type can’t be used as a graphic. Use PNG, JPEG, SVG, WebP, GIF, AVIF, BMP or HEIC.';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.subarray(from, to));

export function sniffGraphicType(bytes: Uint8Array): GraphicType | 'heic' | null {
  if (PNG_SIGNATURE.every((b, i) => bytes[i] === b)) return 'png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (ascii(bytes, 0, 4) === 'GIF8') return 'gif';
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') return 'webp';
  if (ascii(bytes, 0, 2) === 'BM') return 'bmp';
  if (ascii(bytes, 4, 8) === 'ftyp' && ['avif', 'avis'].includes(ascii(bytes, 8, 12))) return 'avif';
  if (isHeicBytes(bytes)) return 'heic';
  // SVG is text: skip BOM, XML declaration, comments and doctype; look for an <svg root.
  const head = new TextDecoder().decode(bytes.subarray(0, 4096)).replace(/^﻿/, '');
  const stripped = head.replace(/<\?xml[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[\s\S]*?>/gi, '').trimStart();
  return /^<svg[\s>]/i.test(stripped) ? 'svg' : null;
}

export interface InspectedGraphic {
  type: GraphicType;
  /** Intrinsic size as displayed (after EXIF rotation). */
  width: number;
  height: number;
  /** What to store: the upload itself, or a PNG converted from HEIC. */
  file: Blob;
}

/**
 * Validate an uploaded file and read its intrinsic size. HEIC/HEIF is
 * converted to PNG; everything else is returned as-is. Throws GraphicFileError.
 */
export async function inspectGraphicFile(file: Blob): Promise<InspectedGraphic> {
  if (file.size > MAX_GRAPHIC_BYTES) throw new GraphicFileError('Graphics must be 25 MB or smaller.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const type = sniffGraphicType(bytes);
  if (!type) throw new GraphicFileError(UNSUPPORTED);
  if (type === 'heic') return heicToPng(file);
  let size: { width?: number; height?: number; orientation?: number };
  try {
    size = imageSize(bytes);
  } catch {
    throw new GraphicFileError(type === 'svg' ? 'This SVG has no usable size (add a viewBox).' : 'This image could not be read.');
  }
  if (!size.width || !size.height) throw new GraphicFileError('This graphic has no usable size (SVGs need a viewBox or width and height).');
  return { type, ...orientedSize(size.width, size.height, size.orientation), file };
}

/** Decode HEIC (natively, or with the lazily loaded WASM decoder) and re-encode losslessly as PNG. */
async function heicToPng(file: Blob): Promise<InspectedGraphic> {
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    try {
      const { heicTo } = await import('heic-to');
      bmp = await heicTo({ blob: new Blob([file], { type: 'image/heic' }), type: 'bitmap', options: { imageOrientation: 'from-image' } });
    } catch {
      throw new GraphicFileError('This HEIC file could not be read.');
    }
  }
  const { width, height } = bmp;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d')!.drawImage(bmp, 0, 0);
  bmp.close();
  const png = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
  canvas.width = canvas.height = 0;
  if (!png) throw new GraphicFileError('This HEIC file could not be converted.');
  if (png.size > MAX_GRAPHIC_BYTES) throw new GraphicFileError('Graphics must be 25 MB or smaller (this HEIC is too large once converted to PNG).');
  return { type: 'png', width, height, file: png };
}

/**
 * For rendering only: ensure the root <svg> has absolute width/height so every
 * browser can draw it to a canvas. Returns the text unchanged if it already does.
 */
export function svgRenderCopy(text: string, width: number, height: number): string {
  const m = /<svg\b[^>]*>/i.exec(text);
  if (!m) return text;
  const tag = m[0];
  const abs = (name: string) => {
    const v = new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(tag)?.[1];
    return !!v && /^\s*[\d.]+\s*(px)?\s*$/i.test(v);
  };
  if (abs('width') && abs('height')) return text;
  let fixed = tag.replace(/\s(width|height)\s*=\s*["'][^"']*["']/gi, '');
  fixed = fixed.replace(/^<svg\b/i, `<svg width="${width}" height="${height}"`);
  return text.slice(0, m.index) + fixed + text.slice(m.index + tag.length);
}

export function toGraphicInfo(g: Graphic): GraphicInfo {
  return {
    id: g.id,
    width: g.width,
    height: g.height,
    kind: g.type === 'svg' ? 'vector' : 'raster',
    background: g.background,
    scalePct: g.scalePct,
    fullScreen: g.fullScreen,
  };
}

/** Graphics enabled for a collection, with shares as fractions (scaled down if they sum past the cap). */
export function enabledGraphics(all: Graphic[], settings: CollectionGraphics | undefined): { info: GraphicInfo; share: number }[] {
  const share = settings?.share ?? {};
  const items = all
    .filter((g) => (share[g.id] ?? 0) > 0)
    .map((g) => ({ info: toGraphicInfo(g), share: Math.min(1, share[g.id] / 100) }));
  const total = items.reduce((a, i) => a + i.share, 0);
  if (total > MAX_TOTAL_SHARE) for (const i of items) i.share *= MAX_TOTAL_SHARE / total;
  return items;
}

/**
 * Decides, step by step, whether a graphic is due. Each step (a slide, a
 * layout, a drifting item) every graphic earns credit equal to its share;
 * once a graphic has a full credit it is shown and pays one credit back.
 * Over N steps a 10% graphic appears 0.1·N times, evenly spaced, rather than
 * at random. Starting credits are randomised so graphics with equal shares
 * don't all land on the same step, and at most one graphic is due per step.
 */
export class GraphicScheduler {
  private credits: number[];

  constructor(
    private items: { info: GraphicInfo; share: number }[],
    random: () => number = Math.random,
  ) {
    this.credits = items.map((i) => random() * i.share * 0.999 + (1 - i.share));
  }

  get size() {
    return this.items.length;
  }

  next(): GraphicInfo | null {
    let best = -1;
    for (let i = 0; i < this.items.length; i++) {
      this.credits[i] += this.items[i].share;
      if (this.credits[i] >= 1 && (best < 0 || this.credits[i] > this.credits[best])) best = i;
    }
    if (best < 0) return null;
    this.credits[best] -= 1;
    return this.items[best].info;
  }
}
