/**
 * Local file selection with progressive enhancement:
 *  - File System Access API (showOpenFilePicker / showDirectoryPicker) where
 *    available (Chromium desktop),
 *  - otherwise <input type=file multiple> and <input webkitdirectory>.
 * We read File objects and copy their bytes into IndexedDB during import;
 * handles are never persisted (their permissions can lapse).
 */
import type { ImportItem } from './importer';

const IMAGE_EXT = /\.(jpe?g|png|webp|gif|avif|heic|heif|bmp)$/i;

export function isImageFile(f: File): boolean {
  if (f.type.startsWith('image/') && !/tiff|svg/.test(f.type)) return true;
  // Windows/Firefox often report HEIC with an empty MIME type.
  return IMAGE_EXT.test(f.name);
}

export function filesToItems(files: File[]): ImportItem[] {
  const seen = new Set<string>();
  const items: ImportItem[] = [];
  for (const f of files) {
    if (!isImageFile(f)) continue;
    const path = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
    const quickKey = `${f.name}|${f.size}|${f.lastModified}`;
    if (seen.has(quickKey)) continue;
    seen.add(quickKey);
    items.push({ key: `${path}|${quickKey}`, name: f.name, quickKey, size: f.size, load: async () => f });
  }
  return items;
}

type FSAWindow = Window & {
  showOpenFilePicker?: (opts?: unknown) => Promise<{ getFile(): Promise<File> }[]>;
  showDirectoryPicker?: (opts?: unknown) => Promise<FileSystemDirectoryHandle>;
};

export const supportsDirectoryPicker = () => typeof (window as FSAWindow).showDirectoryPicker === 'function';
export const supportsFolderInput = () => 'webkitdirectory' in document.createElement('input');

function isAbort(e: unknown) {
  return (e as Error)?.name === 'AbortError';
}

/** Multi-select photos. Must be called from a user gesture. */
export async function pickFiles(): Promise<File[]> {
  const w = window as FSAWindow;
  if (w.showOpenFilePicker) {
    try {
      const handles = await w.showOpenFilePicker({
        multiple: true,
        id: 'photos',
        types: [
          {
            description: 'Images',
            accept: { 'image/*': ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif', '.heic', '.heif'] },
          },
        ],
      });
      return Promise.all(handles.map((h) => h.getFile()));
    } catch (e) {
      if (isAbort(e)) return [];
      // SecurityError in cross-origin iframes etc. – fall back to <input>.
    }
  }
  return pickViaInput({ multiple: true });
}

/** Select a folder (recursively). Must be called from a user gesture. */
export async function pickFolder(): Promise<File[]> {
  const w = window as FSAWindow;
  if (w.showDirectoryPicker) {
    try {
      const dir = await w.showDirectoryPicker({ id: 'photo-folder', mode: 'read' });
      const out: File[] = [];
      await walkDirectory(dir, out);
      return out;
    } catch (e) {
      if (isAbort(e)) return [];
    }
  }
  return pickViaInput({ directory: true });
}

async function walkDirectory(dir: FileSystemDirectoryHandle, out: File[], depth = 0) {
  if (depth > 12) return;
  // `values()` is part of the async-iterable FileSystemDirectoryHandle.
  for await (const entry of (dir as unknown as { values(): AsyncIterable<FileSystemHandle> }).values()) {
    if (entry.name.startsWith('.')) continue;
    if (entry.kind === 'file') {
      const f = await (entry as FileSystemFileHandle).getFile();
      if (isImageFile(f)) out.push(f);
    } else if (entry.kind === 'directory') {
      await walkDirectory(entry as FileSystemDirectoryHandle, out, depth + 1);
    }
  }
}

function pickViaInput(opts: { multiple?: boolean; directory?: boolean }): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*,.heic,.heif';
    input.multiple = !!opts.multiple || !!opts.directory;
    if (opts.directory) input.setAttribute('webkitdirectory', '');
    input.style.display = 'none';
    document.body.appendChild(input);
    const cleanup = () => input.remove();
    input.addEventListener('change', () => {
      resolve(Array.from(input.files ?? []).filter(isImageFile));
      cleanup();
    });
    input.addEventListener('cancel', () => {
      resolve([]);
      cleanup();
    });
    input.click();
  });
}

/** Files (and recursively, folders) from a drag-and-drop. */
export async function filesFromDataTransfer(dt: DataTransfer): Promise<File[]> {
  const entries = Array.from(dt.items)
    .map((i) => (i.kind === 'file' ? i.webkitGetAsEntry?.() : null))
    .filter((e): e is FileSystemEntry => !!e);
  if (!entries.length) return Array.from(dt.files).filter(isImageFile);
  const out: File[] = [];
  await Promise.all(entries.map((e) => walkEntry(e, out, 0)));
  return out;
}

async function walkEntry(entry: FileSystemEntry, out: File[], depth: number): Promise<void> {
  if (depth > 12 || entry.name.startsWith('.')) return;
  if (entry.isFile) {
    const f = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
    if (isImageFile(f)) out.push(f);
    return;
  }
  if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    // readEntries returns batches (~100 in Chrome) until empty.
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
      if (!batch.length) break;
      for (const child of batch) await walkEntry(child, out, depth + 1);
    }
  }
}
