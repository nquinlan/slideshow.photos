import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { readImageMeta } from '../../src/app/pipeline/meta';

const fx = (n: string) => new Uint8Array(fs.readFileSync(path.resolve(import.meta.dirname, '../e2e/fixtures', n)));

describe('readImageMeta', () => {
  it('reads stored size and EXIF orientation (regression: exifr lite `pick` threw, losing orientation)', async () => {
    expect(await readImageMeta(fx('rotated-exif6.jpg'))).toMatchObject({ width: 1200, height: 800, orientation: 6 });
  });

  it('handles files without EXIF', async () => {
    const m = await readImageMeta(fx('sunset.jpg'));
    expect(m).toMatchObject({ width: 1200, height: 800 });
    expect(m.orientation ?? 1).toBe(1);
    expect(await readImageMeta(fx('night.png'))).toMatchObject({ width: 1000, height: 1000 });
  });

  it('reads DateTimeOriginal', async () => {
    const jpg = await sharp({ create: { width: 8, height: 4, channels: 3, background: '#888' } })
      .jpeg()
      .withExif({ IFD2: { DateTimeOriginal: '2021:07:04 18:30:00' } })
      .toBuffer();
    const m = await readImageMeta(new Uint8Array(jpg));
    expect(new Date(m.takenAt!).getFullYear()).toBe(2021);
  });

  it('never throws on garbage', async () => {
    expect(await readImageMeta(new Uint8Array([1, 2, 3, 4]))).toEqual({});
  });
});
