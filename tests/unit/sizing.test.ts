import { describe, expect, it } from 'vitest';
import { fitLongEdge, longEdgeCap, orientedSize } from '../../src/app/pipeline/sizing';
import { estimateImportBytes, formatBytes } from '../../src/app/import/storage';

describe('sizing', () => {
  it('caps Screen-fit at max(screen)*dpr, never above 2560', () => {
    expect(longEdgeCap('screen', { width: 1920, height: 1080, devicePixelRatio: 1 })).toBe(1920);
    expect(longEdgeCap('screen', { width: 1440, height: 900, devicePixelRatio: 2 })).toBe(2560);
    expect(longEdgeCap('screen', { width: 1280, height: 800, devicePixelRatio: 1.5 })).toBe(1920);
    expect(longEdgeCap('high')).toBe(2560);
    expect(longEdgeCap('4k')).toBe(3840);
  });

  it('fits the long edge and never upscales', () => {
    expect(fitLongEdge(4032, 3024, 1920)).toEqual({ width: 1920, height: 1440 });
    expect(fitLongEdge(3024, 4032, 1920)).toEqual({ width: 1440, height: 1920 });
    expect(fitLongEdge(800, 600, 1920)).toEqual({ width: 800, height: 600 });
  });

  it('swaps dimensions for EXIF orientations 5–8', () => {
    expect(orientedSize(4032, 3024, 6)).toEqual({ width: 3024, height: 4032 });
    expect(orientedSize(4032, 3024, 3)).toEqual({ width: 4032, height: 3024 });
    expect(orientedSize(4032, 3024, undefined)).toEqual({ width: 4032, height: 3024 });
  });

  it('estimates import cost in the hundreds of MB for 1,000 photos', () => {
    const screen = { width: 1920, height: 1080, devicePixelRatio: 1 };
    const mb = estimateImportBytes(1000, 'screen', { webp: true, screen }) / 1e6;
    expect(mb).toBeGreaterThan(200);
    expect(mb).toBeLessThan(500);
    const withOriginals = estimateImportBytes(1000, 'screen', { webp: true, screen, originalsBytes: 4e9 });
    expect(withOriginals).toBeGreaterThan(4e9);
  });

  it('formats bytes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(250 * 1024 * 1024)).toBe('250 MB');
  });
});
