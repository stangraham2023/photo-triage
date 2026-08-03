import { describe, it, expect } from 'vitest';
import {
  NullFaceDetector, StubFaceDetector, filterSignificantFaces, minEyeScore,
} from '../../../src/core/scores/faces.ts';
import type { FaceResult } from '../../../src/core/types.ts';

const face = (w: number, eye: number): FaceResult => ({
  box: { x: 0.1, y: 0.1, width: w, height: w },
  eyeOpenScore: eye,
  confidence: 0.9,
});

const img = { width: 100, height: 100, data: new Uint8ClampedArray(100 * 100 * 4) };

describe('NullFaceDetector', () => {
  it('finds no faces', async () => {
    expect(await new NullFaceDetector().detect(img)).toEqual([]);
  });
});

describe('StubFaceDetector', () => {
  it('returns what it was constructed with', async () => {
    const f = face(0.3, 0.8);
    expect(await new StubFaceDetector([f]).detect(img)).toEqual([f]);
  });
});

describe('filterSignificantFaces', () => {
  it('drops faces below the minimum width fraction', () => {
    expect(filterSignificantFaces([face(0.3, 0.9), face(0.01, 0.1)])).toHaveLength(1);
  });

  it('keeps faces at exactly the threshold', () => {
    expect(filterSignificantFaces([face(0.04, 0.9)])).toHaveLength(1);
  });
});

describe('minEyeScore', () => {
  it('returns null when there are no faces', () => {
    expect(minEyeScore([])).toBeNull();
  });

  it('returns the worst eye score, because one blinker ruins a group shot', () => {
    expect(minEyeScore([face(0.3, 0.9), face(0.3, 0.12), face(0.3, 0.7)])).toBeCloseTo(0.12);
  });
});
