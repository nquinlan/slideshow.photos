/**
 * Library export format (a .zip):
 *
 *   manifest.json            this file: collections, settings, photo + graphic metadata
 *   README.txt               what the file is and how to import it
 *   graphics/<id>.<png|svg>  logo/sponsor graphics, byte-for-byte as uploaded
 *   photos/<id>.<webp|jpg>   the stored slideshow copy of each photo
 *   thumbs/<id>.<webp|jpg>   library thumbnails
 *   originals/<id>.<ext>     kept originals (only if chosen at export)
 *
 * manifest.json is written first so an import can show what's inside before
 * reading anything else. Imports treat the file as untrusted: the manifest is
 * validated and only paths it lists (under the folders above) are read.
 */
import type { Graphic, GraphicType, PlaybackSettings, Photo } from '../db/db';
import { GRAPHIC_MIME } from '../graphics/graphics';

// Pre-rename id (the app was called Tessera); kept so older backups still import.
export const EXPORT_FORMAT = 'tessera-library';
export const EXPORT_VERSION = 1;

export interface ManifestPhoto extends Omit<Photo, 'originalBytes'> {
  originalBytes?: number;
  files: { display: string; thumb: string; original?: string };
}

export interface ManifestGraphic extends Graphic {
  file: string;
}

export interface ManifestCollection {
  id: string;
  name: string;
  createdAt: number;
  settings: PlaybackSettings;
  /** Photo ids in slideshow order. */
  photoIds: string[];
}

export interface ExportManifest {
  format: typeof EXPORT_FORMAT;
  version: typeof EXPORT_VERSION;
  exportedAt: string;
  app: string;
  collections: ManifestCollection[];
  photos: ManifestPhoto[];
  graphics: ManifestGraphic[];
}

export class BackupError extends Error {}

const SAFE_PATH = /^(photos|thumbs|originals|graphics)\/[A-Za-z0-9._-]{1,120}$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const str = (v: unknown, max = 500) => typeof v === 'string' && v.length > 0 && v.length <= max;
const path = (v: unknown, folder: string) => typeof v === 'string' && SAFE_PATH.test(v) && v.startsWith(`${folder}/`) && !v.includes('..');

/** Validate an untrusted manifest. Invalid photos/graphics are dropped; a broken file throws BackupError. */
export function parseManifest(raw: unknown): ExportManifest {
  if (!isObj(raw) || raw.format !== EXPORT_FORMAT) throw new BackupError('This isn’t a slideshow library export.');
  if (raw.version !== EXPORT_VERSION) {
    throw new BackupError(`This export was made by a ${Number(raw.version) > EXPORT_VERSION ? 'newer' : 'different'} version of the app.`);
  }
  if (!Array.isArray(raw.collections) || !Array.isArray(raw.photos) || !Array.isArray(raw.graphics)) {
    throw new BackupError('The export’s manifest is incomplete.');
  }

  const photos: ManifestPhoto[] = [];
  for (const p of raw.photos) {
    if (!isObj(p) || !str(p.id, 100) || !str(p.contentHash, 200) || !num(p.width) || !num(p.height)) continue;
    const f = p.files;
    if (!isObj(f) || !path(f.display, 'photos') || !path(f.thumb, 'thumbs')) continue;
    if (f.original !== undefined && !path(f.original, 'originals')) continue;
    photos.push({
      id: p.id as string,
      contentHash: p.contentHash as string,
      quickKey: str(p.quickKey) ? (p.quickKey as string) : undefined,
      source: p.source === 'google' ? 'google' : 'local',
      googleId: str(p.googleId) ? (p.googleId as string) : undefined,
      name: str(p.name) ? (p.name as string) : 'Photo',
      width: p.width as number,
      height: p.height as number,
      sourceWidth: num(p.sourceWidth) ? (p.sourceWidth as number) : (p.width as number),
      sourceHeight: num(p.sourceHeight) ? (p.sourceHeight as number) : (p.height as number),
      format: p.format === 'jpeg' ? 'jpeg' : 'webp',
      tier: p.tier === 'high' || p.tier === '4k' ? p.tier : 'screen',
      cap: num(p.cap) ? (p.cap as number) : Math.max(p.width as number, p.height as number),
      displayBytes: num(p.displayBytes) ? (p.displayBytes as number) : 0,
      thumbBytes: num(p.thumbBytes) ? (p.thumbBytes as number) : 0,
      originalBytes: num(p.originalBytes) ? (p.originalBytes as number) : undefined,
      takenAt: num(p.takenAt) ? (p.takenAt as number) : undefined,
      addedAt: num(p.addedAt) ? (p.addedAt as number) : Date.now(),
      files: { display: f.display as string, thumb: f.thumb as string, original: f.original as string | undefined },
    });
  }
  const photoIds = new Set(photos.map((p) => p.id));

  const graphics: ManifestGraphic[] = [];
  for (const g of raw.graphics) {
    if (!isObj(g) || !str(g.id, 100) || !(typeof g.type === 'string' && g.type in GRAPHIC_MIME) || !num(g.width) || !num(g.height)) continue;
    if (!path(g.file, 'graphics')) continue;
    graphics.push({
      id: g.id as string,
      name: str(g.name, 200) ? (g.name as string) : 'Graphic',
      type: g.type as GraphicType,
      width: g.width as number,
      height: g.height as number,
      bytes: num(g.bytes) ? (g.bytes as number) : 0,
      background: typeof g.background === 'string' && /^#[0-9a-f]{3,8}$/i.test(g.background) ? g.background : '#000000',
      scalePct: num(g.scalePct) ? Math.min(100, Math.max(5, g.scalePct as number)) : 80,
      fullScreen: g.fullScreen === true,
      addedAt: num(g.addedAt) ? (g.addedAt as number) : Date.now(),
      file: g.file as string,
    });
  }

  const collections: ManifestCollection[] = [];
  for (const c of raw.collections) {
    if (!isObj(c) || !str(c.id, 100) || !Array.isArray(c.photoIds) || !isObj(c.settings)) continue;
    collections.push({
      id: c.id as string,
      name: str(c.name, 200) ? (c.name as string) : 'Imported slideshow',
      createdAt: num(c.createdAt) ? (c.createdAt as number) : Date.now(),
      // Settings are sanitised field by field on import (see import.ts).
      settings: c.settings as unknown as PlaybackSettings,
      photoIds: (c.photoIds as unknown[]).filter((id): id is string => typeof id === 'string' && photoIds.has(id)),
    });
  }
  if (!collections.length && !graphics.length) throw new BackupError('This export doesn’t contain any slideshows.');

  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: str(raw.exportedAt) ? (raw.exportedAt as string) : '',
    app: str(raw.app) ? (raw.app as string) : '',
    collections,
    photos,
    graphics,
  };
}
