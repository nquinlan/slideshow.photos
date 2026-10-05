import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import sitemap from '@astrojs/sitemap';

// Canonical origin used for <link rel=canonical>, Open Graph URLs and sitemap.xml.
// Set SITE_URL at build time for your real deployment.
const site = process.env.SITE_URL ?? 'https://tessera-slideshow.example';

export default defineConfig({
  site,
  outDir: process.env.OUT_DIR ?? 'dist',
  // `file` format emits /app.html, which static hosts serve at /app and which the
  // service worker's precache (cleanURLs) can resolve offline.
  build: { format: 'file', inlineStylesheets: 'auto' },
  trailingSlash: 'never',
  integrations: [react(), sitemap({ filter: (page) => !page.includes('/spike') })],
  vite: {
    worker: { format: 'es' },
    build: { chunkSizeWarningLimit: 3500 },
  },
});
