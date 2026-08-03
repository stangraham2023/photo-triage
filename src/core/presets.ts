import type { PresetName, Thresholds } from './types.ts';

/**
 * CALIBRATION. Starting points, not gospel. The review UI exposes these as live
 * sliders precisely because the right values differ between photo libraries.
 */
export const PRESETS: Record<PresetName, Thresholds> = {
  event: {
    enableBlur: true, enableEyes: true, enableExposure: true, enableDuplicates: true,
    blur: 35, faceBlur: 30, eyes: 0.35, exposure: 40,
    burstHammingMax: 10, burstWindowMs: 10_000,
  },
  portrait: {
    enableBlur: true, enableEyes: true, enableExposure: true, enableDuplicates: true,
    // Lenient on the frame, strict on the face — shallow depth of field is the point.
    blur: 20, faceBlur: 50, eyes: 0.5, exposure: 40,
    burstHammingMax: 12, burstWindowMs: 15_000,
  },
  landscape: {
    enableBlur: true, enableEyes: false, enableExposure: true, enableDuplicates: true,
    blur: 50, faceBlur: 0, eyes: 0, exposure: 50,
    burstHammingMax: 8, burstWindowMs: 30_000,
  },
};
