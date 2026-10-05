/**
 * Photo decoding for playback. Decodes off the main thread via
 * createImageBitmap and, given a target box, decodes no larger than needed
 * to cover it (resizeWidth/resizeHeight), so a collage of six photos holds
 * six tile-sized bitmaps rather than six full derivatives.
 */
import type { LoadedPhoto, PhotoInfo, PhotoLibrary } from '../formats/types';

export type Decoder = (blob: Blob, size?: { width: number; height: number }) => Promise<{
  source: CanvasImageSource;
  width: number;
  height: number;
  close(): void;
}>;

export const decodeBitmap: Decoder = async (blob, size) => {
  let bmp: ImageBitmap | undefined;
  if (size) {
    try {
      bmp = await createImageBitmap(blob, { resizeWidth: size.width, resizeHeight: size.height, resizeQuality: 'high' });
    } catch {
      bmp = undefined; // resize options unsupported: decode at full size
    }
  }
  bmp ??= await createImageBitmap(blob);
  const b = bmp;
  return { source: b, width: b.width, height: b.height, close: () => b.close() };
};

/** Size to decode `info` at so it still covers `box` without exceeding the stored size. */
export function decodeSize(info: PhotoInfo, box?: { width: number; height: number }) {
  if (!box) return undefined;
  const k = Math.min(1, Math.max(box.width / info.width, box.height / info.height));
  if (k > 0.95) return undefined; // not worth a resize pass
  return { width: Math.max(1, Math.round(info.width * k)), height: Math.max(1, Math.round(info.height * k)) };
}

export function createLibrary(
  photos: PhotoInfo[],
  loadBlob: (id: string) => Promise<Blob | undefined>,
  decode: Decoder = decodeBitmap,
): PhotoLibrary {
  const byId = new Map(photos.map((p) => [p.id, p]));
  return {
    photos,
    async load(id, box): Promise<LoadedPhoto | null> {
      const info = byId.get(id);
      if (!info) return null;
      try {
        const blob = await loadBlob(id);
        if (!blob) return null;
        const d = await decode(blob, decodeSize(info, box));
        // The scale limit is relative to the decoded bitmap, which may be smaller than the stored copy.
        return { id, ...d, maxScale: info.maxScale * (info.width / (d.width || info.width)) };
      } catch {
        return null;
      }
    },
  };
}
