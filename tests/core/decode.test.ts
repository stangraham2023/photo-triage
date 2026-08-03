import { describe, it, expect, beforeAll } from 'vitest';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeToWorking, toGray, UnreadableError } from '../../src/core/decode.ts';
import { FIXTURE_DIR } from '../fixtures/globalSetup.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
let heicPath: string;

beforeAll(async () => {
  const b64 = await readFile(join(HERE, '..', 'fixtures', 'hevc-sample.heic.base64'), 'utf8');
  const dir = await mkdtemp(join(tmpdir(), 'decode-'));
  heicPath = join(dir, 'sample.heic');
  await writeFile(heicPath, Buffer.from(b64.trim(), 'base64'));
});

describe('decodeToWorking', () => {
  it('decodes PNG to RGBA', async () => {
    const img = await decodeToWorking(join(FIXTURE_DIR, 'sharp.png'), 'png');
    expect(img.data.length).toBe(img.width * img.height * 4);
    expect(img.width).toBeGreaterThan(0);
  });

  it('downscales to the requested long edge', async () => {
    const img = await decodeToWorking(join(FIXTURE_DIR, 'sharp.png'), 'png', { longEdge: 128 });
    expect(Math.max(img.width, img.height)).toBe(128);
  });

  it('decodes HEVC-coded HEIC, which sharp cannot do', async () => {
    const img = await decodeToWorking(heicPath, 'heic');
    expect(img.width).toBe(400);
    expect(img.height).toBe(300);
    // Solid RGB(120,80,200); allow slop for YUV round-tripping.
    expect(img.data[0]).toBeGreaterThan(110);
    expect(img.data[0]).toBeLessThan(130);
    expect(img.data[2]).toBeGreaterThan(190);
  });

  it('throws UnreadableError on a corrupt file', async () => {
    await expect(decodeToWorking(join(FIXTURE_DIR, 'corrupt.jpg'), 'jpg'))
      .rejects.toBeInstanceOf(UnreadableError);
  });
});

describe('toGray', () => {
  it('converts a known colour to Rec.709 luminance', () => {
    const img = { width: 1, height: 1, data: new Uint8ClampedArray([255, 255, 255, 255]) };
    expect(toGray(img).data[0]).toBeCloseTo(255, 0);
  });

  it('gives green more weight than blue', () => {
    const green = toGray({ width: 1, height: 1, data: new Uint8ClampedArray([0, 255, 0, 255]) });
    const blue = toGray({ width: 1, height: 1, data: new Uint8ClampedArray([0, 0, 255, 255]) });
    expect(green.data[0]!).toBeGreaterThan(blue.data[0]!);
  });
});
