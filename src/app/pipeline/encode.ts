import type { OutputFormat } from './types';

const MIME: Record<OutputFormat, string> = { webp: 'image/webp', jpeg: 'image/jpeg' };

/**
 * Encode with the preferred format, guaranteeing the result really is WebP or
 * JPEG. Canvas encoders silently substitute PNG for types they don't support
 * (Safari returns PNG for 'image/webp'), which would store ~10× larger files.
 * If WebP comes back as anything else we re-encode as JPEG; if JPEG isn't
 * honoured either, we fail rather than store the wrong format.
 */
export async function encodeAs(
  encode: (type: string, quality: number) => Promise<Blob>,
  preferred: OutputFormat,
  quality: number,
): Promise<{ blob: Blob; format: OutputFormat }> {
  if (preferred === 'webp') {
    const webp = await encode(MIME.webp, quality);
    if (webp.type === MIME.webp) return { blob: webp, format: 'webp' };
  }
  const jpeg = await encode(MIME.jpeg, quality);
  if (jpeg.type !== MIME.jpeg) throw new Error(`Encoder returned ${jpeg.type || 'unknown type'} instead of JPEG`);
  return { blob: jpeg, format: 'jpeg' };
}
