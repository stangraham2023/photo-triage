import sharp from 'sharp';
import { join, dirname } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { WorkingImage, PhotoId } from '../core/types.ts';

/**
 * Flat, collision-free filename for a photo's thumbnail.
 *
 * Photo ids are relative paths and may contain separators or '..' segments, so
 * mirroring them into the cache would recreate the source tree and invite path
 * escapes.
 */
export function thumbId(id: PhotoId): string {
  return createHash('sha256').update(id).digest('hex').slice(0, 32);
}

/**
 * Built here, in the main process, and sent to the renderer in the analysis
 * payload. Hashing on both sides would need node:crypto in the renderer — which
 * does not exist — and would risk the two implementations drifting apart.
 */
export function thumbUrl(runId: string, id: PhotoId): string {
  return `triage-thumb://${runId}/${thumbId(id)}.jpg`;
}

export const THUMB_LONG_EDGE = 400;

export async function writeThumbnail(img: WorkingImage, dest: string): Promise<void> {
  const buf = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength);
  const out = await sharp(buf, { raw: { width: img.width, height: img.height, channels: 4 } })
    .resize({
      width: THUMB_LONG_EDGE,
      height: THUMB_LONG_EDGE,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality: 78 })
    .toBuffer();
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, out);
}

export function thumbPathFor(runDir: string, id: PhotoId): string {
  return join(runDir, `${thumbId(id)}.jpg`);
}
