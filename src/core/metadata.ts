import { ExifTool } from 'exiftool-vendored';
import sharp from 'sharp';
import type { PhotoMetadata } from './types.ts';

/** Previews smaller than this are still used, but flagged as reduced confidence. */
export const MIN_PREVIEW_LONG_EDGE = 1024;

/** Binary tags to try, largest wins. Cameras disagree on which they populate. */
const PREVIEW_TAGS = ['JpgFromRaw', 'PreviewImage', 'OtherImage', 'ThumbnailImage'] as const;

function toMillis(value: unknown): number | null {
  if (value == null) return null;
  // exiftool-vendored returns ExifDateTime objects with a toDate method.
  if (typeof value === 'object' && 'toDate' in value) {
    const d = (value as { toDate(): Date }).toDate();
    return Number.isNaN(d.getTime()) ? null : d.getTime();
  }
  const d = new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

export class MetadataReader {
  private readonly exif = new ExifTool({ taskTimeoutMillis: 20_000 });

  async read(absPath: string): Promise<PhotoMetadata> {
    try {
      const t = await this.exif.read(absPath);
      const capture =
        toMillis(t.SubSecDateTimeOriginal) ??
        toMillis(t.DateTimeOriginal) ??
        toMillis(t.CreateDate) ??
        null;
      const orientation =
        typeof t.Orientation === 'number' && t.Orientation >= 1 && t.Orientation <= 8
          ? t.Orientation
          : 1;
      return {
        captureTimeMs: capture,
        orientation,
        cameraModel: typeof t.Model === 'string' ? t.Model : null,
      };
    } catch {
      // A file we cannot read metadata from may still decode. Never fail the run here.
      return { captureTimeMs: null, orientation: 1, cameraModel: null };
    }
  }

  /** Largest embedded JPEG preview, or null when none is usable. */
  async extractRawPreview(absPath: string): Promise<Buffer | null> {
    let best: Buffer | null = null;
    let bestEdge = 0;
    for (const tag of PREVIEW_TAGS) {
      let buf: Buffer;
      try {
        buf = await this.exif.extractBinaryTagToBuffer(tag as never, absPath);
      } catch {
        continue;
      }
      if (!buf?.length) continue;
      try {
        const meta = await sharp(buf).metadata();
        const edge = Math.max(meta.width ?? 0, meta.height ?? 0);
        if (edge > bestEdge) {
          best = buf;
          bestEdge = edge;
        }
      } catch {
        continue;
      }
    }
    return best;
  }

  close(): Promise<void> {
    return this.exif.end();
  }
}
