import { describe, it, expect, afterAll } from 'vitest';
import { join } from 'node:path';
import { MetadataReader } from '../../src/core/metadata.ts';
import { FIXTURE_DIR } from '../fixtures/globalSetup.ts';

const reader = new MetadataReader();
afterAll(() => reader.close());

describe('MetadataReader', () => {
  it('reads a PNG without throwing and defaults orientation to 1', async () => {
    const m = await reader.read(join(FIXTURE_DIR, 'sharp.png'));
    expect(m.orientation).toBe(1);
  });

  it('returns null capture time when there is no EXIF date', async () => {
    const m = await reader.read(join(FIXTURE_DIR, 'sharp.png'));
    expect(m.captureTimeMs).toBeNull();
  });

  it('returns metadata rather than throwing for a corrupt file', async () => {
    const m = await reader.read(join(FIXTURE_DIR, 'corrupt.jpg'));
    expect(m.orientation).toBe(1);
    expect(m.cameraModel).toBeNull();
  });

  it('returns null preview for a file with no embedded preview', async () => {
    expect(await reader.extractRawPreview(join(FIXTURE_DIR, 'sharp.png'))).toBeNull();
  });
});
