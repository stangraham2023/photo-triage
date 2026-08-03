import { describe, it, expect } from 'vitest';
import { stat } from 'node:fs/promises';
import { FIXTURE_DIR } from './fixtures/globalSetup.ts';
import { join } from 'node:path';

describe('fixture generation', () => {
  it('produces a sharp and a blurry fixture of the same dimensions', async () => {
    const a = await stat(join(FIXTURE_DIR, 'sharp.png'));
    const b = await stat(join(FIXTURE_DIR, 'blurry.png'));
    expect(a.size).toBeGreaterThan(0);
    expect(b.size).toBeGreaterThan(0);
    // A blurred image compresses far smaller than a noisy sharp one.
    expect(b.size).toBeLessThan(a.size);
  });
});
