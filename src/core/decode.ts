import sharp from 'sharp';
import { readFile } from 'node:fs/promises';
import type { WorkingImage, GrayImage } from './types.ts';

/** Long-edge size of the cached working image. */
export const WORKING_LONG_EDGE = 1600;

export const RAW_EXTENSIONS: ReadonlySet<string> = new Set([
  'cr2', 'cr3', 'nef', 'nrw', 'arw', 'srf', 'sr2', 'dng', 'raf', 'orf', 'rw2', 'pef', 'srw',
]);

const HEIF_EXTENSIONS: ReadonlySet<string> = new Set(['heic', 'heif']);

export class UnreadableError extends Error {
  // Declared and assigned explicitly rather than as a constructor parameter
  // property: Node's --experimental-strip-types cannot compile those, and the
  // CLI runs directly off the TypeScript sources.
  readonly path: string;

  constructor(path: string, cause: string) {
    super(`Cannot decode ${path}: ${cause}`);
    this.name = 'UnreadableError';
    this.path = path;
  }
}

/** Supplied by the metadata reader. Returns a JPEG buffer, or null when the file has no usable preview. */
export type RawPreviewLoader = (absPath: string) => Promise<Buffer | null>;

async function decodeHeif(absPath: string): Promise<WorkingImage> {
  // sharp's prebuilt libvips has libheif but no libde265, so HEVC-coded HEIC
  // (every iPhone photo) fails with a misleading "bad seek" error. WASM libheif
  // is the only cross-platform decoder that handles it.
  // libheif-js is CommonJS. Node's ESM interop does not always surface its
  // named exports, so the constructor can arrive either at the top level or
  // under `default` depending on the loader — Vitest and plain Node disagree.
  // Reading both is the only thing that works in each.
  const mod = await import('libheif-js/wasm-bundle.js');
  const Decoder = mod.HeifDecoder ?? mod.default?.HeifDecoder;
  if (typeof Decoder !== 'function') {
    throw new UnreadableError(absPath, 'libheif-js did not expose a HeifDecoder constructor');
  }

  const buf = await readFile(absPath);

  let images: import('libheif-js/wasm-bundle.js').HeifImage[];
  try {
    images = new Decoder().decode(buf);
  } catch (err) {
    throw new UnreadableError(absPath, err instanceof Error ? err.message : String(err));
  }
  const first = images[0];
  if (!first) throw new UnreadableError(absPath, 'no image in HEIF container');

  const width = first.get_width();
  const height = first.get_height();
  const data = new Uint8ClampedArray(width * height * 4);
  await new Promise<void>((resolve, reject) => {
    first.display({ width, height, data }, (result: unknown) =>
      result ? resolve() : reject(new UnreadableError(absPath, 'HEIF display failed')),
    );
  });
  return { width, height, data };
}

async function sharpToWorking(
  input: string | Buffer,
  longEdge: number,
  label: string,
): Promise<WorkingImage> {
  try {
    const { data, info } = await sharp(input)
      .rotate() // applies EXIF orientation
      .resize({ width: longEdge, height: longEdge, fit: 'inside', withoutEnlargement: true })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return {
      width: info.width,
      height: info.height,
      data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength),
    };
  } catch (err) {
    throw new UnreadableError(label, err instanceof Error ? err.message : String(err));
  }
}

export async function decodeToWorking(
  absPath: string,
  ext: string,
  opts: { longEdge?: number } = {},
  rawPreviewLoader?: RawPreviewLoader,
): Promise<WorkingImage> {
  const longEdge = opts.longEdge ?? WORKING_LONG_EDGE;

  if (HEIF_EXTENSIONS.has(ext)) {
    const full = await decodeHeif(absPath);
    if (Math.max(full.width, full.height) <= longEdge) return full;
    // Round-trip through sharp only to downscale; the decode itself is already done.
    return sharpToWorking(
      await sharp(Buffer.from(full.data), {
        raw: { width: full.width, height: full.height, channels: 4 },
      }).png().toBuffer(),
      longEdge,
      absPath,
    );
  }

  if (RAW_EXTENSIONS.has(ext)) {
    if (!rawPreviewLoader) throw new UnreadableError(absPath, 'no RAW preview loader supplied');
    const preview = await rawPreviewLoader(absPath);
    if (!preview) throw new UnreadableError(absPath, 'RAW file has no embedded preview');
    return sharpToWorking(preview, longEdge, absPath);
  }

  return sharpToWorking(absPath, longEdge, absPath);
}

/** Rec.709 luminance. */
export function toGray(img: WorkingImage): GrayImage {
  const out = new Float32Array(img.width * img.height);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] = 0.2126 * img.data[p]! + 0.7152 * img.data[p + 1]! + 0.0722 * img.data[p + 2]!;
  }
  return { width: img.width, height: img.height, data: out };
}
