/**
 * Size-only proxy benchmark using sharp (libwebp/libjpeg-turbo, the same
 * encoder families browsers use for canvas.convertToBlob). Used when a real
 * browser can't be launched (e.g. sandboxed CI). Timing/memory numbers here
 * are NOT representative of the browser pipeline; use `npm run bench` for those.
 */
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';

const dir = path.resolve(import.meta.dirname, 'samples');
const files = fs.readdirSync(dir).filter((f) => /\.(jpe?g|png)$/i.test(f)).sort();
const CONFIGS = [
  [1920, 'webp', 80], [1920, 'webp', 82], [1920, 'webp', 85],
  [2560, 'webp', 80], [2560, 'webp', 82], [2560, 'webp', 85],
  [2880, 'webp', 82], [3840, 'webp', 82],
  [1920, 'jpeg', 85], [2560, 'jpeg', 85],
];
sharp.concurrency(1);
const pool = async (items, n, fn) => { let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) await fn(items[i++]); })); };
const rows = [];
const srcBytes = files.reduce((a, f) => a + fs.statSync(path.join(dir, f)).size, 0);
for (const [cap, fmt, q] of CONFIGS) {
  let out = 0, px = 0, thumb = 0;
  await pool(files, 6, async (f) => {
    const img = sharp(path.join(dir, f)).rotate().resize(cap, cap, { fit: 'inside', withoutEnlargement: true });
    const enc = fmt === 'webp' ? img.webp({ quality: q }) : img.jpeg({ quality: q });
    const { data, info } = await enc.toBuffer({ resolveWithObject: true });
    out += data.length; px += info.width * info.height;
    const t = await sharp(data).resize(320, 320, { fit: 'inside' })[fmt]({ quality: 78 }).toBuffer();
    thumb += t.length;
  });
  const n = files.length;
  rows.push({ cap, fmt, q, avgKB: out / n / 1024, thumbKB: thumb / n / 1024, bpp: out / px, per1000MB: ((out + thumb) / n) * 1000 / 1e6 });
}
console.log(`${files.length} photos, avg source ${(srcBytes / files.length / 1e6).toFixed(2)} MB\n`);
console.log('| cap | format | q | avg display | avg thumb | bytes/px | 1,000 photos |');
console.log('|---|---|---|---|---|---|---|');
for (const r of rows) console.log(`| ${r.cap} | ${r.fmt} | ${r.q} | ${r.avgKB.toFixed(0)} KB | ${r.thumbKB.toFixed(1)} KB | ${r.bpp.toFixed(3)} | ${r.per1000MB.toFixed(0)} MB |`);
fs.mkdirSync(path.resolve(import.meta.dirname, 'out'), { recursive: true });
fs.writeFileSync(path.resolve(import.meta.dirname, 'out/size-proxy.json'), JSON.stringify(rows, null, 2));
