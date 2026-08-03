import type { GrayImage } from '../types.ts';

export interface ExposureDetail {
  score: number;
  /** Fraction of pixels crushed to black. */
  clipLow: number;
  /** Fraction of pixels blown to white. */
  clipHigh: number;
  mean: number;
  /** p95 - p5 of the luminance histogram. */
  contrast: number;
}

/** CALIBRATION. Mid-grey target and the contrast floor below which we penalise. */
export const TARGET_MEAN = 118;
export const MIN_HEALTHY_CONTRAST = 40;

function percentile(hist: Uint32Array, total: number, p: number): number {
  const want = total * p;
  let seen = 0;
  for (let v = 0; v < 256; v++) {
    seen += hist[v]!;
    if (seen >= want) return v;
  }
  return 255;
}

export function exposureDetail(gray: GrayImage): ExposureDetail {
  const hist = new Uint32Array(256);
  let sum = 0;
  for (let i = 0; i < gray.data.length; i++) {
    const v = Math.max(0, Math.min(255, Math.round(gray.data[i]!)));
    hist[v]!++;
    sum += v;
  }
  const total = gray.data.length;
  const mean = sum / total;

  let clipLow = 0;
  for (let v = 0; v <= 2; v++) clipLow += hist[v]!;
  clipLow /= total;

  let clipHigh = 0;
  for (let v = 253; v <= 255; v++) clipHigh += hist[v]!;
  clipHigh /= total;

  const contrast = percentile(hist, total, 0.95) - percentile(hist, total, 0.05);

  // Penalty caps are deliberately wide enough that a badly exposed frame can
  // actually reach the low scores. An earlier, tighter set bottomed out at 40
  // for a completely blown-out image, which made a threshold of 40 a no-op.
  //
  // Highlights are punished harder than shadows on purpose: clipped highlights
  // are unrecoverable, whereas a dark frame can usually be lifted.
  let score = 100;
  score -= Math.min(45, clipHigh * 450);
  score -= Math.min(35, clipLow * 350);
  score -= Math.min(35, (Math.abs(mean - TARGET_MEAN) / TARGET_MEAN) * 70);
  if (contrast < MIN_HEALTHY_CONTRAST) {
    score -= ((MIN_HEALTHY_CONTRAST - contrast) / MIN_HEALTHY_CONTRAST) * 30;
  }

  return { score: Math.max(0, Math.min(100, score)), clipLow, clipHigh, mean, contrast };
}

export function scoreExposure(gray: GrayImage): number {
  return exposureDetail(gray).score;
}
