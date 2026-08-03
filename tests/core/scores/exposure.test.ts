import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { decodeToWorking, toGray } from '../../../src/core/decode.ts';
import { scoreExposure, exposureDetail } from '../../../src/core/scores/exposure.ts';
import { FIXTURE_DIR } from '../../fixtures/globalSetup.ts';

async function gray(name: string) {
  return toGray(await decodeToWorking(join(FIXTURE_DIR, name), 'png'));
}

describe('scoreExposure', () => {
  it('scores a well-exposed frame above an overexposed one', async () => {
    expect(scoreExposure(await gray('sharp.png'))).toBeGreaterThan(scoreExposure(await gray('overexposed.png')));
  });

  it('scores a well-exposed frame above an underexposed one', async () => {
    expect(scoreExposure(await gray('sharp.png'))).toBeGreaterThan(scoreExposure(await gray('underexposed.png')));
  });

  it('penalises very low contrast', async () => {
    expect(scoreExposure(await gray('sharp.png'))).toBeGreaterThan(scoreExposure(await gray('lowcontrast.png')));
  });

  it('stays inside 0-100', async () => {
    for (const n of ['sharp.png', 'overexposed.png', 'underexposed.png', 'lowcontrast.png']) {
      const s = scoreExposure(await gray(n));
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(100);
    }
  });

  it('reports highlight clipping on the overexposed fixture', async () => {
    const d = exposureDetail(await gray('overexposed.png'));
    expect(d.clipHigh).toBeGreaterThan(d.clipLow);
  });
});
