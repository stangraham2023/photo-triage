import type { FaceResult } from '../core/types.ts';

export interface MpPoint { x: number; y: number }
export interface MpBlendshapes {
  categories: Array<{ categoryName: string; score: number }>;
}
export interface MpLikeResult {
  faceLandmarks: MpPoint[][];
  faceBlendshapes?: MpBlendshapes[];
}

/** CALIBRATION. Eye-aspect ratio at which an eye counts as fully open. */
export const EAR_OPEN_RATIO = 0.28;
/** Disagreement between the two measures above which confidence is reduced. */
export const CONFIDENCE_DISAGREEMENT = 0.4;

// Canonical MediaPipe face-mesh eyelid indices.
const LEFT = { outer: 33, inner: 133, upper: 159, lower: 145 };
const RIGHT = { outer: 362, inner: 263, upper: 386, lower: 374 };

function dist(a: MpPoint, b: MpPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Vertical eyelid separation over horizontal eye width. */
function eyeAspectRatio(pts: MpPoint[], idx: typeof LEFT): number | null {
  const outer = pts[idx.outer], inner = pts[idx.inner];
  const upper = pts[idx.upper], lower = pts[idx.lower];
  if (!outer || !inner || !upper || !lower) return null;
  const width = dist(outer, inner);
  if (width <= 0) return null;
  return dist(upper, lower) / width;
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

export function toFaceResults(mp: MpLikeResult): FaceResult[] {
  return mp.faceLandmarks.map((pts, i) => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pts) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }

    // Landmark-derived openness, worst eye.
    const ears = [eyeAspectRatio(pts, LEFT), eyeAspectRatio(pts, RIGHT)]
      .filter((e): e is number => e !== null);
    const earOpen = ears.length ? clamp01(Math.min(...ears) / EAR_OPEN_RATIO) : null;

    // Blendshape-derived openness, worst eye. This is the primary signal: the
    // blink blendshapes are purpose-built for exactly this question.
    const cats = mp.faceBlendshapes?.[i]?.categories ?? [];
    const blink = (name: string) => cats.find((c) => c.categoryName === name)?.score;
    const bl = blink('eyeBlinkLeft');
    const br = blink('eyeBlinkRight');
    const blendOpen = bl !== undefined || br !== undefined
      ? clamp01(1 - Math.max(bl ?? 0, br ?? 0))
      : null;

    const eyeOpenScore = blendOpen ?? earOpen ?? 1;

    // The two measures are a cross-check, not a blend. Averaging them would
    // hide a disagreement; reporting lower confidence surfaces it to the user.
    let confidence = 0.9;
    if (blendOpen !== null && earOpen !== null
        && Math.abs(blendOpen - earOpen) > CONFIDENCE_DISAGREEMENT) {
      confidence = 0.45;
    }

    return {
      box: { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
      eyeOpenScore,
      confidence,
    };
  });
}
