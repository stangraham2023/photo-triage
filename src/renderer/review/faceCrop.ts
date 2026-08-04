import type { CSSProperties } from 'react';
import type { FaceBox } from '../../core/types.ts';

/** Show this much context around the face, as a multiple of its size. */
export const CROP_PADDING = 1.6;

/**
 * CSS that renders a zoomed crop of one face from the full thumbnail.
 *
 * Works by scaling the background up so the padded face box fills the container,
 * then offsetting it so that box lands in view. Clamping keeps a face near the
 * edge of the frame from being offset past the image and showing blank space.
 */
export function faceCropStyle(
  box: FaceBox,
  containerPx: number,
  imageUrl: string,
): CSSProperties {
  // A degenerate box would divide by zero; fall back to showing the whole frame.
  const w = Math.max(box.width, 0.001) * CROP_PADDING;
  const h = Math.max(box.height, 0.001) * CROP_PADDING;
  const span = Math.min(1, Math.max(w, h));

  const scale = 1 / span;
  const bgSize = containerPx * scale;

  // Centre of the face, in image fractions.
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  // Offset so the centre sits in the middle, clamped to the image bounds.
  const clamp = (v: number) => Math.min(0, Math.max(-(bgSize - containerPx), v));
  const left = clamp(containerPx / 2 - cx * bgSize);
  const top = clamp(containerPx / 2 - cy * bgSize);

  return {
    width: `${containerPx}px`,
    height: `${containerPx}px`,
    backgroundImage: `url("${imageUrl}")`,
    backgroundSize: `${bgSize}px ${bgSize}px`,
    backgroundPosition: `${left}px ${top}px`,
    backgroundRepeat: 'no-repeat',
  };
}
