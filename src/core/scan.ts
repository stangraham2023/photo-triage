import { readdir, stat } from 'node:fs/promises';
import { join, relative, extname } from 'node:path';
import type { ScannedFile } from './types.ts';
import { looksNotDownloaded, confirmNotDownloaded } from './cloudFiles.ts';

export const SUPPORTED_EXTENSIONS: ReadonlySet<string> = new Set([
  'jpg', 'jpeg', 'jpe', 'jfif', 'png', 'tif', 'tiff', 'webp', 'avif',
  'heic', 'heif',
  // RAW — analysed via their embedded JPEG preview.
  'cr2', 'cr3', 'nef', 'nrw', 'arw', 'srf', 'sr2', 'dng', 'raf', 'orf', 'rw2', 'pef', 'srw',
]);

export interface ScanResult {
  images: ScannedFile[];
  skipped: number;
  /** How many of `images` are cloud placeholders rather than real files. */
  notDownloaded: number;
}

export async function scanDirectory(
  root: string,
  opts: { recurse?: boolean } = {},
): Promise<ScanResult> {
  const recurse = opts.recurse ?? true;
  const images: ScannedFile[] = [];
  const suspects: ScannedFile[] = [];
  let skipped = 0;

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        // Never descend into our own output folder if the user nests them.
        if (recurse && entry.name !== '_photo-triage') await walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      if (entry.name.startsWith('.')) continue;

      const ext = extname(entry.name).slice(1).toLowerCase();
      if (!SUPPORTED_EXTENSIONS.has(ext)) {
        skipped++;
        continue;
      }
      const s = await stat(abs);
      const file: ScannedFile = {
        absPath: abs,
        relPath: relative(root, abs),
        ext,
        bytes: s.size,
        mtimeMs: s.mtimeMs,
        onDisk: true,
      };
      if (looksNotDownloaded({ size: s.size, blocks: s.blocks })) suspects.push(file);
      images.push(file);
    }
  }

  await walk(root);

  // Confirm the cheap prefilter's suspicions in one batch. A compressed file
  // also reports zero blocks, so without this step ordinary photos would be
  // written off as absent.
  if (suspects.length > 0) {
    const confirmed = await confirmNotDownloaded(suspects.map((f) => f.absPath));
    for (const f of suspects) {
      if (confirmed.has(f.absPath)) f.onDisk = false;
    }
  }

  return { images, skipped, notDownloaded: images.filter((f) => !f.onDisk).length };
}
