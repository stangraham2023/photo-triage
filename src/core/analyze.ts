import type { FaceDetector, PhotoRecord, ScannedFile } from './types.ts';
import { decodeToWorking, toGray, UnreadableError } from './decode.ts';
import { MetadataReader } from './metadata.ts';
import { scoreBlur, scoreFaceBlur } from './scores/blur.ts';
import { scoreExposure } from './scores/exposure.ts';
import { perceptualHash } from './scores/phash.ts';
import { filterSignificantFaces, minEyeScore } from './scores/faces.ts';

export async function analyzePhoto(
  file: ScannedFile,
  reader: MetadataReader,
  detector: FaceDetector,
): Promise<PhotoRecord> {
  const meta = await reader.read(file.absPath);
  const img = await decodeToWorking(file.absPath, file.ext, {}, (p) => reader.extractRawPreview(p));
  const gray = toGray(img);

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
): Promise<{ records: PhotoRecord[]; unreadable: ScannedFile[] }> {
  const records: PhotoRecord[] = [];
  const unreadable: ScannedFile[] = [];

  for (const [i, file] of files.entries()) {
    try {
      records.push(await analyzePhoto(file, reader, detector));
    } catch (err) {
      // A file we cannot decode is reported, never silently dropped.
      if (err instanceof UnreadableError) unreadable.push(file);
      else throw err;
    }
    onProgress?.(i + 1, files.length, file.relPath);
  }
  return { records, unreadable };
}
