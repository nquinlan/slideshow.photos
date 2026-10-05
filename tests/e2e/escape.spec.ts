import { expect, test } from '@playwright/test';
import { ALL, addPhotos, expectPhotoCount, openApp } from './helpers';

/**
 * Two-stage Escape. In a real browser the first Esc is consumed by the
 * browser to leave full-screen (pages can't intercept it). Synthetic key
 * events from automation may or may not reach the browser's full-screen
 * handler, so if full-screen is still active after pressing Esc we exit it
 * the way the browser would (document.exitFullscreen) and then assert the
 * app's behaviour: keep playing windowed, and stop on the next Esc.
 */
test('first Esc leaves full-screen and keeps playing; second Esc stops', async ({ page }) => {
  await openApp(page);
  await addPhotos(page, ALL);
  await expectPhotoCount(page, 5);
  // Short interval so we can observe auto-advance while windowed.
  await page.getByLabel(/Show each photo for/).fill('2');

  await page.getByRole('button', { name: 'Play', exact: true }).click();
  const player = page.getByTestId('player');
  await expect(player).toBeVisible();
  await expect(player).toHaveAttribute('data-fullscreen', 'true');
  expect(await page.evaluate(() => !!document.fullscreenElement)).toBe(true);

  // Stage 1
  await page.keyboard.press('Escape');
  if (await page.evaluate(() => !!document.fullscreenElement)) {
    await page.evaluate(() => document.exitFullscreen());
  }
  await expect(player).toHaveAttribute('data-fullscreen', 'false');
  await expect(player).toBeVisible();
  await expect(page.getByText(/Press Esc again to stop/)).toBeVisible();
  // Still playing: position advances on its own.
  const start = Number(await player.getAttribute('data-position'));
  await expect.poll(async () => Number(await player.getAttribute('data-position')), { timeout: 10_000 }).not.toBe(start);
  await expect(player).toHaveAttribute('data-paused', 'false');

  // Re-enter via the visible control, then leave again.
  await page.getByTestId('fullscreen-toggle').click();
  await expect(player).toHaveAttribute('data-fullscreen', 'true');
  await page.evaluate(() => document.exitFullscreen());
  await expect(player).toHaveAttribute('data-fullscreen', 'false');

  // Stage 2 (after the grace window)
  await page.waitForTimeout(400);
  await page.keyboard.press('Escape');
  await expect(player).toBeHidden();
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeFocused();
});

test('space pauses, arrows navigate', async ({ page }) => {
  await openApp(page);
  await addPhotos(page, ALL);
  await expectPhotoCount(page, 5);
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  const player = page.getByTestId('player');
  await expect(page.getByText('Loading…')).toBeHidden();
  await page.locator('.player-canvas').click();
  await page.keyboard.press('Space');
  await expect(player).toHaveAttribute('data-paused', 'true');
  await page.keyboard.press('ArrowRight');
  await expect(player).toHaveAttribute('data-position', '1');
  await page.keyboard.press('ArrowLeft');
  await expect(player).toHaveAttribute('data-position', '0');
});
