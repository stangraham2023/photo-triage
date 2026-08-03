import type { FaceDetector, FaceResult, WorkingImage } from '../types.ts';

/** Faces narrower than this fraction of the image width are background strangers. */
export const MIN_FACE_WIDTH_FRACTION = 0.04;

/** Used until the MediaPipe detector arrives, and whenever eye checks are disabled. */
export class NullFaceDetector implements FaceDetector {
  async detect(_img: WorkingImage): Promise<FaceResult[]> {
    return [];
  }
}

/** Test double. Returns a fixed result regardless of input. */
export class StubFaceDetector implements FaceDetector {
  private readonly faces: FaceResult[];

  constructor(faces: FaceResult[]) {
    this.faces = faces;
  }

  async detect(_img: WorkingImage): Promise<FaceResult[]> {
    return this.faces;
  }
}

export function filterSignificantFaces(faces: FaceResult[]): FaceResult[] {
  return faces.filter((f) => f.box.width >= MIN_FACE_WIDTH_FRACTION);
}

/**
 * The worst eye in the frame decides the photo. One person mid-blink in a group
 * shot is exactly the case this check exists to catch.
 */
export function minEyeScore(faces: FaceResult[]): number | null {
  if (faces.length === 0) return null;
  return faces.reduce((min, f) => Math.min(min, f.eyeOpenScore), Infinity);
}
