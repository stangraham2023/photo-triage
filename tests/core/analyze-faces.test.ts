import { describe, it, expect, afterAll } from 'vitest';
import { join } from 'node:path';
import { analyzePhoto } from '../../src/core/analyze.ts';
import { MetadataReader } from '../../src/core/metadata.ts';
import { StubFaceDetector, NullFaceDetector } from '../../src/core/scores/faces.ts';
import { FIXTURE_DIR } from '../fixtures/globalSetup.ts';
import type { ScannedFile } from '../../src/core/types.ts';

const reader = new MetadataReader();
afterAll(() => reader.close());

const file = (name: string): ScannedFile => ({
  absPath: join(FIXTURE_DIR, name), relPath: name, ext: 'png', bytes: 1, mtimeMs: 0, onDisk: true });

describe('analyzePhoto face reporting', () => {
  it('keeps the boxes of significant faces', async () => {
    const face = { box: { x: 0.2, y: 0.1, width: 0.3, height: 0.3 }, eyeOpenScore: 0.1, confidence: 0.9 };
    const r = await analyzePhoto(file('sharp.png'), reader, new StubFaceDetector([face]));
    expect(r.faces).toHaveLength(1);
    expect(r.faces[0]!.box.width).toBeCloseTo(0.3);
  });

  it('drops faces too small to be significant, matching faceCount', async () => {
    const big = { box: { x: 0.2, y: 0.1, width: 0.3, height: 0.3 }, eyeOpenScore: 0.9, confidence: 0.9 };
    const tiny = { box: { x: 0.8, y: 0.8, width: 0.01, height: 0.01 }, eyeOpenScore: 0.1, confidence: 0.9 };
    const r = await analyzePhoto(file('sharp.png'), reader, new StubFaceDetector([big, tiny]));
    expect(r.faces).toHaveLength(1);
    expect(r.scores.faceCount).toBe(1);
    // The tiny face's shut eyes must not drag the score down.
    expect(r.scores.eyeMin).toBeCloseTo(0.9);
  });

  it('reports an empty list when there are no faces', async () => {
    const r = await analyzePhoto(file('sharp.png'), reader, new NullFaceDetector());
    expect(r.faces).toEqual([]);
  });
});
