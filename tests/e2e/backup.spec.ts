import { expect, test } from '@playwright/test';
import { ALL, addPhotos, expectPhotoCount, fixture, openApp } from './helpers';

test('export on one computer, import on another', async ({ browser }, testInfo) => {
  // Computer A: a slideshow with photos, a graphic and a renamed collection.
  // Separate contexts = separate browser profiles (storage), like two computers.
  const opts = { baseURL: testInfo.project.use.baseURL };
  const a = await browser.newContext(opts);
  const pageA = await a.newPage();
  await openApp(pageA);
  await addPhotos(pageA, ALL);
  await expectPhotoCount(pageA, 5);
  await pageA.getByLabel('Collection name').fill('Spring gala');
  await pageA.getByLabel('Collection name').press('Enter');
  await pageA.getByText('Logos & graphics').click();
  await pageA.getByTestId('graphic-upload').setInputFiles(fixture('logo.svg'));
  await expect(pageA.getByTestId('graphic-row')).toHaveCount(1);

  await pageA.getByRole('button', { name: 'Settings' }).click();
  const download = pageA.waitForEvent('download');
  await pageA.getByTestId('export-button').click();
  const file = testInfo.outputPath('library.zip');
  await (await download).saveAs(file);
  await expect(pageA.getByText(/Exported 1 slideshow/)).toBeVisible();
  await a.close();

  // Computer B: empty library.
  const b = await browser.newContext(opts);
  const pageB = await b.newPage();
  await openApp(pageB);
  await expectPhotoCount(pageB, 0);
  await pageB.getByRole('button', { name: 'Settings' }).click();
  await pageB.getByTestId('import-file').setInputFiles(file);
  const summary = pageB.getByTestId('import-summary');
  await expect(summary).toContainText('Spring gala (5)');
  await expect(summary).toContainText('1 graphic');
  await pageB.getByTestId('import-confirm').click();
  await expect(pageB.getByTestId('import-message')).toContainText('Imported “Spring gala”');

  // The imported slideshow is selected, with its photos and graphic.
  await expect(pageB.getByLabel('Collection name')).toHaveValue('Spring gala');
  await expectPhotoCount(pageB, 5);
  await expect(pageB.getByRole('img', { name: 'sunset.jpg' })).toBeVisible();
  await pageB.getByText('Logos & graphics').click();
  await expect(pageB.getByTestId('graphic-row')).toHaveCount(1);
  await b.close();
});
