/**
 * Header metadata needed before decoding: stored pixel size, EXIF
 * orientation and capture date. Kept separate from processor.ts so it can be
 * unit-tested in Node against real files.
 */
import { imageSize } from 'image-size';
import exifr from 'exifr/dist/lite.esm.mjs';

export interface ImageMeta {
  /** Stored (pre-orientation) pixel size, when the header could be read. */
  width?: number;
  height?: number;
  /** EXIF orientation 1–8, when present. */
  orientation?: number;
  /** DateTimeOriginal in ms since epoch, when present. */
  takenAt?: number;
}

// Note: exifr's `pick` option throws in the lite build ("undefined is not
// iterable"), so we select segments instead. GPS is never parsed.
const EXIF_OPTIONS = {
  tiff: true,
  exif: true,
  gps: false,
  interop: false,
  ifd1: false,
  xmp: false,
  icc: false,
  iptc: false,
  jfif: false,
  ihdr: false,
  translateValues: false,
  reviveValues: true,
  mergeOutput: true,
} as const;

const validOrientation = (o: unknown): number | undefined =>
  typeof o === 'number' && o >= 1 && o <= 8 ? o : undefined;

export async function readImageMeta(buf: Uint8Array): Promise<ImageMeta> {
  const meta: ImageMeta = {};
  try {
    const s = imageSize(buf);
    if (s.width && s.height) {
      meta.width = s.width;
      meta.height = s.height;
    }
    meta.orientation = validOrientation(s.orientation);
  } catch {
    /* unknown format: dimensions come from the decoded bitmap instead */
  }
  try {
    const exif = await exifr.parse(buf, EXIF_OPTIONS);
    meta.orientation ??= validOrientation(exif?.Orientation);
    const d = exif?.DateTimeOriginal;
    if (d instanceof Date && !Number.isNaN(d.getTime())) meta.takenAt = d.getTime();
  } catch {
    /* no or unreadable EXIF (PNG, GIF…) is normal */
  }
  return meta;
}
