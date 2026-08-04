import { describe, it, expect } from 'vitest';
import { faceCropStyle, CROP_PADDING } from '../../src/renderer/review/faceCrop.ts';

const px = (v: string | number | undefined) => parseFloat(String(v));

describe('faceCropStyle', () => {
  it('zooms in on a small face', () => {
    const s = faceCropStyle({ x: 0.45, y: 0.45, width: 0.1, height: 0.1 }, 200, 'u');
    // Background is scaled well beyond the container, i.e. genuinely zoomed.
    expect(px(s.backgroundSize as string)).toBeGreaterThan(200);
  });

  it('zooms less for a larger face', () => {
    const small = faceCropStyle({ x: 0.45, y: 0.45, width: 0.05, height: 0.05 }, 200, 'u');
    const large = faceCropStyle({ x: 0.3, y: 0.3, width: 0.4, height: 0.4 }, 200, 'u');
    expect(px(small.backgroundSize as string)).toBeGreaterThan(px(large.backgroundSize as string));
  });

  it('never offsets past the image edge, which would show blank space', () => {
    for (const box of [
      { x: 0, y: 0, width: 0.1, height: 0.1 },
      { x: 0.9, y: 0.9, width: 0.1, height: 0.1 },
    ]) {
      const s = faceCropStyle(box, 200, 'u');
      const [left, top] = String(s.backgroundPosition).split(' ').map(px);
      const size = px(s.backgroundSize as string);
      expect(left!).toBeLessThanOrEqual(0);
      expect(top!).toBeLessThanOrEqual(0);
      expect(left!).toBeGreaterThanOrEqual(-(size - 200) - 0.001);
      expect(top!).toBeGreaterThanOrEqual(-(size - 200) - 0.001);
    }
  });

  it('survives a degenerate zero-size box without dividing by zero', () => {
    const s = faceCropStyle({ x: 0.5, y: 0.5, width: 0, height: 0 }, 200, 'u');
    expect(Number.isFinite(px(s.backgroundSize as string))).toBe(true);
  });

  it('never scales below the container, so the crop is always filled', () => {
    const s = faceCropStyle({ x: 0, y: 0, width: 1, height: 1 }, 200, 'u');
    expect(px(s.backgroundSize as string)).toBeGreaterThanOrEqual(200);
  });

  it('includes padding around the face rather than cropping it tight', () => {
    expect(CROP_PADDING).toBeGreaterThan(1);
  });
});
