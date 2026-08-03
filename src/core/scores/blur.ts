import type { GrayImage, FaceBox } from '../types.ts';

/**
 * CALIBRATION. Controls where the 0-100 curve bends. Raising it makes scoring
 * stricter. Tests assert ordering only, so this can be retuned freely.
 */
export const BLUR_K = 0.3;

const TILES = 8;
const SHARPEST_PERCENTILE = 0.9;

/**
 * Laplacian variance divided by luminance variance.
 *
 * The division is the important part: raw Laplacian variance scales with scene
 * contrast, so a sharp photo of fog scores like a blurred photo of a brick wall.
 * Normalising by local contrast makes the measure scale-free.
 */
function normalisedSharpness(
  data: Float32Array, width: number,
  x0: number, y0: number, x1: number, y1: number,
): number {
  let lapSum = 0, lapSqSum = 0, lumSum = 0, lumSqSum = 0, n = 0;

  for (let y = Math.max(1, y0); y < y1 - 1; y++) {
    for (let x = Math.max(1, x0); x < x1 - 1; x++) {
      const i = y * width + x;
      const c = data[i]!;
      const lap = data[i - 1]! + data[i + 1]! + data[i - width]! + data[i + width]! - 4 * c;
      lapSum += lap;
      lapSqSum += lap * lap;
      lumSum += c;
      lumSqSum += c * c;
      n++;
    }
  }
  if (n < 16) return 0;

  const lapVar = lapSqSum / n - (lapSum / n) ** 2;
  const lumVar = lumSqSum / n - (lumSum / n) ** 2;
  return lapVar / (lumVar + 1);
}

/** Saturating map from unbounded normalised sharpness to 0-100. */
function toScore(normalised: number): number {
  return Math.max(0, Math.min(100, (100 * normalised) / (normalised + BLUR_K)));
}

export function scoreBlur(gray: GrayImage): { global: number; sharpestRegion: number } {
  const { data, width, height } = gray;
  const global = toScore(normalisedSharpness(data, width, 0, 0, width, height));

  const tileW = Math.floor(width / TILES);
  const tileH = Math.floor(height / TILES);
  const tiles: number[] = [];
  if (tileW >= 8 && tileH >= 8) {
    for (let ty = 0; ty < TILES; ty++) {
      for (let tx = 0; tx < TILES; tx++) {
        tiles.push(normalisedSharpness(
          data, width,
          tx * tileW, ty * tileH,
          tx * tileW + tileW, ty * tileH + tileH,
        ));
      }
    }
  }
  if (tiles.length === 0) return { global, sharpestRegion: global };

  tiles.sort((a, b) => a - b);
  const idx = Math.floor(SHARPEST_PERCENTILE * (tiles.length - 1));
  return { global, sharpestRegion: Math.max(global, toScore(tiles[idx]!)) };
}

export function scoreFaceBlur(gray: GrayImage, boxes: FaceBox[]): number | null {
  if (boxes.length === 0) return null;
  let min = Infinity;
  for (const b of boxes) {
    const x0 = Math.max(0, Math.floor(b.x * gray.width));
    const y0 = Math.max(0, Math.floor(b.y * gray.height));
    const x1 = Math.min(gray.width, Math.ceil((b.x + b.width) * gray.width));
    const y1 = Math.min(gray.height, Math.ceil((b.y + b.height) * gray.height));
    min = Math.min(min, toScore(normalisedSharpness(gray.data, gray.width, x0, y0, x1, y1)));
  }
  return Number.isFinite(min) ? min : null;
}
