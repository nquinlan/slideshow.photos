import { expect, test, type Page } from '@playwright/test';
import { ALL, addPhotos, expectPhotoCount, openApp } from './helpers';

/** Fraction of stage pixels that aren't (near) black. */
async function litFraction(page: Page): Promise<number> {
  return page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>('.player-canvas')!;
    const { data } = c.getContext('2d')!.getImageData(0, 0, c.width, c.height);
    let lit = 0;
    for (let i = 0; i < data.length; i += 16) if (data[i] + data[i + 1] + data[i + 2] > 40) lit++;
    return lit / (data.length / 16);
  });
}

async function play(page: Page, format: string) {
  await page.getByLabel('Format').selectOption({ label: format });
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  const player = page.getByTestId('player');
  await expect(player).toBeVisible();
  await expect(page.getByText('Loading…')).toBeHidden();
  await expect(player.locator('.player-error')).toHaveCount(0);
  return player;
}

for (const format of ['Sliding Panels', 'Floating', 'Crossfade']) {
  test(`${format} renders photos`, async ({ page }) => {
    await openApp(page);
    await addPhotos(page, ALL);
    await expectPhotoCount(page, 5);
    const player = await play(page, format);
    await page.waitForTimeout(1500); // past any opening animation
    expect(await litFraction(page)).toBeGreaterThan(0.08);
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(1500);
    expect(await litFraction(page)).toBeGreaterThan(0.08);
    await expect(player.locator('.player-error')).toHaveCount(0);
  });
}

// Regression for "small files are upscaled": a 240x160 photo must cover about its native
// area of the stage (≈3.75% at 1280x800 and 1x; ≈0.94% at 2x), not the screen.
for (const format of ['Sliding Panels', 'Crossfade']) {
  test(`${format} never upscales a small photo`, async ({ page }) => {
    await openApp(page);
    await addPhotos(page, ['tiny-240x160.jpg']);
    await expectPhotoCount(page, 1);
    await page.getByLabel('Format').selectOption({ label: format });
    // Crossfade's default blurred backdrop would light the whole screen; use black.
    if (format === 'Crossfade') await page.getByLabel('Background').selectOption({ label: 'Black' });
    await play(page, format);
    await page.waitForTimeout(1500);
    const stagePixels = await page.evaluate(() => {
      const c = document.querySelector<HTMLCanvasElement>('.player-canvas')!;
      return c.width * c.height;
    });
    const expected = (240 * 160) / stagePixels;
    const lit = await litFraction(page);
    expect(lit).toBeGreaterThan(expected * 0.6);
    expect(lit).toBeLessThan(expected * 1.6);
  });
}
