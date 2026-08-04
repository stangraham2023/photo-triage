import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { writeThumbnail, thumbPathFor, THUMB_LONG_EDGE, thumbUrl } from '../../src/main/thumbnails.ts';

const img = (w: number, h: number) => ({
  width: w, height: h, data: new Uint8ClampedArray(w * h * 4).fill(200),
});

describe('writeThumbnail', () => {
  it('writes a JPEG no larger than the long edge', async () => {
    const dest = join(await mkdtemp(join(tmpdir(), 'thumb-')), 'a.jpg');
    await writeThumbnail(img(1600, 1200), dest);
    const meta = await sharp(await readFile(dest)).metadata();
    expect(meta.format).toBe('jpeg');
    expect(Math.max(meta.width!, meta.height!)).toBe(THUMB_LONG_EDGE);
  });

  it('does not enlarge an image smaller than the long edge', async () => {
    const dest = join(await mkdtemp(join(tmpdir(), 'thumb-')), 'b.jpg');
    await writeThumbnail(img(100, 80), dest);
    expect((await sharp(await readFile(dest)).metadata()).width).toBe(100);
  });
});

describe('thumbPathFor', () => {
  it('flattens nested ids into a single safe filename', () => {
    const p = thumbPathFor('/runs/r1', join('sub', 'deep', 'photo.jpg'));
    expect(p.startsWith('/runs/r1')).toBe(true);
    expect(p.slice('/runs/r1/'.length)).not.toContain('/');
    expect(p.endsWith('.jpg')).toBe(true);
  });

  it('refuses to let a traversing id escape the run directory', () => {
    const p = thumbPathFor('/runs/r1', join('..', '..', 'etc', 'passwd'));
    expect(p.startsWith('/runs/r1/')).toBe(true);
    expect(p).not.toContain('..');
  });

  it('gives different ids different paths and is stable for the same id', () => {
    expect(thumbPathFor('/r', 'a.jpg')).not.toBe(thumbPathFor('/r', 'b.jpg'));
    expect(thumbPathFor('/r', 'a.jpg')).toBe(thumbPathFor('/r', 'a.jpg'));
  });
});

describe('thumbUrl', () => {
  it('addresses the same file the writer produced', () => {
    const url = thumbUrl('run-1', 'a.jpg');
    expect(url.startsWith('triage-thumb://run-1/')).toBe(true);
    expect(url.endsWith('.jpg')).toBe(true);
    // The URL's filename and the written path's filename must agree, or every
    // thumbnail in the grid silently 404s.
    expect(new URL(url).pathname.slice(1)).toBe(thumbPathFor('/r', 'a.jpg').split('/').pop());
  });
});
