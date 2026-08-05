/** Relative path from the source root, used as a stable identifier. */
export type PhotoId = string;

export interface ScannedFile {
  absPath: string;
  relPath: PhotoId;
  ext: string;          // lowercase, no dot
  bytes: number;
  mtimeMs: number;
  /**
   * False when the file is a cloud placeholder — iCloud or OneDrive shows a
   * name and a size, but the bytes live on a server. Reading one would make
   * macOS download it, so these are skipped rather than analysed.
   */
  onDisk: boolean;
}

export interface PhotoMetadata {
  captureTimeMs: number | null;
  orientation: number;               // EXIF 1-8; 1 when unknown
  cameraModel: string | null;
}

/** RGBA pixel buffer. Always 4 channels. */
export interface WorkingImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/** Single-channel luminance, 0-255 as floats. */
export interface GrayImage {
  width: number;
  height: number;
  data: Float32Array;
}

/** Normalized 0-1 coordinates relative to image dimensions. */
export interface FaceBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FaceResult {
  box: FaceBox;
  /** 0-1, higher means more open. Minimum of the two eyes. */
  eyeOpenScore: number;
  /** 0-1 detector confidence. */
  confidence: number;
}

export interface FaceDetector {
  detect(img: WorkingImage): Promise<FaceResult[]>;
}

export interface Scores {
  /** 0-100, higher is sharper. Whole frame. */
  blurGlobal: number;
  /** 0-100, higher is sharper. 90th-percentile tile. */
  blurSharpestRegion: number;
  /** 0-100. Lowest face-region sharpness, or null when no faces. */
  blurFaceMin: number | null;
  /** 0-100, higher is better exposed. */
  exposure: number;
  /** 0-1. Lowest eye-open score across faces, or null when no faces. */
  eyeMin: number | null;
  faceCount: number;
  /** 16 hex characters. */
  phash: string;
}

export interface PhotoRecord {
  file: ScannedFile;
  meta: PhotoMetadata;
  scores: Scores;
  /**
   * Significant faces only, in detector order. Carried through so the review
   * screen can show a crop of the face behind an "eyes closed" verdict — a
   * blink call the user cannot check is a blink call they cannot trust.
   */
  faces: FaceResult[];
}

export type ReasonCode = 'blur' | 'eyes-closed' | 'exposure' | 'duplicate';

export interface Reason {
  code: ReasonCode;
  /** Human-readable, shown verbatim in the UI chip and the CSV. */
  detail: string;
  score: number;
  threshold: number;
}

export type Verdict = 'good' | 'rejected' | 'unreadable' | 'not-downloaded';

export interface Decision {
  id: PhotoId;
  verdict: Verdict;
  reasons: Reason[];
  /** Burst group identifier, or null when the photo is not in a group. */
  groupId: string | null;
  isGroupKeeper: boolean;
}

export interface Thresholds {
  enableBlur: boolean;
  enableEyes: boolean;
  enableExposure: boolean;
  enableDuplicates: boolean;
  /** Minimum acceptable blurSharpestRegion. */
  blur: number;
  /** Minimum acceptable blurFaceMin. */
  faceBlur: number;
  /** Minimum acceptable eyeMin. */
  eyes: number;
  /** Minimum acceptable exposure. */
  exposure: number;
  burstHammingMax: number;
  burstWindowMs: number;
}

export type PresetName = 'event' | 'portrait' | 'landscape';
