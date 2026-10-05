import { describe, expect, it } from 'vitest';
import { encodeAs } from '../../src/app/pipeline/encode';

/** Fake canvas encoder that supports only the given MIME types (others fall back to PNG, like browsers). */
const encoder = (supported: string[]) => {
  const calls: string[] = [];
  const fn = async (type: string) => {
    calls.push(type);
    return new Blob(['x'], { type: supported.includes(type) ? type : 'image/png' });
  };
  return { fn, calls };
};

describe('encodeAs', () => {
  it('uses WebP when the encoder supports it', async () => {
    const e = encoder(['image/webp', 'image/jpeg']);
    const r = await encodeAs(e.fn, 'webp', 0.82);
    expect(r.format).toBe('webp');
    expect(r.blob.type).toBe('image/webp');
    expect(e.calls).toEqual(['image/webp']);
  });

  it('falls back to JPEG when WebP comes back as PNG (Safari) — never stores PNG', async () => {
    const e = encoder(['image/jpeg']);
    const r = await encodeAs(e.fn, 'webp', 0.82);
    expect(r.format).toBe('jpeg');
    expect(r.blob.type).toBe('image/jpeg');
    expect(e.calls).toEqual(['image/webp', 'image/jpeg']);
  });

  it('goes straight to JPEG when JPEG is preferred', async () => {
    const e = encoder(['image/webp', 'image/jpeg']);
    expect((await encodeAs(e.fn, 'jpeg', 0.85)).format).toBe('jpeg');
    expect(e.calls).toEqual(['image/jpeg']);
  });

  it('fails rather than storing an unexpected format', async () => {
    await expect(encodeAs(encoder([]).fn, 'webp', 0.8)).rejects.toThrow(/instead of JPEG/);
  });
});
