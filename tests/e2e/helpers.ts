import { expect, type Page } from '@playwright/test';
import path from 'node:path';

export const FIXTURES = path.resolve(import.meta.dirname, 'fixtures');
export const fixture = (...names: string[]) => names.map((n) => path.join(FIXTURES, n));
export const ALL = ['sunset.jpg', 'ocean.jpg', 'forest.jpg', 'night.png', 'rotated-exif6.jpg'];

/**
 * Force the <input type=file> / download fallbacks: Playwright can't drive the
 * native File System Access pickers, but it can answer file choosers and
 * capture downloads.
 */
export async function useInputFallback(page: Page) {
  await page.addInitScript(() => {
    // @ts-expect-error test-only override
    delete window.showOpenFilePicker;
    // @ts-expect-error test-only override
    delete window.showDirectoryPicker;
    // @ts-expect-error test-only override (exports fall back to a download Playwright can capture)
    delete window.showSaveFilePicker;
  });
}

export async function openApp(page: Page) {
  await useInputFallback(page);
  await page.goto('/app');
  await expect(page.getByRole('button', { name: 'Add photos' })).toBeVisible();
}

export async function addPhotos(page: Page, files: string[]) {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Add photos' }).click();
  await (await chooser).setFiles(fixture(...files));
}

export async function expectPhotoCount(page: Page, n: number) {
  await expect(page.getByTestId('photo-count')).toHaveText(`${n} photo${n === 1 ? '' : 's'}`);
}
