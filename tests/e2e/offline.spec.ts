import { expect, test } from '@playwright/test';
import { ALL, addPhotos, expectPhotoCount, openApp } from './helpers';

test('after the first visit the app reloads and plays with no network', async ({ page, context, browserName }) => {
  await openApp(page);
  // Wait for the service worker to install, precache the shell and take control.
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise<void>((r) => navigator.serviceWorker.addEventListener('controllerchange', () => r(), { once: true }));
    }
  });
  await addPhotos(page, ALL);
  await expectPhotoCount(page, 5);

  await context.setOffline(true);

  // Runs in every engine: with no network, the service worker serves the app
  // shell and its scripts, and stored photos are still readable and decodable.
  const offline = await page.evaluate(async () => {
    const get = async (u: string) => {
      try {
        const r = await fetch(u, { cache: 'no-store' });
        return { status: r.status, type: r.headers.get('content-type') ?? '', body: (await r.text()).slice(0, 2000) };
      } catch (e) {
        return { status: 0, type: '', body: String(e) };
      }
    };
    const app = await get('/app');
    const landing = await get('/');
    const script = app.body.match(/\/_astro\/[\w.-]+\.js/)?.[0] ?? '/_astro/missing.js';
    const js = await get(script);
    const req = indexedDB.open('tessera');
    const db: IDBDatabase = await new Promise((r) => (req.onsuccess = () => r(req.result)));
    const rows: { blob?: Blob; data?: ArrayBuffer; type?: string }[] = await new Promise((r) => {
      const q = db.transaction('displays').objectStore('displays').getAll();
      q.onsuccess = () => r(q.result);
    });
    db.close();
    const row = rows[0];
    const bmp = await createImageBitmap(row.blob ?? new Blob([row.data!], { type: row.type }));
    return { app: app.status, landing: landing.status, js: js.status, appIsHtml: app.type.includes('html'), decoded: bmp.width > 0 };
  });
  expect(offline).toEqual({ app: 200, landing: 200, js: 200, appIsHtml: true, decoded: true });

  // Playwright's WebKit aborts *navigations* under offline emulation on service-worker
  // pages ("WebKit encountered an internal error"), even when the worker answers with a
  // literal Response: https://github.com/microsoft/playwright/issues/42775
  // The fetch checks above cover the service worker in WebKit; full reloads run in Chromium and Firefox.
  test.skip(browserName === 'webkit', 'Offline navigation is broken in Playwright WebKit (microsoft/playwright#42775)');

  await page.reload();
  await expect(page.getByRole('button', { name: 'Add photos' })).toBeVisible();
  await expectPhotoCount(page, 5);
  await expect(page.getByTestId('net-status')).toHaveText(/Offline/);
  await expect(page.getByTestId('google-button')).toBeDisabled();

  // The landing page is also served from the precache.
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.goto('/app');

  // Playback works offline.
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  const player = page.getByTestId('player');
  await expect(player).toBeVisible();
  await expect(page.getByText('Loading…')).toBeHidden();
  await page.keyboard.press('ArrowRight');
  await expect(player).toHaveAttribute('data-position', '1');
  await context.setOffline(false);
});
