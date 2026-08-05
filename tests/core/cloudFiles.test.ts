import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  looksNotDownloaded, parseDatalessFlags, confirmNotDownloaded, CLOUD_DETECTION_SUPPORTED,
} from '../../src/core/cloudFiles.ts';

describe('looksNotDownloaded', () => {
  it('flags a file with a size but no allocated blocks', () => {
    expect(looksNotDownloaded({ size: 4_000_000, blocks: 0 })).toBe(true);
  });

  it('ignores a normal file', () => {
    expect(looksNotDownloaded({ size: 4_000_000, blocks: 7813 })).toBe(false);
  });

  it('ignores a genuinely empty file', () => {
    expect(looksNotDownloaded({ size: 0, blocks: 0 })).toBe(false);
  });
});

describe('parseDatalessFlags', () => {
  it('accepts a placeholder', () => {
    expect(parseDatalessFlags('compressed,dataless|/a/photo.jpg').has('/a/photo.jpg')).toBe(true);
  });

  // The trap: a filesystem-compressed file also reports zero blocks, so the
  // cheap prefilter flags it. Only `dataless` means the data is absent.
  it('rejects a merely compressed file', () => {
    expect(parseDatalessFlags('compressed|/a/photo.jpg').has('/a/photo.jpg')).toBe(false);
  });

  it('rejects a file with no flags at all', () => {
    expect(parseDatalessFlags('-|/a/photo.jpg').size).toBe(0);
  });

  it('does not match a flag that merely contains the word', () => {
    expect(parseDatalessFlags('notdataless|/a/photo.jpg').size).toBe(0);
  });

  it('handles paths containing the separator character', () => {
    const out = parseDatalessFlags('dataless|/a/weird|name.jpg');
    expect(out.has('/a/weird|name.jpg')).toBe(true);
  });

  it('handles several lines', () => {
    const out = parseDatalessFlags('dataless|/a.jpg\n-|/b.jpg\ncompressed,dataless|/c.jpg');
    expect([...out].sort()).toEqual(['/a.jpg', '/c.jpg']);
  });
});

describe('confirmNotDownloaded', () => {
  it('returns nothing for an empty list', async () => {
    expect((await confirmNotDownloaded([])).size).toBe(0);
  });

  it('does not flag an ordinary file on disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cloud-'));
    const file = join(dir, 'real.jpg');
    await writeFile(file, 'some actual bytes');
    expect((await confirmNotDownloaded([file])).has(file)).toBe(false);
  });

  it('survives a path that does not exist', async () => {
    await expect(confirmNotDownloaded(['/no/such/file.jpg'])).resolves.toBeInstanceOf(Set);
  });

  it('is a no-op where detection is unsupported', async () => {
    if (CLOUD_DETECTION_SUPPORTED) return;
    expect((await confirmNotDownloaded(['/anything'])).size).toBe(0);
  });
});

/**
 * Runs against a genuine cloud placeholder when the machine has one.
 *
 * Mocked flag strings prove the parser; only a real offloaded file proves the
 * whole chain — that macOS reports `dataless`, that `stat` reads it without
 * triggering a download, and that the two halves agree.
 */
describe('against a real cloud placeholder', () => {
  it('identifies an offloaded file without downloading it', async () => {
    const { statSync, existsSync } = await import('node:fs');
    const { homedir } = await import('node:os');
    const { join } = await import('node:path');

    const candidate = join(homedir(), 'Library', 'CloudStorage', 'OneDrive-Personal',
      'Getting started with OneDrive.pdf');
    if (!CLOUD_DETECTION_SUPPORTED || !existsSync(candidate)) return; // nothing to check here

    const st = statSync(candidate);
    if (st.blocks !== 0) return; // already downloaded on this machine

    expect(looksNotDownloaded({ size: st.size, blocks: st.blocks })).toBe(true);
    expect((await confirmNotDownloaded([candidate])).has(candidate)).toBe(true);

    // Still offloaded: detection must not have pulled it down.
    expect(statSync(candidate).blocks).toBe(0);
  });
});
