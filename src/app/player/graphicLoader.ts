/**
 * Turn a stored graphic file into something drawable. PNGs decode to an
 * ImageBitmap (never enlarged past native size: maxScale 1). SVGs are drawn as
 * an <img> so they stay vector at any size (maxScale ∞); scripts inside an SVG
 * never run when it's loaded as an image.
 */
import type { GraphicInfo, LoadedPhoto } from '../formats/types';
import { svgRenderCopy } from '../graphics/graphics';

export async function decodeGraphic(info: GraphicInfo, blob: Blob): Promise<LoadedPhoto> {
  if (info.kind === 'raster') {
    const bmp = await createImageBitmap(blob);
    return { id: info.id, source: bmp, width: bmp.width, height: bmp.height, maxScale: 1, graphic: info, close: () => bmp.close() };
  }
  const text = svgRenderCopy(await blob.text(), info.width, info.height);
  const url = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return { id: info.id, source: img, width: info.width, height: info.height, maxScale: Infinity, graphic: info, close: () => URL.revokeObjectURL(url) };
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
}
