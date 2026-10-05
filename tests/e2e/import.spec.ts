import { expect, test } from '@playwright/test';
import exifr from 'exifr';
import { ALL, addPhotos, expectPhotoCount, openApp } from './helpers';

/** FourCCs of a WebP file's RIFF chunks (EXIF and 'XMP ' hold metadata). */
function webpChunks(b: Buffer): string[] {
  expect(b.toString('ascii', 0, 4)).toBe('RIFF');
  expect(b.toString('ascii', 8, 12)).toBe('WEBP');
  const ids: string[] = [];
  for (let o = 12; o + 8 <= b.length; ) {
    const size = b.readUInt32LE(o + 4);
    ids.push(b.toString('ascii', o, o + 4));
    o += 8 + size + (size & 1);
  }
  return ids;
}

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

  // A photo carrying GPS, camera make/model and a capture date.
  await addPhotos(page, ['gps-exif.jpg']);
  await expectPhotoCount(page, 6);

  // Stored derivatives are WebP (or JPEG where canvas can't encode WebP, e.g. Safari) and carry
  // none of the source metadata. Encoders may add their own minimal Exif (WebKit's JPEG encoder
  // does), so we parse the stored bytes in Node rather than looking for an "Exif" marker.
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
        const bytes = new Uint8Array(row.blob ? await row.blob.arrayBuffer() : row.data!);
        let bin = '';
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        return { type: row.blob?.type ?? row.type ?? '', base64: btoa(bin) };
      }),
    );
  });
  expect(stored).toHaveLength(6);
  const leftovers: Record<string, unknown>[] = [];
  for (const s of stored) {
    expect(['image/webp', 'image/jpeg']).toContain(s.type);
    const bytes = Buffer.from(s.base64, 'base64');
    if (s.type === 'image/webp') {
      // exifr can't read WebP; metadata there lives in RIFF chunks, so assert there are none.
      const chunks = webpChunks(bytes);
      expect(chunks).not.toContain('EXIF');
      expect(chunks).not.toContain('XMP ');
      continue;
    }
    const tags = (await exifr.parse(bytes, { gps: true, xmp: true, iptc: true })) ?? {};
    expect(tags.latitude).toBeUndefined();
    expect(tags.GPSLatitude).toBeUndefined();
    expect(tags.Make).toBeUndefined();
    expect(tags.Model).toBeUndefined();
    expect(tags.DateTimeOriginal).toBeUndefined();
    expect(tags.Software).not.toBe('fixture');
    if (Object.keys(tags).length) leftovers.push(tags);
  }
  // Record any encoder-added tags in the report, for visibility.
  if (leftovers.length) test.info().annotations.push({ type: 'encoder-exif', description: JSON.stringify(leftovers[0]) });

  // Persisted across reloads.
  await page.reload();
  await expectPhotoCount(page, 6);

  // Remove two photos.
  await page.getByRole('checkbox', { name: 'Select ocean.jpg' }).check({ force: true });
  await page.getByRole('checkbox', { name: 'Select night.png' }).check({ force: true });
  await page.getByRole('button', { name: 'Remove from collection' }).click();
  await expectPhotoCount(page, 4);
});

// Runs in every engine (the full-screen/Escape spec is Chromium-only). Covers decoding
// stored photos for playback, including WebKit's ArrayBuffer storage fallback.
test('plays imported photos', async ({ page }) => {
  await openApp(page);
  await addPhotos(page, ALL);
  await expectPhotoCount(page, 5);
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  const player = page.getByTestId('player');
  await expect(player).toBeVisible();
  await expect(page.getByText('Loading…')).toBeHidden();
  await expect(player.locator('.player-error')).toHaveCount(0);
  await page.keyboard.press('ArrowRight');
  await expect(player).toHaveAttribute('data-position', '1');
  await page.keyboard.press('ArrowRight');
  await expect(player).toHaveAttribute('data-position', '2');
  await expect(player.locator('.player-error')).toHaveCount(0);
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

test('the expand button previews a photo larger and keeps selection', async ({ page }) => {
  await openApp(page);
  await addPhotos(page, ALL);
  await expectPhotoCount(page, 5);

  await page.getByRole('img', { name: 'sunset.jpg' }).hover();
  await page.getByRole('button', { name: 'Preview sunset.jpg' }).click();
  const preview = page.getByTestId('photo-preview');
  await expect(preview).toBeVisible();
  await expect(preview).toContainText('of 5');
  // The slideshow copy, not the 320px thumbnail.
  await expect
    .poll(() => preview.getByRole('img', { name: 'sunset.jpg' }).evaluate((i: HTMLImageElement) => i.naturalWidth))
    .toBeGreaterThan(320);

  await preview.getByRole('checkbox', { name: 'Select sunset.jpg' }).check();
  await expect(preview.getByText('Selected', { exact: true })).toBeVisible();

  // Arrow keys step to a neighbouring photo, with its own selection state.
  const atEnd = await preview.getByRole('button', { name: 'Next photo' }).isDisabled();
  await page.keyboard.press(atEnd ? 'ArrowLeft' : 'ArrowRight');
  await expect(preview.getByRole('img', { name: 'sunset.jpg' })).toHaveCount(0);
  await expect(preview.getByRole('checkbox')).not.toBeChecked();

  await page.keyboard.press('Escape');
  await expect(preview).toBeHidden();
  await expect(page.getByText('1 selected')).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Select sunset.jpg' })).toBeChecked();
});

test('a portrait photo previews whole, and the preview removes just that photo', async ({ page }) => {
  await openApp(page);
  await addPhotos(page, ALL);
  await expectPhotoCount(page, 5);
  await page.getByRole('checkbox', { name: 'Select ocean.jpg' }).check({ force: true });

  await page.getByRole('img', { name: 'rotated-exif6.jpg' }).hover();
  await page.getByRole('button', { name: 'Preview rotated-exif6.jpg' }).click();
  const preview = page.getByTestId('photo-preview');
  const img = preview.getByRole('img', { name: 'rotated-exif6.jpg' });
  await expect.poll(() => img.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(320);
  // Contained: the image box stays inside the stage, so object-fit shows the whole portrait photo.
  const [box, stage] = await Promise.all([img.boundingBox(), preview.locator('.preview-stage').boundingBox()]);
  expect(box!.height).toBeLessThanOrEqual(stage!.height + 1);
  expect(await img.evaluate((i) => getComputedStyle(i).objectFit)).toBe('contain');

  await preview.getByRole('button', { name: 'Remove from collection' }).click();
  await expectPhotoCount(page, 4);
  // Moves on to another photo rather than closing.
  await expect(preview).toBeVisible();
  await expect(preview.getByRole('img', { name: 'rotated-exif6.jpg' })).toHaveCount(0);
  await expect(preview).toContainText('of 4');

  await page.keyboard.press('Escape');
  await expect(page.getByRole('img', { name: 'rotated-exif6.jpg' })).toHaveCount(0);
  await expect(page.getByText('1 selected')).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Select ocean.jpg' })).toBeChecked();
});
