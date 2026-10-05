import Dexie from 'dexie';
import sharp from 'sharp';
import { beforeEach, describe, expect, it } from 'vitest';
import { SlideshowDB, setBlobMode, setDB, type Graphic } from '../../src/app/db/db';
import { addGraphic, deleteGraphic, getGraphicFile, listGraphics } from '../../src/app/db/repo';
import {
  GraphicFileError,
  GraphicScheduler,
  MAX_TOTAL_SHARE,
  enabledGraphics,
  inspectGraphicFile,
  svgRenderCopy,
  toGraphicInfo,
} from '../../src/app/graphics/graphics';

const SVG_VIEWBOX = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 120"><rect width="400" height="120" fill="red"/></svg>';
const svgFile = (text: string, name = 'logo.svg') => new File([text], name, { type: 'image/svg+xml' });
const pngFile = async (w = 64, h = 32, name = 'sponsor.png') =>
  new File([await sharp({ create: { width: w, height: h, channels: 4, background: '#f00f' } }).png().toBuffer()], name, { type: 'image/png' });

describe('graphic files', () => {
  it('accepts PNG and SVG and reads their intrinsic size', async () => {
    expect(await inspectGraphicFile(await pngFile(64, 32))).toEqual({ type: 'png', width: 64, height: 32 });
    expect(await inspectGraphicFile(svgFile(SVG_VIEWBOX))).toEqual({ type: 'svg', width: 400, height: 120 });
    const withDecl = `﻿<?xml version="1.0"?>\n<!-- logo -->\n<!DOCTYPE svg>\n${SVG_VIEWBOX}`;
    expect((await inspectGraphicFile(svgFile(withDecl))).type).toBe('svg');
  });

  it('rejects other formats and SVGs without a usable size', async () => {
    const jpeg = new File([await sharp({ create: { width: 8, height: 8, channels: 3, background: '#000' } }).jpeg().toBuffer()], 'a.jpg');
    await expect(inspectGraphicFile(jpeg)).rejects.toBeInstanceOf(GraphicFileError);
    await expect(inspectGraphicFile(new File(['hello'], 'a.txt'))).rejects.toBeInstanceOf(GraphicFileError);
    await expect(inspectGraphicFile(svgFile('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>'))).rejects.toThrow(/viewBox/);
  });

  it('svgRenderCopy adds absolute width/height only when the root lacks them', () => {
    expect(svgRenderCopy(SVG_VIEWBOX, 400, 120)).toMatch(/^<svg width="400" height="120" xmlns=/);
    const pct = '<svg width="100%" height="100%" viewBox="0 0 4 1"><svg width="50%"/></svg>';
    expect(svgRenderCopy(pct, 400, 100)).toBe('<svg width="400" height="100" viewBox="0 0 4 1"><svg width="50%"/></svg>');
    const ok = '<svg width="300px" height="100" viewBox="0 0 3 1"/>';
    expect(svgRenderCopy(ok, 300, 100)).toBe(ok);
  });
});

describe('graphic storage', () => {
  let n = 0;
  beforeEach(async () => {
    const db = new SlideshowDB(`gfx-${++n}`);
    setDB(db);
    await db.open();
  });

  it('stores uploads byte-for-byte, PNG and SVG', async () => {
    for (const file of [await pngFile(300, 100), svgFile(SVG_VIEWBOX)]) {
      const g = await addGraphic(file);
      const stored = new Uint8Array(await (await getGraphicFile(g.id))!.arrayBuffer());
      expect(stored).toEqual(new Uint8Array(await file.arrayBuffer()));
      expect(g).toMatchObject({ background: '#000000', scalePct: 80, fullScreen: false });
    }
    expect((await listGraphics()).map((g) => g.name)).toEqual(['sponsor', 'logo']);
  });

  it('stores byte-for-byte in the ArrayBuffer fallback too (WebKit private sessions)', async () => {
    setBlobMode('buffer');
    const file = svgFile(SVG_VIEWBOX);
    const g = await addGraphic(file);
    expect(await (await getGraphicFile(g.id))!.text()).toBe(SVG_VIEWBOX);
    expect((await getGraphicFile(g.id))!.type).toBe('image/svg+xml');
  });

  it('upgrading an existing v1 database keeps its data and adds the graphics tables', async () => {
    const name = `upgrade-${n}`;
    const v1 = new Dexie(name);
    v1.version(1).stores({
      photos: 'id, &contentHash, quickKey, googleId, addedAt',
      displays: 'photoId',
      thumbs: 'photoId',
      originals: 'photoId',
      collections: 'id, updatedAt',
      items: '++id, [collectionId+position], &[collectionId+photoId], photoId',
      jobs: 'id, status, collectionId',
      kv: 'key',
    });
    await v1.table('collections').add({ id: 'c1', name: 'Old', createdAt: 1, updatedAt: 1, settings: {} });
    v1.close();
    const v2 = new SlideshowDB(name);
    setDB(v2);
    await v2.open();
    expect(v2.verno).toBe(2);
    expect((await v2.collections.get('c1'))?.name).toBe('Old');
    await addGraphic(svgFile(SVG_VIEWBOX));
    expect(await v2.graphics.count()).toBe(1);
  });

  it('deletes the record and the file together', async () => {
    const g = await addGraphic(await pngFile());
    await deleteGraphic(g.id);
    expect(await listGraphics()).toEqual([]);
    expect(await getGraphicFile(g.id)).toBeUndefined();
  });
});

describe('graphic share scheduling', () => {
  const info = (id: string) => toGraphicInfo({ id, type: 'svg', width: 4, height: 1, background: '#000', scalePct: 80, fullScreen: false } as Graphic);

  it('shows each graphic at its share of steps, evenly spaced', () => {
    const s = new GraphicScheduler([{ info: info('logo'), share: 0.1 }], () => 0.5);
    const hits: number[] = [];
    for (let step = 0; step < 10_000; step++) if (s.next()) hits.push(step);
    expect(hits.length).toBeGreaterThanOrEqual(999);
    expect(hits.length).toBeLessThanOrEqual(1001);
    const gaps = hits.slice(1).map((h, i) => h - hits[i]);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(11);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(9);
  });

  it('keeps several graphics near their shares with at most one per step', () => {
    let seed = 3;
    const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const s = new GraphicScheduler(
      [
        { info: info('logo'), share: 0.2 },
        { info: info('a'), share: 0.05 },
        { info: info('b'), share: 0.05 },
      ],
      random,
    );
    const counts: Record<string, number> = { logo: 0, a: 0, b: 0 };
    for (let step = 0; step < 10_000; step++) {
      const g = s.next();
      if (g) counts[g.id]++;
    }
    expect(counts.logo).toBeGreaterThan(1990);
    expect(counts.logo).toBeLessThan(2010);
    expect(counts.a).toBeGreaterThan(495);
    expect(counts.b).toBeGreaterThan(495);
  });

  it('enabledGraphics ignores zero/unknown shares and caps the total', () => {
    const g = (id: string) => ({ id, type: 'png', width: 1, height: 1, background: '#000', scalePct: 80, fullScreen: false }) as Graphic;
    const items = enabledGraphics([g('a'), g('b'), g('c')], { share: { a: 60, b: 60, c: 0, gone: 50 }, corner: null });
    expect(items.map((i) => i.info.id)).toEqual(['a', 'b']);
    expect(items.reduce((t, i) => t + i.share, 0)).toBeCloseTo(MAX_TOTAL_SHARE);
    expect(enabledGraphics([g('a')], undefined)).toEqual([]);
  });
});
