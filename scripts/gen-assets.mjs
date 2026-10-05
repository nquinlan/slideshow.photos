#!/usr/bin/env node
/**
 * Generates the static brand assets in public/:
 *   favicon.svg, icons/icon-192.png, icons/icon-512.png, icons/maskable-512.png,
 *   icons/apple-touch-icon.png, og.png, manifest.webmanifest
 *
 * Usage: node scripts/gen-assets.mjs
 * Outputs are committed; re-run only when the mark, name or tagline changes.
 */
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import sharp from 'sharp';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pub = path.join(root, 'public');

// Read SITE constants from src/site.ts without a TS toolchain (simple literal parse).
const siteSrc = await readFile(path.join(root, 'src/site.ts'), 'utf8');
const pick = (key) => {
  const m = siteSrc.match(new RegExp(`${key}:\\s*\\n?\\s*'([^']*)'`));
  if (!m) throw new Error(`Could not read SITE.${key} from src/site.ts`);
  return m[1];
};
const SITE = {
  name: pick('name'),
  tagline: pick('tagline'),
  description: pick('description'),
  appPath: pick('appPath'),
  themeColor: pick('themeColor'),
};

// Palette (kept in sync with the landing page CSS custom properties).
const BG = SITE.themeColor; // #0f1115
const TILES = ['#f5b14c', '#ef6f6c', '#4fc1b0', '#5b8def', '#9b7ede', '#f28fb1'];

/**
 * The mark: a 3x3 mosaic of rounded tiles where one tile is mid-slide,
 * echoing the tiled slideshow formats. Drawn in a 0..100 coordinate box.
 */
function mosaic({ x = 0, y = 0, size = 100 } = {}) {
  const s = size / 100;
  const gap = 6;
  const cell = (100 - gap * 2) / 3; // ~29.33
  const colors = [
    [TILES[0], TILES[1], TILES[2]],
    [TILES[3], TILES[4], TILES[0]],
    [TILES[2], TILES[5], null], // bottom-right slot is "sliding"
  ];
  let out = '';
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      const fill = colors[r][c];
      if (!fill) continue;
      out += `<rect x="${(x + c * (cell + gap) * s).toFixed(2)}" y="${(y + r * (cell + gap) * s).toFixed(2)}" width="${(cell * s).toFixed(2)}" height="${(cell * s).toFixed(2)}" rx="${(5 * s).toFixed(2)}" fill="${fill}"/>`;
    }
  }
  // Sliding tile: offset diagonally out of its slot, slightly transparent.
  const sx = x + (2 * (cell + gap) + 5) * s;
  const sy = y + (2 * (cell + gap) + 5) * s;
  out += `<rect x="${sx.toFixed(2)}" y="${sy.toFixed(2)}" width="${(cell * s * 0.82).toFixed(2)}" height="${(cell * s * 0.82).toFixed(2)}" rx="${(5 * s).toFixed(2)}" fill="${TILES[3]}" opacity="0.85"/>`;
  return out;
}

// --- favicon.svg (hand-tuned, small, scales cleanly) ------------------------
const favicon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect width="32" height="32" rx="7" fill="${BG}"/>
  <rect x="5" y="5" width="10" height="10" rx="2" fill="${TILES[0]}"/>
  <rect x="17" y="5" width="10" height="10" rx="2" fill="${TILES[1]}"/>
  <rect x="5" y="17" width="10" height="10" rx="2" fill="${TILES[2]}"/>
  <rect x="19" y="19" width="9" height="9" rx="2" fill="${TILES[3]}"/>
</svg>
`;

/** Icon SVG at `px` square. `bleed` = solid full background; `inset` = mosaic size fraction. */
function iconSvg(px, { rounded = true, inset = 0.62 } = {}) {
  const m = px * inset;
  const o = (px - m) / 2;
  const radius = rounded ? px * 0.2 : 0;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 ${px} ${px}">
  <rect width="${px}" height="${px}" rx="${radius}" fill="${BG}"/>
  ${mosaic({ x: o, y: o, size: m })}
</svg>`;
}

