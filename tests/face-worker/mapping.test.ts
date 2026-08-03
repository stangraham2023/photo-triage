import { describe, it, expect } from 'vitest';
import { toFaceResults, type MpLikeResult } from '../../src/face-worker/mapping.ts';

/** 478 landmarks at a default position, with individual eye points overridable. */
function landmarks(overrides: Record<number, { x: number; y: number }> = {}) {
  const pts = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5 }));
  // A face spanning roughly 0.3-0.7 horizontally.
  pts[0] = { x: 0.3, y: 0.3 };
  pts[1] = { x: 0.7, y: 0.7 };
  for (const [i, p] of Object.entries(overrides)) pts[Number(i)] = p;
  return pts;
}

const blend = (left: number, right: number) => ({
  categories: [
    { categoryName: 'eyeBlinkLeft', score: left },
    { categoryName: 'eyeBlinkRight', score: right },
  ],
});

const result = (mp: Partial<MpLikeResult>): MpLikeResult =>
  ({ faceLandmarks: [landmarks()], ...mp }) as MpLikeResult;

const EYES_OPEN = {
  33: { x: 0.40, y: 0.50 }, 133: { x: 0.46, y: 0.50 },
  159: { x: 0.43, y: 0.482 }, 145: { x: 0.43, y: 0.518 },
  362: { x: 0.54, y: 0.50 }, 263: { x: 0.60, y: 0.50 },
  386: { x: 0.57, y: 0.482 }, 374: { x: 0.57, y: 0.518 },
};

const EYES_SHUT = {
  33: { x: 0.40, y: 0.50 }, 133: { x: 0.46, y: 0.50 },
  159: { x: 0.43, y: 0.4995 }, 145: { x: 0.43, y: 0.5005 },
  362: { x: 0.54, y: 0.50 }, 263: { x: 0.60, y: 0.50 },
  386: { x: 0.57, y: 0.4995 }, 374: { x: 0.57, y: 0.5005 },
};

describe('toFaceResults', () => {
  it('returns nothing when no face was found', () => {
    expect(toFaceResults({ faceLandmarks: [] })).toEqual([]);
  });

  it('reports eyes open when blink scores are low', () => {
    const [f] = toFaceResults(result({ faceBlendshapes: [blend(0.02, 0.03)] }));
    expect(f!.eyeOpenScore).toBeGreaterThan(0.9);
  });

  it('reports eyes closed when blink scores are high', () => {
    const [f] = toFaceResults(result({ faceBlendshapes: [blend(0.95, 0.93)] }));
    expect(f!.eyeOpenScore).toBeLessThan(0.1);
  });

  it('takes the worst of the two eyes — a one-eyed blink still counts', () => {
    const [f] = toFaceResults(result({ faceBlendshapes: [blend(0.9, 0.01)] }));
    expect(f!.eyeOpenScore).toBeLessThan(0.2);
  });

  it('scores a half-closed eye between open and shut', () => {
    const half = toFaceResults(result({ faceBlendshapes: [blend(0.55, 0.5)] }))[0]!;
    const open = toFaceResults(result({ faceBlendshapes: [blend(0.02, 0.02)] }))[0]!;
    const shut = toFaceResults(result({ faceBlendshapes: [blend(0.97, 0.97)] }))[0]!;
    expect(half.eyeOpenScore).toBeLessThan(open.eyeOpenScore);
    expect(half.eyeOpenScore).toBeGreaterThan(shut.eyeOpenScore);
  });

  it('derives a normalised bounding box from the landmark extents', () => {
    const [f] = toFaceResults(result({ faceBlendshapes: [blend(0.1, 0.1)] }));
    expect(f!.box.x).toBeCloseTo(0.3, 1);
    expect(f!.box.width).toBeCloseTo(0.4, 1);
    expect(f!.box.width).toBeGreaterThan(0);
  });

  it('falls back to eye-aspect-ratio when blendshapes are absent', () => {
    const open = toFaceResults({ faceLandmarks: [landmarks(EYES_OPEN)] });
    const shut = toFaceResults({ faceLandmarks: [landmarks(EYES_SHUT)] });
    expect(open[0]!.eyeOpenScore).toBeGreaterThan(shut[0]!.eyeOpenScore + 0.4);
  });

  it('lowers confidence when the two measures disagree sharply', () => {
    // Blendshape says wide open; the landmarks say shut.
    const conflicted = toFaceResults({
      faceLandmarks: [landmarks(EYES_SHUT)],
      faceBlendshapes: [blend(0.01, 0.01)],
    });
    const agreed = toFaceResults({
      faceLandmarks: [landmarks(EYES_OPEN)],
      faceBlendshapes: [blend(0.01, 0.01)],
    });
    expect(conflicted[0]!.confidence).toBeLessThan(agreed[0]!.confidence);
  });

  it('maps every detected face', () => {
    expect(toFaceResults({
      faceLandmarks: [landmarks(), landmarks()],
      faceBlendshapes: [blend(0.1, 0.1), blend(0.9, 0.9)],
    })).toHaveLength(2);
  });
});
