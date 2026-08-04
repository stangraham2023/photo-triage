import type { FaceDetector, PhotoRecord, ScannedFile, WorkingImage } from './types.ts';
import { decodeToWorking, toGray, UnreadableError } from './decode.ts';
import { MetadataReader } from './metadata.ts';
import { scoreBlur, scoreFaceBlur } from './scores/blur.ts';
import { scoreExposure } from './scores/exposure.ts';
import { perceptualHash } from './scores/phash.ts';
import { filterSignificantFaces, minEyeScore } from './scores/faces.ts';

export interface AnalyzeOptions {
  /**
   * Called with the decoded pixels before scoring. Lets a caller reuse them —
   * to write a thumbnail, say — without core learning anything about the
   * filesystem, and without decoding the photo a second time.
   */
  onWorkingImage?: (img: WorkingImage, file: ScannedFile) => Promise<void>;
}

export async function analyzePhoto(
  file: ScannedFile,
  reader: MetadataReader,
  detector: FaceDetector,
  opts: AnalyzeOptions = {},
): Promise<PhotoRecord> {
  const meta = await reader.read(file.absPath);
  const img = await decodeToWorking(file.absPath, file.ext, {}, (p) => reader.extractRawPreview(p));
  const gray = toGray(img);
  await opts.onWorkingImage?.(img, file);

  const faces = filterSignificantFaces(await detector.detect(img));
  const blur = scoreBlur(gray);

  return {
    file,
    meta,
    faces,
    scores: {
      blurGlobal: blur.global,
      blurSharpestRegion: blur.sharpestRegion,
      blurFaceMin: scoreFaceBlur(gray, faces.map((f) => f.box)),
      exposure: scoreExposure(gray),
      eyeMin: minEyeScore(faces),
      faceCount: faces.length,
      phash: await perceptualHash(img),
    },
  };
}

export async function analyzeAll(
  files: ScannedFile[],
  reader: MetadataReader,
  detector: FaceDetector,
  onProgress?: (done: number, total: number, current: string) => void,
  opts: AnalyzeOptions = {},
): Promise<{ records: PhotoRecord[]; unreadable: ScannedFile[] }> {
  const records: PhotoRecord[] = [];
  const unreadable: ScannedFile[] = [];

  for (const [i, file] of files.entries()) {
    try {
      records.push(await analyzePhoto(file, reader, detector, opts));
    } catch (err) {
      // A file we cannot decode is reported, never silently dropped.
      if (err instanceof UnreadableError) unreadable.push(file);
      else throw err;
    }
    onProgress?.(i + 1, files.length, file.relPath);
  }
  return { records, unreadable };
}