const escapeXml = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Greedy word wrap by approximate character budget. */
function wrap(text, maxChars) {
  const words = text.split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    if ((line + ' ' + w).trim().length > maxChars && line) {
      lines.push(line);
      line = w;
    } else {
      line = (line + ' ' + w).trim();
    }
  }
  if (line) lines.push(line);
  return lines;
}

function ogSvg() {
  const W = 1200;
  const H = 630;
  const font = "'Helvetica Neue', Helvetica, Arial, 'Liberation Sans', 'DejaVu Sans', sans-serif";
  const taglineLines = wrap(SITE.tagline, 30);
  const tagline = taglineLines
    .map(
      (l, i) =>
        `<text x="80" y="${360 + i * 56}" font-family="${font}" font-size="44" font-weight="400" fill="#c9cfdb">${escapeXml(l)}</text>`,
    )
    .join('\n  ');
  // Decorative mosaic field on the right.
  let field = '';
  const cols = 5;
  const rows = 5;
  const cell = 96;
  const gap = 14;
  const fx = 760;
  const fy = 50;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = (r * 7 + c * 3) % TILES.length;
      const op = 0.35 + (((r + c) % 4) * 0.18);
      const slide = r === 2 && c === 1 ? 26 : r === 3 && c === 3 ? -22 : 0;
      field += `<rect x="${fx + c * (cell + gap) + slide}" y="${fy + r * (cell + gap)}" width="${cell}" height="${cell}" rx="14" fill="${TILES[i]}" opacity="${op.toFixed(2)}"/>`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="fade" x1="0" x2="1" y1="0" y2="0">
      <stop offset="0" stop-color="${BG}" stop-opacity="1"/>
      <stop offset="1" stop-color="${BG}" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="${BG}"/>
  ${field}
  <rect x="640" y="0" width="300" height="${H}" fill="url(#fade)"/>
  ${mosaic({ x: 80, y: 96, size: 100 })}
  <text x="80" y="310" font-family="${font}" font-size="80" font-weight="700" fill="#ffffff" letter-spacing="-2">${escapeXml(SITE.name)}</text>
  ${tagline}
  <text x="80" y="${360 + taglineLines.length * 56 + 40}" font-family="${font}" font-size="28" fill="${TILES[0]}">Free · Works offline · Photos stay on your device</text>
</svg>`;
}

const manifest = {
  name: `${SITE.name} — Photo slideshows`,
  short_name: SITE.name,
  description: SITE.description,
  id: SITE.appPath,
  start_url: SITE.appPath,
  scope: '/',
  display: 'standalone',
  background_color: SITE.themeColor,
  theme_color: SITE.themeColor,
  categories: ['photo', 'entertainment', 'utilities'],
  icons: [
    { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    { src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
  ],
};

const png = (svg, size) =>
  sharp(Buffer.from(svg), { density: 72 })
    .resize(size, size)
    .png({ compressionLevel: 9, palette: true, quality: 90 })
    .toBuffer();

await mkdir(path.join(pub, 'icons'), { recursive: true });

const outputs = {
  'favicon.svg': favicon,
  'icons/icon-192.png': await png(iconSvg(512), 192),
  'icons/icon-512.png': await png(iconSvg(512), 512),
  // Maskable: full-bleed background, mark inside the central 80% safe circle.
  'icons/maskable-512.png': await png(iconSvg(512, { rounded: false, inset: 0.5 }), 512),
  // iOS applies its own corner mask and ignores transparency; use full bleed.
  'icons/apple-touch-icon.png': await sharp(Buffer.from(iconSvg(512, { rounded: false, inset: 0.6 })))
    .resize(180, 180)
    .flatten({ background: BG })
    .png({ compressionLevel: 9 })
    .toBuffer(),
  'og.png': await sharp(Buffer.from(ogSvg())).png({ compressionLevel: 9 }).toBuffer(),
  'manifest.webmanifest': JSON.stringify(manifest, null, 2) + '\n',
};

for (const [rel, data] of Object.entries(outputs)) {
  await writeFile(path.join(pub, rel), data);
  const bytes = typeof data === 'string' ? Buffer.byteLength(data) : data.length;
  console.log(`wrote public/${rel} (${bytes} bytes)`);
}
