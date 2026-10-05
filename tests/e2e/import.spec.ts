import { expect, test } from '@playwright/test';
import { ALL, addPhotos, expectPhotoCount, openApp } from './helpers';

test('imports local photos, dedupes, applies EXIF orientation, survives reload, and removes', async ({ page }) => {
  await openApp(page);
  await expectPhotoCount(page, 0);

  await addPhotos(page, ALL);
  await expectPhotoCount(page, 5);
  await expect(page.getByRole('img', { name: 'sunset.jpg' })).toBeVisible();
  await expect(page.getByText('Import complete')).toBeVisible();

  // Thumbnails are stored with orientation applied: rotated-exif6 is portrait.
  const dims = await page.getByRole('img', { name: 'rotated-exif6.jpg' }).evaluate((img: HTMLImageElement) =>
    img.decode().then(() => [img.naturalWidth, img.naturalHeight]),
  );
  expect(dims[1]).toBeGreaterThan(dims[0]);

  // Same files again + a byte-identical copy under another name: nothing new is stored.
  await addPhotos(page, ['sunset.jpg', 'sunset-copy.jpg']);
  await expect(page.getByText(/already in library/)).toBeVisible();
  await expectPhotoCount(page, 5);

  // Stored derivatives are WebP (or JPEG where WebP encoding is unsupported) with metadata stripped.
  const stored = await page.evaluate(async () => {
    const req = indexedDB.open('tessera');
    const db: IDBDatabase = await new Promise((r) => (req.onsuccess = () => r(req.result)));
    // Rows hold a Blob, or an ArrayBuffer + type where IndexedDB rejects Blobs (WebKit ephemeral sessions).
    const rows: { blob?: Blob; data?: ArrayBuffer; type?: string }[] = await new Promise((r) => {
      const q = db.transaction('displays').objectStore('displays').getAll();
      q.onsuccess = () => r(q.result);
    });
    db.close();
    return Promise.all(
      rows.map(async (row) => {
        const blob = row.blob ?? new Blob([row.data!], { type: row.type });
        const head = new Uint8Array(await blob.slice(0, 4096).arrayBuffer());
        const text = String.fromCharCode(...head);
        return { type: blob.type, hasExif: text.includes('Exif') };
      }),
    );
  });
  expect(stored).toHaveLength(5);
  for (const s of stored) {
    expect(['image/webp', 'image/jpeg']).toContain(s.type);
    expect(s.hasExif).toBe(false);
  }

  // Persisted across reloads.
  await page.reload();
  await expectPhotoCount(page, 5);

  // Remove two photos.
  await page.getByRole('checkbox', { name: 'Select ocean.jpg' }).check({ force: true });
  await page.getByRole('checkbox', { name: 'Select night.png' }).check({ force: true });
  await page.getByRole('button', { name: 'Remove from collection' }).click();
  await expectPhotoCount(page, 3);
});

test('add from Google Photos is disabled with an explanation when offline', async ({ page, context }) => {
  await openApp(page);
  await context.setOffline(true);
  await expect(page.getByTestId('net-status')).toHaveText(/Offline/);
  const google = page.getByTestId('google-button');
  await expect(google).toBeDisabled();
  await expect(page.getByText(/needs an internet connection/)).toBeVisible();
  await context.setOffline(false);
  await expect(page.getByTestId('net-status')).toHaveText(/Online/);
});
