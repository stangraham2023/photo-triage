import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanDirectory } from '../../src/core/scan.ts';

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'scan-'));
  await writeFile(join(root, 'a.jpg'), 'x');
  await writeFile(join(root, 'b.HEIC'), 'x');
  await writeFile(join(root, 'notes.txt'), 'x');
  await mkdir(join(root, 'sub'), { recursive: true });
  await writeFile(join(root, 'sub', 'c.cr2'), 'x');
});

describe('scanDirectory', () => {
  it('finds images recursively and reports relative paths', async () => {
    const r = await scanDirectory(root);
    expect(r.images.map((f) => f.relPath).sort()).toEqual(['a.jpg', 'b.HEIC', join('sub', 'c.cr2')].sort());
  });

  it('counts non-image files as skipped rather than failing', async () => {
    const r = await scanDirectory(root);
    expect(r.skipped).toBe(1);
  });

  it('lowercases the extension', async () => {
    const r = await scanDirectory(root);
    expect(r.images.find((f) => f.relPath === 'b.HEIC')?.ext).toBe('heic');
  });

  it('stays in the top folder when recurse is false', async () => {
    const r = await scanDirectory(root, { recurse: false });
    expect(r.images.map((f) => f.relPath).sort()).toEqual(['a.jpg', 'b.HEIC']);
  });
});

describe('cloud placeholders', () => {
  it('marks an ordinary local file as on disk', async () => {
    const r = await scanDirectory(root);
    expect(r.images.every((f) => f.onDisk)).toBe(true);
    expect(r.notDownloaded).toBe(0);
  });
});
