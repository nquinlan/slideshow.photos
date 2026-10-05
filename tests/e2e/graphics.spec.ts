import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import { ALL, FIXTURES, addPhotos, expectPhotoCount, fixture, openApp } from './helpers';

async function uploadGraphics(page: Page, names: string[]) {
  await page.getByText('Logos & graphics').click();
  await page.getByTestId('graphic-upload').setInputFiles(fixture(...names));
  await expect(page.getByTestId('graphic-row')).toHaveCount(names.length);
}

/** Fraction of stage pixels that are pure green (#00ff00 graphic background). */
async function greenFraction(page: Page): Promise<number> {
  return page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>('.player-canvas')!;
    const { data } = c.getContext('2d')!.getImageData(0, 0, c.width, c.height);
    let n = 0;
    for (let i = 0; i < data.length; i += 16) if (data[i] < 40 && data[i + 1] > 200 && data[i + 2] < 40) n++;
    return n / (data.length / 16);
  });
}

/** Step through the show, sampling the canvas after each step settles. */
async function sampleSteps(page: Page, steps: number): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < steps; i++) {
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(1300);
    out.push(await greenFraction(page));
  }
  return out;
}

async function setupGreenLogo(page: Page, share: number) {
  await openApp(page);
  await addPhotos(page, ALL);
  await expectPhotoCount(page, 5);
  await uploadGraphics(page, ['logo.svg']);
  const row = page.getByTestId('graphic-row').first();
  await row.locator('input[type="color"]').fill('#00ff00');
  await row.getByLabel(/In this slideshow/).fill(String(share));
}

test('graphics are stored byte-for-byte; unsupported files are rejected', async ({ page }) => {
  await openApp(page);
  await uploadGraphics(page, ['logo.svg', 'sponsor.png']);
  const stored = await page.evaluate(async () => {
    const req = indexedDB.open('tessera');
    const db: IDBDatabase = await new Promise((r) => (req.onsuccess = () => r(req.result)));
    const rows: { blob?: Blob; data?: ArrayBuffer }[] = await new Promise((r) => {
      const q = db.transaction('graphicFiles').objectStore('graphicFiles').getAll();
      q.onsuccess = () => r(q.result);
    });
    db.close();
    return Promise.all(
      rows.map(async (row) => {
        const bytes = new Uint8Array(row.blob ? await row.blob.arrayBuffer() : row.data!);
        let bin = '';
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        return btoa(bin);
      }),
    );
  });
  const expected = ['logo.svg', 'sponsor.png'].map((n) => fs.readFileSync(`${FIXTURES}/${n}`).toString('base64'));
  expect(stored.sort()).toEqual(expected.sort());

  await page.getByTestId('graphic-upload').setInputFiles(fixture('sunset.jpg'));
  await expect(page.getByRole('alert')).toContainText('Only PNG and SVG');
});

test('Crossfade shows a graphic slide on its background colour at its share', async ({ page }) => {
  await setupGreenLogo(page, 50);
  await page.getByLabel('Format').selectOption({ label: 'Crossfade' });
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(page.getByText('Loading…')).toBeHidden();
  const samples = await sampleSteps(page, 6);
  // Graphic slides fill the screen with the green background; photo slides have none.
  expect(samples.filter((g) => g > 0.5).length).toBeGreaterThanOrEqual(2);
  expect(samples.filter((g) => g < 0.01).length).toBeGreaterThanOrEqual(2);
});

test('Sliding Panels mixes a graphic into one panel of the collage', async ({ page }) => {
  await setupGreenLogo(page, 50);
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(page.getByText('Loading…')).toBeHidden();
  const samples = await sampleSteps(page, 6);
  // A panel, not the whole screen.
  expect(samples.some((g) => g > 0.02 && g < 0.6)).toBe(true);
});

test('corner logo stays on screen during playback', async ({ page }) => {
  await openApp(page);
  await addPhotos(page, ALL);
  await expectPhotoCount(page, 5);
  await uploadGraphics(page, ['logo.svg']);
  await page.getByTestId('corner-logo-select').selectOption({ label: 'logo' });
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  const logo = page.getByTestId('corner-logo').locator('img');
  await expect(logo).toBeVisible();
  expect(await logo.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
  await page.keyboard.press('ArrowRight');
  await expect(logo).toBeVisible();
});
