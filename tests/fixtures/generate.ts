import sharp from 'sharp';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const W = 512;
const H = 384;

/** Deterministic pseudo-random, so fixtures are byte-identical on every machine. */
function seededNoise(seed: number, w: number, h: number, offsetX = 0): Buffer {
  const buf = Buffer.alloc(w * h * 3);
  let s = seed;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      s = (s * 1664525 + 1013904223) >>> 0;
      // High-frequency checkerboard plus noise gives strong Laplacian response.
      const check = ((x + offsetX) >> 3) % 2 === (y >> 3) % 2 ? 200 : 40;
      const n = (s >>> 24) % 56;
      const i = (y * w + x) * 3;
      buf[i] = Math.min(255, check + n);
      buf[i + 1] = Math.min(255, check + ((n * 3) % 56));
      buf[i + 2] = Math.min(255, check + ((n * 7) % 56));
    }
  }
  return buf;
}

function raw(buf: Buffer, w = W, h = H) {
  return sharp(buf, { raw: { width: w, height: h, channels: 3 } });
}

export async function generateFixtures(outDir: string): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const base = seededNoise(42, W, H);

  await raw(base).png().toFile(join(outDir, 'sharp.png'));
  await raw(base).blur(6).png().toFile(join(outDir, 'blurry.png'));
  await raw(base).linear(1.9, 60).png().toFile(join(outDir, 'overexposed.png'));
  await raw(base).linear(0.28, -12).png().toFile(join(outDir, 'underexposed.png'));
  await raw(base).linear(0.16, 110).png().toFile(join(outDir, 'lowcontrast.png'));

  // Burst: three near-identical frames, each shifted a few pixels.
  for (let i = 1; i <= 3; i++) {
    await raw(seededNoise(42, W, H, i * 2)).png().toFile(join(outDir, `burst-${i}.png`));
  }
  // A visually unrelated frame that must NOT group with the burst.
  await raw(seededNoise(9999, W, H)).png().toFile(join(outDir, 'different.png'));

  // Truncated JPEG header — decodes to nothing, exercises the unreadable path.
  await writeFile(join(outDir, 'corrupt.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a]));
}
