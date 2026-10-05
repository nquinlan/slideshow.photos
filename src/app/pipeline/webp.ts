/** Main-thread WebP encoder check (cheap; used for storage estimates). */
let p: Promise<boolean> | undefined;
export function canEncodeWebP(): Promise<boolean> {
  p ??= new Promise((resolve) => {
    try {
      const c = document.createElement('canvas');
      c.width = c.height = 1;
      c.toBlob((b) => resolve(b?.type === 'image/webp'), 'image/webp', 0.8);
    } catch {
      resolve(false);
    }
  });
  return p;
}
