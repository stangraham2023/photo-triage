import sharp from 'sharp';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const W = 512;
const H = 384;

interface PatternOpts {
  seed: number;
  /** Horizontal shift in pixels, used to fake successive burst frames. */
  offsetX?: number;
  /** Size of the large-scale blocks. Changing it makes a structurally different scene. */
  blockW?: number;
  blockH?: number;
}

/**
 * Deterministic synthetic "photo".
 *
 * Deliberately built at two scales, because that is what makes it behave like a
 * real photograph under blur:
 *   - large blocks and a gradient carry the low-frequency contrast, which
 *     survives blurring (a subject is still lighter than its background)
 *   - a fine checkerboard plus noise carries the high-frequency detail, which
 *     blurring destroys
 * A single-scale pattern would lose both at once, and any sharpness metric
 * normalised by contrast would then rate a blurred frame almost as highly as a
 * sharp one.
 */
function pattern(o: PatternOpts): Buffer {
  const { seed, offsetX = 0 } = o;
  const buf = Buffer.alloc(W * H * 3);

  // Seeded generator for the blob layout, so fixtures are identical everywhere.
  let rs = seed >>> 0;
  const rnd = () => {
    rs = (rs * 1664525 + 1013904223) >>> 0;
    return rs / 4294967296;
  };

  // Smooth irregular blobs give BROADBAND low-frequency energy. A regular block
  // grid would concentrate nearly all DCT energy at one frequency, leaving the
  // rest of the coefficients clustered around zero — and therefore around the
  // perceptual hash's median, where they flip on the slightest change. Real
  // photographs are broadband; the fixture has to be too or pHash tests are
  // measuring noise.
  const blobs = Array.from({ length: 7 }, () => ({
    cx: rnd() * W,
    cy: rnd() * H,
    r: 45 + rnd() * 130,
    amp: (rnd() < 0.5 ? -1 : 1) * (35 + rnd() * 55),
  }));

  let ns = (seed * 7919 + 13) >>> 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      ns = (ns * 1664525 + 1013904223) >>> 0;
      const sx = x + offsetX;

      let v = 118 + (sx / W) * 26 - (y / H) * 14;
      for (const b of blobs) {
        const dx = sx - b.cx;
        const dy = y - b.cy;
        v += b.amp * Math.exp(-(dx * dx + dy * dy) / (2 * b.r * b.r));
      }
      // Fine detail: destroyed by blurring, invisible after a 32x32 downsample.
      v += ((sx >> 2) % 2 === (y >> 2) % 2) ? 22 : -22;
      v += ((ns >>> 24) % 20) - 10;

      const c = Math.max(0, Math.min(255, v));
      const i = (y * W + x) * 3;
      buf[i] = c;
      buf[i + 1] = Math.max(0, Math.min(255, c * 0.94 + 6));
      buf[i + 2] = Math.max(0, Math.min(255, c * 0.88 + 12));
    }
  }
  return buf;
}

function raw(buf: Buffer) {
  return sharp(buf, { raw: { width: W, height: H, channels: 3 } });
}

export async function generateFixtures(outDir: string): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const base = pattern({ seed: 42 });

  await raw(base).png().toFile(join(outDir, 'sharp.png'));
  await raw(base).blur(6).png().toFile(join(outDir, 'blurry.png'));
  await raw(base).linear(1.9, 60).png().toFile(join(outDir, 'overexposed.png'));
  await raw(base).linear(0.28, -12).png().toFile(join(outDir, 'underexposed.png'));
  await raw(base).linear(0.16, 110).png().toFile(join(outDir, 'lowcontrast.png'));

  // Burst: three frames of the SAME rendered scene, each translated a couple of
  // pixels — which is what a real burst is (identical subject, slight camera
  // movement). Re-rendering the pattern at an offset instead would change the
  // fine detail's phase, which is a different image, not a moved one.
  //
  // Built from its own scene, not from `base`. Cropping `base` would make every
  // burst frame a near-duplicate of sharp.png too, so the burst group would
  // swallow the sharpness fixtures and tests could not tell the two behaviours
  // apart.
  const burstBase = pattern({ seed: 7 });
  const BURST_W = W - 8;
  for (let i = 1; i <= 3; i++) {
    await raw(burstBase)
      .extract({ left: i * 2, top: 0, width: BURST_W, height: H })
      .png().toFile(join(outDir, `burst-${i}.png`));
  }
  // Structurally different scene — different seed AND different block layout,
  // so its perceptual hash is genuinely far from the burst frames.
  await raw(pattern({ seed: 9999 }))
    .png().toFile(join(outDir, 'different.png'));

  // Truncated JPEG header — decodes to nothing, exercises the unreadable path.
  await writeFile(join(outDir, 'corrupt.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a]));
}
