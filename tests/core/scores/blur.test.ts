import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { decodeToWorking, toGray } from '../../../src/core/decode.ts';
import { scoreBlur, scoreFaceBlur } from '../../../src/core/scores/blur.ts';
import { FIXTURE_DIR } from '../../fixtures/globalSetup.ts';

async function gray(name: string) {
  return toGray(await decodeToWorking(join(FIXTURE_DIR, name), 'png'));
}

describe('scoreBlur', () => {
  it('scores a sharp image far higher than a blurred one', async () => {
    const s = scoreBlur(await gray('sharp.png'));
    const b = scoreBlur(await gray('blurry.png'));
    expect(s.sharpestRegion).toBeGreaterThan(b.sharpestRegion * 2);
  });

  it('keeps every score inside 0-100', async () => {
    for (const name of ['sharp.png', 'blurry.png', 'lowcontrast.png']) {
      const s = scoreBlur(await gray(name));
      expect(s.global).toBeGreaterThanOrEqual(0);
      expect(s.global).toBeLessThanOrEqual(100);
      expect(s.sharpestRegion).toBeGreaterThanOrEqual(0);
      expect(s.sharpestRegion).toBeLessThanOrEqual(100);
    }
  });

  it('does not penalise low contrast as if it were blur', async () => {
    // A sharp but low-contrast frame must not score like a blurred one.
    // This is what the contrast normalisation exists for.
    const low = scoreBlur(await gray('lowcontrast.png'));
    const blurred = scoreBlur(await gray('blurry.png'));
    expect(low.sharpestRegion).toBeGreaterThan(blurred.sharpestRegion);
  });

  it('rates the sharpest region at least as high as the global score', async () => {
    const s = scoreBlur(await gray('sharp.png'));
    expect(s.sharpestRegion).toBeGreaterThanOrEqual(s.global - 1);
  });
});

describe('scoreFaceBlur', () => {
  it('returns null when there are no faces', async () => {
    expect(scoreFaceBlur(await gray('sharp.png'), [])).toBeNull();
  });

  it('returns the minimum across face regions', async () => {
    const g = await gray('sharp.png');
    const one = scoreFaceBlur(g, [{ x: 0.1, y: 0.1, width: 0.2, height: 0.2 }]);
    const two = scoreFaceBlur(g, [
      { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
      { x: 0.5, y: 0.5, width: 0.2, height: 0.2 },
    ]);
    expect(two!).toBeLessThanOrEqual(one!);
  });
});
