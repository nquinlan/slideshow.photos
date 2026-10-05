import { expect, test } from '@playwright/test';
import { ALL, addPhotos, expectPhotoCount, openApp } from './helpers';

/**
 * Chromium only (see playwright.config.ts): Playwright supports service workers
 * only in Chromium (https://playwright.dev/docs/service-workers). In Firefox,
 * offline-emulated requests bypass the worker (NS_ERROR_OFFLINE) and reloads can
 * be served from the HTTP cache instead; in WebKit, offline navigations on
 * service-worker pages abort (microsoft/playwright#42775). Neither proves
 * anything about our worker, so offline launch in Firefox and Safari is a
 * manual check (README → Testing status).
 */
test('after the first visit the app reloads and plays with no network', async ({ page, context }) => {
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

  // With no network, the service worker serves the app shell and its scripts.
  const offline = await page.evaluate(async () => {
    const get = async (u: string) => {
      try {
        const r = await fetch(u, { cache: 'no-store' });
        return { status: r.status, type: r.headers.get('content-type') ?? '', body: await r.text() };
      } catch (e) {
        return { status: 0, type: '', body: String(e) };
      }
    };
    const app = await get('/app');
    const landing = await get('/');
    // Every script the app page references must come from the precache.
    const scripts = [...new Set(app.body.match(/\/_astro\/[\w.-]+\.js/g) ?? [])];
    const js = await Promise.all(scripts.map(async (u) => [u, (await get(u)).status] as const));
    return { app: app.status, landing: landing.status, appIsHtml: app.type.includes('html'), scripts: js };
  });
  expect(offline).toMatchObject({ app: 200, landing: 200, appIsHtml: true });
  expect(offline.scripts.length).toBeGreaterThan(0);
  for (const [url, status] of offline.scripts) expect(status, url).toBe(200);

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
