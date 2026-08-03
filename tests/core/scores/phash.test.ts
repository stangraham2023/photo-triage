import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { decodeToWorking } from '../../../src/core/decode.ts';
import { perceptualHash, hammingDistance } from '../../../src/core/scores/phash.ts';
import { FIXTURE_DIR } from '../../fixtures/globalSetup.ts';

const hash = async (n: string) => perceptualHash(await decodeToWorking(join(FIXTURE_DIR, n), 'png'));

describe('perceptualHash', () => {
  it('returns 16 hex characters', async () => {
    expect(await hash('sharp.png')).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is deterministic', async () => {
    expect(await hash('sharp.png')).toBe(await hash('sharp.png'));
  });

  it('gives near-identical burst frames a small distance', async () => {
    expect(hammingDistance(await hash('burst-1.png'), await hash('burst-2.png'))).toBeLessThanOrEqual(10);
  });

  it('gives an unrelated frame a large distance', async () => {
    const d = hammingDistance(await hash('burst-1.png'), await hash('different.png'));
    expect(d).toBeGreaterThan(10);
  });
});

describe('hammingDistance', () => {
  it('is zero for identical hashes', () => {
    expect(hammingDistance('00ff00ff00ff00ff', '00ff00ff00ff00ff')).toBe(0);
  });

  it('counts differing bits', () => {
    expect(hammingDistance('0000000000000000', '0000000000000001')).toBe(1);
    expect(hammingDistance('0000000000000000', 'ffffffffffffffff')).toBe(64);
  });
});
