# Photo Triage Core Engine — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the pure TypeScript analysis engine and a working command-line tool that scans a photo folder, scores every image for blur, exposure and burst duplication, and copies the results into staging and review folders with a manifest, reports, and undo.

**Architecture:** Everything lives in `core/` as plain TypeScript with no Electron imports. Scoring and verdict are separate stages — scoring is expensive and runs once, verdict is pure arithmetic over cached scores so thresholds can be re-applied instantly. Face and eye detection are defined here as an injected `FaceDetector` interface with a null implementation; the real MediaPipe implementation arrives in Phase 2 when there is an Electron renderer to host it. A CLI wires the stages together and is the deliverable that proves the engine works.

**Tech Stack:** TypeScript 5, Node 22, Vitest 4, `sharp` 0.35.3, `libheif-js`, `exiftool-vendored` 37.1.0. No runtime dependency on Electron.

**Source spec:** `docs/superpowers/specs/2026-08-03-photo-triage-design.md`

## Global Constraints

- Node 22, ES modules (`"type": "module"`), TypeScript strict mode on.
- `core/` must never import from `electron`, `main/`, `renderer/`, or `worker/`. This is enforced by a test in Task 14.
- **The source folder is read-only.** No code in this plan may write, move, rename, or delete anything inside the user's source directory. Files are copied only.
- **Score direction: higher is always better.** A high blur score means sharp. A check fails when its score falls *below* its threshold. This holds in code, in reason text, and in the CSV.
- Blur, face-blur and exposure scores are on a 0–100 scale. Eye scores are 0–1.
- HEIC/HEIF must be decoded with `libheif-js`, never with `sharp` — `sharp`'s prebuilt binary lacks the HEVC decoder and fails with a misleading `bad seek` error.
- Every scoring function is pure: pixels and config in, numbers out. No file I/O, no logging, no clock access.
- Calibration constants are named exports with a comment marking them as calibration. Tests assert *ordering and direction*, never absolute score values, so recalibration never breaks the suite.
- Commit after every task.

---

### Task 1: Project scaffold and test harness

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore` (modify), `src/core/.gitkeep`
- Create: `tests/fixtures/generate.ts`, `tests/fixtures/globalSetup.ts`
- Create: `tests/smoke.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `generateFixtures(outDir: string): Promise<void>` in `tests/fixtures/generate.ts`, which writes deterministic test images to `outDir`. Fixture filenames later tasks rely on: `sharp.png`, `blurry.png`, `overexposed.png`, `underexposed.png`, `lowcontrast.png`, `burst-1.png`, `burst-2.png`, `burst-3.png`, `different.png`, `corrupt.jpg`.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "photo-triage",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "triage": "node --experimental-strip-types src/cli/index.ts"
  },
  "dependencies": {
    "sharp": "0.35.3",
    "libheif-js": "^1.18.0",
    "exiftool-vendored": "37.1.0"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "vitest": "^4.1.10",
    "@types/node": "^22.0.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "tests/**/*.ts"]
}
```

`noUncheckedIndexedAccess` is deliberate. This codebase indexes into pixel arrays constantly, and it catches real off-by-one mistakes.

- [ ] **Step 3: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./tests/fixtures/globalSetup.ts'],
    testTimeout: 30_000,
  },
});
```

- [ ] **Step 4: Append to `.gitignore`**

```
tests/fixtures/generated/
```

- [ ] **Step 5: Create `tests/fixtures/generate.ts`**

Fixtures are generated rather than committed as binaries: deterministic, reviewable as code, and no binary churn in git history.

```ts
import sharp from 'sharp';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const W = 512;
const H = 384;

/** Deterministic pseudo-random, so fixtures are byte-identical on every machine. */
function seededNoise(seed: number, w: number, h: number, offsetX = 0): Buffer {
  const buf = Buffer.alloc(w * h * 3);
  let s = seed;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      s = (s * 1664525 + 1013904223) >>> 0;
      // High-frequency checkerboard plus noise gives strong Laplacian response.
      const check = ((x + offsetX) >> 3) % 2 === (y >> 3) % 2 ? 200 : 40;
      const n = (s >>> 24) % 56;
      const i = (y * w + x) * 3;
      buf[i] = Math.min(255, check + n);
      buf[i + 1] = Math.min(255, check + ((n * 3) % 56));
      buf[i + 2] = Math.min(255, check + ((n * 7) % 56));
    }
  }
  return buf;
}

function raw(buf: Buffer, w = W, h = H) {
  return sharp(buf, { raw: { width: w, height: h, channels: 3 } });
}

export async function generateFixtures(outDir: string): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const base = seededNoise(42, W, H);

  await raw(base).png().toFile(join(outDir, 'sharp.png'));
  await raw(base).blur(6).png().toFile(join(outDir, 'blurry.png'));
  await raw(base).linear(1.9, 60).png().toFile(join(outDir, 'overexposed.png'));
  await raw(base).linear(0.28, -12).png().toFile(join(outDir, 'underexposed.png'));
  await raw(base).linear(0.16, 110).png().toFile(join(outDir, 'lowcontrast.png'));

  // Burst: three near-identical frames, each shifted a few pixels.
  for (let i = 1; i <= 3; i++) {
    await raw(seededNoise(42, W, H, i * 2)).png().toFile(join(outDir, `burst-${i}.png`));
  }
  // A visually unrelated frame that must NOT group with the burst.
  await raw(seededNoise(9999, W, H)).png().toFile(join(outDir, 'different.png'));

  // Truncated JPEG header — decodes to nothing, exercises the unreadable path.
  await writeFile(join(outDir, 'corrupt.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a]));
}
```

- [ ] **Step 6: Create `tests/fixtures/globalSetup.ts`**

```ts
import { generateFixtures } from './generate.ts';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'generated');

export default async function setup() {
  await generateFixtures(FIXTURE_DIR);
}
```

- [ ] **Step 7: Create `tests/smoke.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { stat } from 'node:fs/promises';
import { FIXTURE_DIR } from './fixtures/globalSetup.ts';
import { join } from 'node:path';

describe('fixture generation', () => {
  it('produces a sharp and a blurry fixture of the same dimensions', async () => {
    const a = await stat(join(FIXTURE_DIR, 'sharp.png'));
    const b = await stat(join(FIXTURE_DIR, 'blurry.png'));
    expect(a.size).toBeGreaterThan(0);
    expect(b.size).toBeGreaterThan(0);
    // A blurred image compresses far smaller than a noisy sharp one.
    expect(b.size).toBeLessThan(a.size);
  });
});
```

- [ ] **Step 8: Install and run**

```bash
npm install
npm test
```

Expected: 1 test passes. If `sharp` fails to install, stop — that is a blocking environment problem, not a code problem.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "chore: scaffold TypeScript project with generated test fixtures"
```

---

### Task 2: Shared types

**Files:**
- Create: `src/core/types.ts`
- Test: none — this file contains only type declarations and is validated by `npm run typecheck`.

**Interfaces:**
- Consumes: nothing.
- Produces: every type below. Later tasks import from `src/core/types.ts` exclusively; no task redefines these.

- [ ] **Step 1: Create `src/core/types.ts`**

```ts
/** Relative path from the source root, used as a stable identifier. */
export type PhotoId = string;

export interface ScannedFile {
  absPath: string;
  relPath: PhotoId;
  ext: string;          // lowercase, no dot
  bytes: number;
  mtimeMs: number;
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
}

export type ReasonCode = 'blur' | 'eyes-closed' | 'exposure' | 'duplicate';

export interface Reason {
  code: ReasonCode;
  /** Human-readable, shown verbatim in the UI chip and the CSV. */
  detail: string;
  score: number;
  threshold: number;
}

export type Verdict = 'good' | 'rejected' | 'unreadable';

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
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: add shared core types"
```

---

### Task 3: Directory scanner

**Files:**
- Create: `src/core/scan.ts`
- Test: `tests/core/scan.test.ts`

**Interfaces:**
- Consumes: `ScannedFile` from `src/core/types.ts`.
- Produces: `scanDirectory(root: string, opts?: { recurse?: boolean }): Promise<ScanResult>` where `ScanResult` is `{ images: ScannedFile[]; skipped: number }`. Also exports `SUPPORTED_EXTENSIONS: ReadonlySet<string>`.

- [ ] **Step 1: Write the failing test**

Create `tests/core/scan.test.ts`:

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanDirectory } from '../../src/core/scan.ts';

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'scan-'));
  await writeFile(join(root, 'a.jpg'), 'x');
  await writeFile(join(root, 'b.HEIC'), 'x');
  await writeFile(join(root, 'notes.txt'), 'x');
  await mkdir(join(root, 'sub'), { recursive: true });
  await writeFile(join(root, 'sub', 'c.cr2'), 'x');
});

describe('scanDirectory', () => {
  it('finds images recursively and reports relative paths', async () => {
    const r = await scanDirectory(root);
    expect(r.images.map((f) => f.relPath).sort()).toEqual(['a.jpg', 'b.HEIC', join('sub', 'c.cr2')].sort());
  });

  it('counts non-image files as skipped rather than failing', async () => {
    const r = await scanDirectory(root);
    expect(r.skipped).toBe(1);
  });

  it('lowercases the extension', async () => {
    const r = await scanDirectory(root);
    expect(r.images.find((f) => f.relPath === 'b.HEIC')?.ext).toBe('heic');
  });

  it('stays in the top folder when recurse is false', async () => {
    const r = await scanDirectory(root, { recurse: false });
    expect(r.images.map((f) => f.relPath).sort()).toEqual(['a.jpg', 'b.HEIC']);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run tests/core/scan.test.ts
```

Expected: FAIL — cannot resolve `../../src/core/scan.ts`.

- [ ] **Step 3: Implement `src/core/scan.ts`**

```ts
import { readdir, stat } from 'node:fs/promises';
import { join, relative, extname } from 'node:path';
import type { ScannedFile } from './types.ts';

export const SUPPORTED_EXTENSIONS: ReadonlySet<string> = new Set([
  'jpg', 'jpeg', 'jpe', 'jfif', 'png', 'tif', 'tiff', 'webp', 'avif',
  'heic', 'heif',
  // RAW — analysed via their embedded JPEG preview.
  'cr2', 'cr3', 'nef', 'nrw', 'arw', 'srf', 'sr2', 'dng', 'raf', 'orf', 'rw2', 'pef', 'srw',
]);

export interface ScanResult {
  images: ScannedFile[];
  skipped: number;
}

export async function scanDirectory(
  root: string,
  opts: { recurse?: boolean } = {},
): Promise<ScanResult> {
  const recurse = opts.recurse ?? true;
  const images: ScannedFile[] = [];
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
      images.push({
        absPath: abs,
        relPath: relative(root, abs),
        ext,
        bytes: s.size,
        mtimeMs: s.mtimeMs,
      });
    }
  }

  await walk(root);
  return { images, skipped };
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/core/scan.test.ts
```

Expected: 4 passing.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: add recursive directory scanner"
```

---

### Task 4: Image decoding across all formats

**Files:**
- Create: `src/core/decode.ts`
- Create: `tests/fixtures/hevc-sample.heic.base64`
- Test: `tests/core/decode.test.ts`

**Interfaces:**
- Consumes: `WorkingImage`, `GrayImage` from types.
- Produces:
  - `decodeToWorking(absPath: string, ext: string, opts?: { longEdge?: number }): Promise<WorkingImage>` — throws `UnreadableError` on failure.
  - `class UnreadableError extends Error { constructor(path: string, cause: string) }`
  - `toGray(img: WorkingImage): GrayImage`
  - `WORKING_LONG_EDGE: number` (1600)
  - `RAW_EXTENSIONS: ReadonlySet<string>`

This task depends on `extractRawPreview` from Task 5. To keep tasks independently testable, Task 4 accepts it by injection: `decodeToWorking` takes an optional third parameter `rawPreviewLoader`. Task 5 supplies the real one; tests supply a stub.

- [ ] **Step 1: Write the HEIC fixture file**

A real HEVC-coded HEIC, 400×300, solid RGB(120,80,200). It is base64 in the repo because no cross-platform library can *encode* HEVC, so it cannot be generated at test time on Windows or CI.

Create `tests/fixtures/hevc-sample.heic.base64` containing exactly:

```
AAAAJGZ0eXBoZWljAAAAAG1pZjFNaVBybWlhZk1pSEJoZWljAAABhW1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAHBpY3QAAAAAAAAAAAAAAAAAAAAAJGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADHVybCAAAAABAAAADnBpdG0AAAAAAAEAAAAjaWluZgAAAAAAAQAAABVpbmZlAgAAAAABAABodmMxAAAAAOVpcHJwAAAAxGlwY28AAAATY29scm5jbHgAAgACAAaAAAAADGNsbGkAywBAAAAAFGlzcGUAAAAAAAABkAAAASwAAAAJaXJvdAAAAAAQcGl4aQAAAAADCAgIAAAAcGh2Y0MBA3AAAACwAAAAAAA88AD8/fj4AAALA6AAAQAXQAEMAf//A3AAAAMAsAAAAwAAAwA8cCShAAEAIkIBAQNwAAADALAAAAMAAAMAPKAMiATH3iHuRZVNwICBgCCiAAEACUQBwGFyyERTZAAAABlpcG1hAAAAAAAAAAEAAQaBAgMFhoQAAAAeaWxvYwAAAABEAAABAAEAAAABAAABuQAAAJEAAAABbWRhdAAAAAAAAAChAAAAjSgBr4ounMWpKkogRoF8//qpXr/hI+y2ik+xb9npR7JMa8BoWHD/Pm3F/OOKi/K/NN4IAFdAIrFiI+1inf2oAAAioAqvXqLYRQAAAwACzgLh8IoAAAMAAAb0A9LAAAADAAAEtAAAAwAAAwAAAwK6AAADAAADAAB9QAAAAwAAAwAPCAAAAwAAAwAAAwAVkA==
```

- [ ] **Step 2: Write the failing test**

Create `tests/core/decode.test.ts`:

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeToWorking, toGray, UnreadableError } from '../../src/core/decode.ts';
import { FIXTURE_DIR } from '../fixtures/globalSetup.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
let heicPath: string;

beforeAll(async () => {
  const b64 = await readFile(join(HERE, '..', 'fixtures', 'hevc-sample.heic.base64'), 'utf8');
  const dir = await mkdtemp(join(tmpdir(), 'decode-'));
  heicPath = join(dir, 'sample.heic');
  await writeFile(heicPath, Buffer.from(b64.trim(), 'base64'));
});

describe('decodeToWorking', () => {
  it('decodes PNG to RGBA', async () => {
    const img = await decodeToWorking(join(FIXTURE_DIR, 'sharp.png'), 'png');
    expect(img.data.length).toBe(img.width * img.height * 4);
    expect(img.width).toBeGreaterThan(0);
  });

  it('downscales to the requested long edge', async () => {
    const img = await decodeToWorking(join(FIXTURE_DIR, 'sharp.png'), 'png', { longEdge: 128 });
    expect(Math.max(img.width, img.height)).toBe(128);
  });

  it('decodes HEVC-coded HEIC, which sharp cannot do', async () => {
    const img = await decodeToWorking(heicPath, 'heic');
    expect(img.width).toBe(400);
    expect(img.height).toBe(300);
    // Solid RGB(120,80,200); allow slop for YUV round-tripping.
    expect(img.data[0]).toBeGreaterThan(110);
    expect(img.data[0]).toBeLessThan(130);
    expect(img.data[2]).toBeGreaterThan(190);
  });

  it('throws UnreadableError on a corrupt file', async () => {
    await expect(decodeToWorking(join(FIXTURE_DIR, 'corrupt.jpg'), 'jpg'))
      .rejects.toBeInstanceOf(UnreadableError);
  });
});

describe('toGray', () => {
  it('converts a known colour to Rec.709 luminance', () => {
    const img = { width: 1, height: 1, data: new Uint8ClampedArray([255, 255, 255, 255]) };
    expect(toGray(img).data[0]).toBeCloseTo(255, 0);
  });

  it('gives green more weight than blue', () => {
    const green = toGray({ width: 1, height: 1, data: new Uint8ClampedArray([0, 255, 0, 255]) });
    const blue = toGray({ width: 1, height: 1, data: new Uint8ClampedArray([0, 0, 255, 255]) });
    expect(green.data[0]!).toBeGreaterThan(blue.data[0]!);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

```bash
npx vitest run tests/core/decode.test.ts
```

Expected: FAIL — cannot resolve `src/core/decode.ts`.

- [ ] **Step 4: Implement `src/core/decode.ts`**

```ts
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
  constructor(public readonly path: string, cause: string) {
    super(`Cannot decode ${path}: ${cause}`);
    this.name = 'UnreadableError';
  }
}

/** Supplied by Task 5. Returns a JPEG buffer, or null when the file has no usable preview. */
export type RawPreviewLoader = (absPath: string) => Promise<Buffer | null>;

async function decodeHeif(absPath: string): Promise<WorkingImage> {
  // sharp's prebuilt libvips has libheif but no libde265, so HEVC-coded HEIC
  // (every iPhone photo) fails with a misleading "bad seek" error. WASM libheif
  // is the only cross-platform decoder that handles it.
  const { HeifDecoder } = await import('libheif-js/wasm-bundle');
  const buf = await readFile(absPath);
  const images = new HeifDecoder().decode(buf);
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

function resizeWorking(img: WorkingImage, longEdge: number): Promise<WorkingImage> {
  if (Math.max(img.width, img.height) <= longEdge) return Promise.resolve(img);
  return sharpToWorking(
    Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength),
    longEdge,
    'resize',
  );
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
    const jpeg = await sharp(Buffer.from(full.data), {
      raw: { width: full.width, height: full.height, channels: 4 },
    }).png().toBuffer();
    return sharpToWorking(jpeg, longEdge, absPath);
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
```

Note: `resizeWorking` is exported for later use but currently unused by `decodeToWorking`; delete it if Task 14 finds no consumer.

- [ ] **Step 5: Run tests**

```bash
npx vitest run tests/core/decode.test.ts
```

Expected: 6 passing. The HEIC test is the one that matters — it proves the `libheif-js` path works.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: add multi-format decoder with WASM HEIC support"
```

---

### Task 5: Metadata and RAW preview extraction

**Files:**
- Create: `src/core/metadata.ts`
- Test: `tests/core/metadata.test.ts`

**Interfaces:**
- Consumes: `PhotoMetadata` from types; `RawPreviewLoader` type from `decode.ts`.
- Produces:
  - `class MetadataReader` with `read(absPath: string): Promise<PhotoMetadata>`, `extractRawPreview(absPath: string): Promise<Buffer | null>`, and `close(): Promise<void>`.
  - `MIN_PREVIEW_LONG_EDGE = 1024`

`MetadataReader` wraps one long-lived `exiftool` process. It must be closed or the Node process will not exit — the CLI in Task 13 is responsible for that.

- [ ] **Step 1: Write the failing test**

Create `tests/core/metadata.test.ts`:

```ts
import { describe, it, expect, afterAll } from 'vitest';
import { join } from 'node:path';
import { MetadataReader } from '../../src/core/metadata.ts';
import { FIXTURE_DIR } from '../fixtures/globalSetup.ts';

const reader = new MetadataReader();
afterAll(() => reader.close());

describe('MetadataReader', () => {
  it('reads a PNG without throwing and defaults orientation to 1', async () => {
    const m = await reader.read(join(FIXTURE_DIR, 'sharp.png'));
    expect(m.orientation).toBe(1);
  });

  it('returns null capture time when there is no EXIF date', async () => {
    const m = await reader.read(join(FIXTURE_DIR, 'sharp.png'));
    expect(m.captureTimeMs).toBeNull();
  });

  it('returns metadata rather than throwing for a corrupt file', async () => {
    const m = await reader.read(join(FIXTURE_DIR, 'corrupt.jpg'));
    expect(m.orientation).toBe(1);
    expect(m.cameraModel).toBeNull();
  });

  it('returns null preview for a file with no embedded preview', async () => {
    expect(await reader.extractRawPreview(join(FIXTURE_DIR, 'sharp.png'))).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run tests/core/metadata.test.ts
```

Expected: FAIL — cannot resolve `src/core/metadata.ts`.

- [ ] **Step 3: Implement `src/core/metadata.ts`**

```ts
import { ExifTool } from 'exiftool-vendored';
import sharp from 'sharp';
import type { PhotoMetadata } from './types.ts';

/** Previews smaller than this are still used, but flagged as reduced confidence. */
export const MIN_PREVIEW_LONG_EDGE = 1024;

/** Binary tags to try, largest-first. Cameras disagree on which they populate. */
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
        buf = await this.exif.extractBinaryTagToBuffer(tag, absPath);
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
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/core/metadata.test.ts
```

Expected: 4 passing. If `extractBinaryTagToBuffer` does not exist on this version of `exiftool-vendored`, check the installed typings and use `extractBinaryTag` writing to a temp file instead — the surrounding logic is unchanged.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: add metadata reader and RAW preview extraction"
```

---

### Task 6: Blur scoring

**Files:**
- Create: `src/core/scores/blur.ts`
- Test: `tests/core/scores/blur.test.ts`

**Interfaces:**
- Consumes: `GrayImage`, `FaceBox` from types; `toGray`, `decodeToWorking` from `decode.ts`.
- Produces:
  - `scoreBlur(gray: GrayImage): { global: number; sharpestRegion: number }`
  - `scoreFaceBlur(gray: GrayImage, boxes: FaceBox[]): number | null`
  - `BLUR_K: number` (calibration constant)

- [ ] **Step 1: Write the failing test**

Create `tests/core/scores/blur.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { decodeToWorking, toGray } from '../../../src/core/decode.ts';
import { scoreBlur, scoreFaceBlur } from '../../../src/core/scores/blur.ts';
import { FIXTURE_DIR } from '../../fixtures/globalSetup.ts';

async function gray(name: string) {
  return toGray(await decodeToWorking(join(FIXTURE_DIR, name), 'png'));
}

describe('scoreBlur', () => {
  it('scores a sharp image far higher than a blurred one', async () => {
    const s = scoreBlur(await gray('sharp.png'));
    const b = scoreBlur(await gray('blurry.png'));
    expect(s.sharpestRegion).toBeGreaterThan(b.sharpestRegion * 2);
  });

  it('keeps every score inside 0-100', async () => {
    for (const name of ['sharp.png', 'blurry.png', 'lowcontrast.png']) {
      const s = scoreBlur(await gray(name));
      expect(s.global).toBeGreaterThanOrEqual(0);
      expect(s.global).toBeLessThanOrEqual(100);
      expect(s.sharpestRegion).toBeGreaterThanOrEqual(0);
      expect(s.sharpestRegion).toBeLessThanOrEqual(100);
    }
  });

  it('does not penalise low contrast as if it were blur', async () => {
    // A sharp but low-contrast frame must not score like a blurred one.
    // This is what the contrast normalisation exists for.
    const low = scoreBlur(await gray('lowcontrast.png'));
    const blurred = scoreBlur(await gray('blurry.png'));
    expect(low.sharpestRegion).toBeGreaterThan(blurred.sharpestRegion);
  });

  it('rates the sharpest region at least as high as the global score', async () => {
    const s = scoreBlur(await gray('sharp.png'));
    expect(s.sharpestRegion).toBeGreaterThanOrEqual(s.global - 1);
  });
});

describe('scoreFaceBlur', () => {
  it('returns null when there are no faces', async () => {
    expect(scoreFaceBlur(await gray('sharp.png'), [])).toBeNull();
  });

  it('returns the minimum across face regions', async () => {
    const g = await gray('sharp.png');
    const one = scoreFaceBlur(g, [{ x: 0.1, y: 0.1, width: 0.2, height: 0.2 }]);
    const two = scoreFaceBlur(g, [
      { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
      { x: 0.5, y: 0.5, width: 0.2, height: 0.2 },
    ]);
    expect(two!).toBeLessThanOrEqual(one!);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run tests/core/scores/blur.test.ts
```

Expected: FAIL — cannot resolve the module.

- [ ] **Step 3: Implement `src/core/scores/blur.ts`**

```ts
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
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/core/scores/blur.test.ts
```

Expected: 6 passing. If the low-contrast test fails, the contrast normalisation is wrong — fix it rather than weakening the test, because that behaviour is the whole reason this function is not a three-line Laplacian.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: add contrast-normalised blur scoring"
```

---

### Task 7: Exposure scoring

**Files:**
- Create: `src/core/scores/exposure.ts`
- Test: `tests/core/scores/exposure.test.ts`

**Interfaces:**
- Consumes: `GrayImage`.
- Produces: `scoreExposure(gray: GrayImage): number` (0-100, higher is better) and `exposureDetail(gray: GrayImage): ExposureDetail` where `ExposureDetail = { score: number; clipLow: number; clipHigh: number; mean: number; contrast: number }`.

- [ ] **Step 1: Write the failing test**

Create `tests/core/scores/exposure.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { decodeToWorking, toGray } from '../../../src/core/decode.ts';
import { scoreExposure, exposureDetail } from '../../../src/core/scores/exposure.ts';
import { FIXTURE_DIR } from '../../fixtures/globalSetup.ts';

async function gray(name: string) {
  return toGray(await decodeToWorking(join(FIXTURE_DIR, name), 'png'));
}

describe('scoreExposure', () => {
  it('scores a well-exposed frame above an overexposed one', async () => {
    expect(scoreExposure(await gray('sharp.png'))).toBeGreaterThan(scoreExposure(await gray('overexposed.png')));
  });

  it('scores a well-exposed frame above an underexposed one', async () => {
    expect(scoreExposure(await gray('sharp.png'))).toBeGreaterThan(scoreExposure(await gray('underexposed.png')));
  });

  it('penalises very low contrast', async () => {
    expect(scoreExposure(await gray('sharp.png'))).toBeGreaterThan(scoreExposure(await gray('lowcontrast.png')));
  });

  it('stays inside 0-100', async () => {
    for (const n of ['sharp.png', 'overexposed.png', 'underexposed.png', 'lowcontrast.png']) {
      const s = scoreExposure(await gray(n));
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(100);
    }
  });

  it('reports highlight clipping on the overexposed fixture', async () => {
    const d = exposureDetail(await gray('overexposed.png'));
    expect(d.clipHigh).toBeGreaterThan(d.clipLow);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run tests/core/scores/exposure.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/core/scores/exposure.ts`**

```ts
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

/** CALIBRATION. Mid-grey target and penalty weights. */
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

  let score = 100;
  score -= Math.min(40, clipHigh * 400);                       // 10% blown costs 40
  score -= Math.min(30, clipLow * 300);
  score -= Math.min(20, (Math.abs(mean - TARGET_MEAN) / TARGET_MEAN) * 40);
  if (contrast < MIN_HEALTHY_CONTRAST) {
    score -= ((MIN_HEALTHY_CONTRAST - contrast) / MIN_HEALTHY_CONTRAST) * 25;
  }

  return { score: Math.max(0, Math.min(100, score)), clipLow, clipHigh, mean, contrast };
}

export function scoreExposure(gray: GrayImage): number {
  return exposureDetail(gray).score;
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/core/scores/exposure.test.ts
```

Expected: 5 passing.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: add histogram-based exposure scoring"
```

---

### Task 8: Perceptual hashing

**Files:**
- Create: `src/core/scores/phash.ts`
- Test: `tests/core/scores/phash.test.ts`

**Interfaces:**
- Consumes: `WorkingImage`.
- Produces:
  - `perceptualHash(img: WorkingImage): Promise<string>` — 16 lowercase hex characters.
  - `hammingDistance(a: string, b: string): number`

- [ ] **Step 1: Write the failing test**

Create `tests/core/scores/phash.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { decodeToWorking } from '../../../src/core/decode.ts';
import { perceptualHash, hammingDistance } from '../../../src/core/scores/phash.ts';
import { FIXTURE_DIR } from '../../fixtures/globalSetup.ts';

const hash = async (n: string) => perceptualHash(await decodeToWorking(join(FIXTURE_DIR, n), 'png'));

describe('perceptualHash', () => {
  it('returns 16 hex characters', async () => {
    expect(await hash('sharp.png')).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is deterministic', async () => {
    expect(await hash('sharp.png')).toBe(await hash('sharp.png'));
  });

  it('gives near-identical burst frames a small distance', async () => {
    expect(hammingDistance(await hash('burst-1.png'), await hash('burst-2.png'))).toBeLessThanOrEqual(10);
  });

  it('gives an unrelated frame a large distance', async () => {
    const d = hammingDistance(await hash('burst-1.png'), await hash('different.png'));
    expect(d).toBeGreaterThan(10);
  });
});

describe('hammingDistance', () => {
  it('is zero for identical hashes', () => {
    expect(hammingDistance('00ff00ff00ff00ff', '00ff00ff00ff00ff')).toBe(0);
  });

  it('counts differing bits', () => {
    expect(hammingDistance('0000000000000000', '0000000000000001')).toBe(1);
    expect(hammingDistance('0000000000000000', 'ffffffffffffffff')).toBe(64);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run tests/core/scores/phash.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/core/scores/phash.ts`**

```ts
import sharp from 'sharp';
import type { WorkingImage } from '../types.ts';

const N = 32;   // DCT input size
const K = 8;    // low-frequency block kept

/** Precomputed DCT-II basis: cosTable[u * N + x]. */
const cosTable = (() => {
  const t = new Float64Array(N * N);
  for (let u = 0; u < N; u++) {
    for (let x = 0; x < N; x++) {
      t[u * N + x] = Math.cos(((2 * x + 1) * u * Math.PI) / (2 * N));
    }
  }
  return t;
})();

/** Separable 2D DCT-II. Two passes, O(N^3), ~65k operations at N=32. */
function dct2d(input: Float64Array): Float64Array {
  const rows = new Float64Array(N * N);
  for (let y = 0; y < N; y++) {
    for (let u = 0; u < N; u++) {
      let sum = 0;
      for (let x = 0; x < N; x++) sum += input[y * N + x]! * cosTable[u * N + x]!;
      rows[y * N + u] = sum * (u === 0 ? Math.SQRT1_2 : 1);
    }
  }
  const out = new Float64Array(N * N);
  for (let u = 0; u < N; u++) {
    for (let v = 0; v < N; v++) {
      let sum = 0;
      for (let y = 0; y < N; y++) sum += rows[y * N + u]! * cosTable[v * N + y]!;
      out[v * N + u] = sum * (v === 0 ? Math.SQRT1_2 : 1);
    }
  }
  return out;
}

export async function perceptualHash(img: WorkingImage): Promise<string> {
  const buf = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength);
  const small = await sharp(buf, { raw: { width: img.width, height: img.height, channels: 4 } })
    .greyscale()
    .resize(N, N, { fit: 'fill' })
    .raw()
    .toBuffer();

  const input = new Float64Array(N * N);
  for (let i = 0; i < N * N; i++) input[i] = small[i]!;

  const dct = dct2d(input);

  // Top-left K x K block, excluding the DC term from the median.
  const block: number[] = [];
  for (let y = 0; y < K; y++) for (let x = 0; x < K; x++) block.push(dct[y * N + x]!);

  const forMedian = block.slice(1).sort((a, b) => a - b);
  const mid = forMedian.length >> 1;
  const median = forMedian.length % 2
    ? forMedian[mid]!
    : (forMedian[mid - 1]! + forMedian[mid]!) / 2;

  let hex = '';
  for (let nibble = 0; nibble < 16; nibble++) {
    let v = 0;
    for (let bit = 0; bit < 4; bit++) {
      if (block[nibble * 4 + bit]! > median) v |= 1 << (3 - bit);
    }
    hex += v.toString(16);
  }
  return hex;
}

export function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length) throw new Error(`hash length mismatch: ${a.length} vs ${b.length}`);
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i]!, 16) ^ parseInt(b[i]!, 16);
    while (x) { d += x & 1; x >>= 1; }
  }
  return d;
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/core/scores/phash.test.ts
```

Expected: 6 passing.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: add DCT perceptual hashing"
```

---

### Task 9: Face detector interface and null implementation

**Files:**
- Create: `src/core/scores/faces.ts`
- Test: `tests/core/scores/faces.test.ts`

**Interfaces:**
- Consumes: `FaceDetector`, `FaceResult`, `WorkingImage` from types.
- Produces:
  - `class NullFaceDetector implements FaceDetector` — always returns `[]`.
  - `class StubFaceDetector implements FaceDetector` — returns a fixed list, for tests.
  - `MIN_FACE_WIDTH_FRACTION = 0.04`
  - `filterSignificantFaces(faces: FaceResult[]): FaceResult[]`
  - `minEyeScore(faces: FaceResult[]): number | null`

The real MediaPipe detector lands in Phase 2. Everything downstream is written against this interface, so nothing needs to change when it arrives.

- [ ] **Step 1: Write the failing test**

Create `tests/core/scores/faces.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  NullFaceDetector, StubFaceDetector, filterSignificantFaces, minEyeScore,
} from '../../../src/core/scores/faces.ts';
import type { FaceResult } from '../../../src/core/types.ts';

const face = (w: number, eye: number): FaceResult => ({
  box: { x: 0.1, y: 0.1, width: w, height: w },
  eyeOpenScore: eye,
  confidence: 0.9,
});

const img = { width: 100, height: 100, data: new Uint8ClampedArray(100 * 100 * 4) };

describe('NullFaceDetector', () => {
  it('finds no faces', async () => {
    expect(await new NullFaceDetector().detect(img)).toEqual([]);
  });
});

describe('StubFaceDetector', () => {
  it('returns what it was constructed with', async () => {
    const f = face(0.3, 0.8);
    expect(await new StubFaceDetector([f]).detect(img)).toEqual([f]);
  });
});

describe('filterSignificantFaces', () => {
  it('drops faces below the minimum width fraction', () => {
    expect(filterSignificantFaces([face(0.3, 0.9), face(0.01, 0.1)])).toHaveLength(1);
  });

  it('keeps faces at exactly the threshold', () => {
    expect(filterSignificantFaces([face(0.04, 0.9)])).toHaveLength(1);
  });
});

describe('minEyeScore', () => {
  it('returns null when there are no faces', () => {
    expect(minEyeScore([])).toBeNull();
  });

  it('returns the worst eye score, because one blinker ruins a group shot', () => {
    expect(minEyeScore([face(0.3, 0.9), face(0.3, 0.12), face(0.3, 0.7)])).toBeCloseTo(0.12);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run tests/core/scores/faces.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/core/scores/faces.ts`**

```ts
import type { FaceDetector, FaceResult, WorkingImage } from '../types.ts';

/** Faces narrower than this fraction of the long edge are background strangers. */
export const MIN_FACE_WIDTH_FRACTION = 0.04;

/** Used until the MediaPipe detector arrives, and whenever eye checks are disabled. */
export class NullFaceDetector implements FaceDetector {
  async detect(_img: WorkingImage): Promise<FaceResult[]> {
    return [];
  }
}

/** Test double. Returns a fixed result regardless of input. */
export class StubFaceDetector implements FaceDetector {
  constructor(private readonly faces: FaceResult[]) {}
  async detect(_img: WorkingImage): Promise<FaceResult[]> {
    return this.faces;
  }
}

export function filterSignificantFaces(faces: FaceResult[]): FaceResult[] {
  return faces.filter((f) => f.box.width >= MIN_FACE_WIDTH_FRACTION);
}

/**
 * The worst eye in the frame decides the photo. One person mid-blink in a group
 * shot is exactly the case this check exists to catch.
 */
export function minEyeScore(faces: FaceResult[]): number | null {
  if (faces.length === 0) return null;
  return faces.reduce((min, f) => Math.min(min, f.eyeOpenScore), Infinity);
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/core/scores/faces.test.ts
```

Expected: 7 passing.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: add face detector interface with null and stub implementations"
```

---

### Task 10: Burst clustering

**Files:**
- Create: `src/core/cluster.ts`
- Test: `tests/core/cluster.test.ts`

**Interfaces:**
- Consumes: `PhotoRecord`, `Thresholds` from types; `hammingDistance` from `scores/phash.ts`.
- Produces:
  - `clusterBursts(records: PhotoRecord[], t: Pick<Thresholds, 'burstHammingMax' | 'burstWindowMs'>): BurstGroup[]`
  - `interface BurstGroup { id: string; memberIds: PhotoId[]; keeperId: PhotoId }`
  - `combinedQuality(scores: Scores): number`

- [ ] **Step 1: Write the failing test**

Create `tests/core/cluster.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { clusterBursts, combinedQuality } from '../../src/core/cluster.ts';
import type { PhotoRecord, Scores } from '../../src/core/types.ts';

const scores = (over: Partial<Scores> = {}): Scores => ({
  blurGlobal: 70, blurSharpestRegion: 70, blurFaceMin: null,
  exposure: 80, eyeMin: null, faceCount: 0,
  phash: '0000000000000000', ...over,
});

const rec = (id: string, phash: string, t: number, over: Partial<Scores> = {}): PhotoRecord => ({
  file: { absPath: '/' + id, relPath: id, ext: 'jpg', bytes: 1, mtimeMs: t },
  meta: { captureTimeMs: t, orientation: 1, cameraModel: null },
  scores: scores({ phash, ...over }),
});

const OPTS = { burstHammingMax: 10, burstWindowMs: 10_000 };

describe('clusterBursts', () => {
  it('groups near-identical photos taken close together', () => {
    const g = clusterBursts([
      rec('a.jpg', '0000000000000000', 1000),
      rec('b.jpg', '0000000000000001', 3000),
    ], OPTS);
    expect(g).toHaveLength(1);
    expect(g[0]!.memberIds.sort()).toEqual(['a.jpg', 'b.jpg']);
  });

  it('does not group visually different photos', () => {
    expect(clusterBursts([
      rec('a.jpg', '0000000000000000', 1000),
      rec('b.jpg', 'ffffffffffffffff', 2000),
    ], OPTS)).toHaveLength(0);
  });

  it('does not group similar photos taken hours apart', () => {
    expect(clusterBursts([
      rec('a.jpg', '0000000000000000', 1000),
      rec('b.jpg', '0000000000000001', 9_000_000),
    ], OPTS)).toHaveLength(0);
  });

  it('picks the sharpest member as keeper', () => {
    const g = clusterBursts([
      rec('soft.jpg', '0000000000000000', 1000, { blurSharpestRegion: 30 }),
      rec('sharp.jpg', '0000000000000001', 2000, { blurSharpestRegion: 90 }),
    ], OPTS);
    expect(g[0]!.keeperId).toBe('sharp.jpg');
  });

  it('prefers open eyes over marginal extra sharpness', () => {
    const g = clusterBursts([
      rec('blink.jpg', '0000000000000000', 1000, { blurSharpestRegion: 92, eyeMin: 0.05, faceCount: 1, blurFaceMin: 80 }),
      rec('open.jpg', '0000000000000001', 2000, { blurSharpestRegion: 85, eyeMin: 0.95, faceCount: 1, blurFaceMin: 80 }),
    ], OPTS);
    expect(g[0]!.keeperId).toBe('open.jpg');
  });

  it('chains a three-frame burst into one group', () => {
    const g = clusterBursts([
      rec('a.jpg', '0000000000000000', 1000),
      rec('b.jpg', '0000000000000001', 2000),
      rec('c.jpg', '0000000000000003', 3000),
    ], OPTS);
    expect(g).toHaveLength(1);
    expect(g[0]!.memberIds).toHaveLength(3);
  });

  it('falls back to file mtime when there is no capture time', () => {
    const a = rec('a.jpg', '0000000000000000', 1000);
    const b = rec('b.jpg', '0000000000000001', 2000);
    a.meta.captureTimeMs = null;
    b.meta.captureTimeMs = null;
    expect(clusterBursts([a, b], OPTS)).toHaveLength(1);
  });
});

describe('combinedQuality', () => {
  it('ignores face terms when no faces are present', () => {
    expect(combinedQuality(scores({ blurSharpestRegion: 50, exposure: 50 }))).toBeCloseTo(50);
  });

  it('drops sharply when eyes are closed', () => {
    const open = combinedQuality(scores({ eyeMin: 0.95, faceCount: 1, blurFaceMin: 80 }));
    const shut = combinedQuality(scores({ eyeMin: 0.05, faceCount: 1, blurFaceMin: 80 }));
    expect(shut).toBeLessThan(open);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run tests/core/cluster.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/core/cluster.ts`**

```ts
import type { PhotoRecord, PhotoId, Scores, Thresholds } from './types.ts';
import { hammingDistance } from './scores/phash.ts';

export interface BurstGroup {
  id: string;
  memberIds: PhotoId[];
  keeperId: PhotoId;
}

/**
 * Weighted mean used to pick the keeper of a burst. Weights favour the two
 * defects a viewer notices first: a blink and a missed focus on the face.
 * When no faces are present the face terms drop out and the rest renormalise.
 */
export function combinedQuality(s: Scores): number {
  const terms: Array<[value: number, weight: number]> = [
    [s.blurSharpestRegion, 3],
    [s.exposure, 1],
  ];
  if (s.faceCount > 0) {
    if (s.eyeMin !== null) terms.push([s.eyeMin * 100, 3]);
    if (s.blurFaceMin !== null) terms.push([s.blurFaceMin, 2]);
  }
  const totalWeight = terms.reduce((a, [, w]) => a + w, 0);
  return terms.reduce((a, [v, w]) => a + v * w, 0) / totalWeight;
}

function timeOf(r: PhotoRecord): number {
  return r.meta.captureTimeMs ?? r.file.mtimeMs;
}

export function clusterBursts(
  records: PhotoRecord[],
  t: Pick<Thresholds, 'burstHammingMax' | 'burstWindowMs'>,
): BurstGroup[] {
  const sorted = [...records].sort((a, b) => timeOf(a) - timeOf(b));

  // Union-find over the time-sorted list so chains (a~b, b~c) form one group
  // even when a and c are too far apart to match directly.
  const parent = sorted.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  const union = (a: number, b: number) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      if (timeOf(sorted[j]!) - timeOf(sorted[i]!) > t.burstWindowMs) break;
      if (hammingDistance(sorted[i]!.scores.phash, sorted[j]!.scores.phash) <= t.burstHammingMax) {
        union(i, j);
      }
    }
  }

  const byRoot = new Map<number, number[]>();
  for (let i = 0; i < sorted.length; i++) {
    const root = find(i);
    const list = byRoot.get(root);
    if (list) list.push(i); else byRoot.set(root, [i]);
  }

  const groups: BurstGroup[] = [];
  for (const indices of byRoot.values()) {
    if (indices.length < 2) continue;
    let keeper = indices[0]!;
    let best = combinedQuality(sorted[keeper]!.scores);
    for (const i of indices.slice(1)) {
      const q = combinedQuality(sorted[i]!.scores);
      // Ties break toward the earlier frame; the list is already time-sorted.
      if (q > best) { best = q; keeper = i; }
    }
    groups.push({
      id: `burst-${sorted[indices[0]!]!.file.relPath}`,
      memberIds: indices.map((i) => sorted[i]!.file.relPath),
      keeperId: sorted[keeper]!.file.relPath,
    });
  }
  return groups;
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/core/cluster.test.ts
```

Expected: 9 passing.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: add burst clustering with quality-based keeper selection"
```

---

### Task 11: Presets and the verdict function

**Files:**
- Create: `src/core/presets.ts`
- Create: `src/core/verdict.ts`
- Test: `tests/core/verdict.test.ts`

**Interfaces:**
- Consumes: `Scores`, `Thresholds`, `Decision`, `Reason`, `PresetName`, `PhotoRecord`; `BurstGroup` from `cluster.ts`.
- Produces:
  - `PRESETS: Record<PresetName, Thresholds>` in `presets.ts`
  - `decide(record: PhotoRecord, t: Thresholds, group: BurstGroup | null): Decision` in `verdict.ts`
  - `decideAll(records: PhotoRecord[], t: Thresholds, groups: BurstGroup[]): Decision[]`

This is the pure function that makes live threshold sliders possible. It must never touch the filesystem, the clock, or randomness.

- [ ] **Step 1: Write the failing test**

Create `tests/core/verdict.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { decide, decideAll } from '../../src/core/verdict.ts';
import { PRESETS } from '../../src/core/presets.ts';
import type { PhotoRecord, Scores } from '../../src/core/types.ts';

const scores = (over: Partial<Scores> = {}): Scores => ({
  blurGlobal: 70, blurSharpestRegion: 70, blurFaceMin: null,
  exposure: 80, eyeMin: null, faceCount: 0,
  phash: '0000000000000000', ...over,
});

const rec = (id: string, over: Partial<Scores> = {}): PhotoRecord => ({
  file: { absPath: '/' + id, relPath: id, ext: 'jpg', bytes: 1, mtimeMs: 0 },
  meta: { captureTimeMs: 0, orientation: 1, cameraModel: null },
  scores: scores(over),
});

const T = PRESETS.event;

describe('decide', () => {
  it('passes a clean photo', () => {
    expect(decide(rec('a.jpg'), T, null).verdict).toBe('good');
  });

  it('rejects a blurred photo and says so', () => {
    const d = decide(rec('a.jpg', { blurGlobal: 5, blurSharpestRegion: 5 }), T, null);
    expect(d.verdict).toBe('rejected');
    expect(d.reasons.map((r) => r.code)).toContain('blur');
  });

  it('rejects closed eyes', () => {
    const d = decide(rec('a.jpg', { eyeMin: 0.05, faceCount: 1, blurFaceMin: 80 }), T, null);
    expect(d.reasons.map((r) => r.code)).toContain('eyes-closed');
  });

  it('rejects bad exposure', () => {
    expect(decide(rec('a.jpg', { exposure: 10 }), T, null).reasons.map((r) => r.code)).toContain('exposure');
  });

  it('lists every failing check, not just the first', () => {
    const d = decide(rec('a.jpg', { blurSharpestRegion: 5, blurGlobal: 5, exposure: 5 }), T, null);
    expect(d.reasons.length).toBeGreaterThanOrEqual(2);
  });

  it('never rejects for eyes when no face was found', () => {
    const d = decide(rec('a.jpg', { eyeMin: null, faceCount: 0 }), T, null);
    expect(d.reasons.map((r) => r.code)).not.toContain('eyes-closed');
  });

  // The shallow depth-of-field correction.
  it('keeps a soft-background portrait when every face is sharp and eyes are open', () => {
    const d = decide(
      rec('a.jpg', { blurGlobal: 10, blurSharpestRegion: 10, blurFaceMin: 85, eyeMin: 0.9, faceCount: 1 }),
      T, null,
    );
    expect(d.verdict).toBe('good');
  });

  it('does not promote a portrait whose face is also soft', () => {
    const d = decide(
      rec('a.jpg', { blurGlobal: 10, blurSharpestRegion: 10, blurFaceMin: 12, eyeMin: 0.9, faceCount: 1 }),
      T, null,
    );
    expect(d.verdict).toBe('rejected');
  });

  it('rejects non-keeper burst members as duplicates', () => {
    const group = { id: 'g', memberIds: ['a.jpg', 'b.jpg'], keeperId: 'a.jpg' };
    expect(decide(rec('a.jpg'), T, group).verdict).toBe('good');
    const loser = decide(rec('b.jpg'), T, group);
    expect(loser.verdict).toBe('rejected');
    expect(loser.reasons.map((r) => r.code)).toContain('duplicate');
  });

  it('respects the enable flags', () => {
    const off = { ...T, enableBlur: false };
    expect(decide(rec('a.jpg', { blurGlobal: 1, blurSharpestRegion: 1 }), off, null).verdict).toBe('good');
  });

  it('is pure — the same input always gives the same output', () => {
    const r = rec('a.jpg', { blurSharpestRegion: 5, blurGlobal: 5 });
    expect(decide(r, T, null)).toEqual(decide(r, T, null));
  });
});

describe('presets', () => {
  it('disables eye checks in landscape mode', () => {
    expect(PRESETS.landscape.enableEyes).toBe(false);
  });

  it('is stricter about eyes in portrait than in event mode', () => {
    expect(PRESETS.portrait.eyes).toBeGreaterThan(PRESETS.event.eyes);
  });
});

describe('decideAll', () => {
  it('returns one decision per record', () => {
    expect(decideAll([rec('a.jpg'), rec('b.jpg')], T, [])).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run tests/core/verdict.test.ts
```

Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `src/core/presets.ts`**

```ts
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
```

- [ ] **Step 4: Implement `src/core/verdict.ts`**

```ts
import type { Decision, PhotoRecord, Reason, Thresholds } from './types.ts';
import type { BurstGroup } from './cluster.ts';

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

export function decide(
  record: PhotoRecord,
  t: Thresholds,
  group: BurstGroup | null,
): Decision {
  const s = record.scores;
  const reasons: Reason[] = [];

  const facesSharp = s.blurFaceMin !== null && s.blurFaceMin >= t.faceBlur;
  const eyesOpen = s.eyeMin !== null && s.eyeMin >= t.eyes;

  if (t.enableBlur && s.blurSharpestRegion < t.blur) {
    // Face-aware promotion: a portrait with a deliberately soft background is
    // not a mistake, provided the faces themselves are sharp and eyes are open.
    const promoted = s.faceCount > 0 && facesSharp && (!t.enableEyes || eyesOpen);
    if (!promoted) {
      reasons.push({
        code: 'blur',
        detail: `blur ${round(s.blurSharpestRegion)} (threshold ${t.blur})`,
        score: round(s.blurSharpestRegion),
        threshold: t.blur,
      });
    }
  }

  if (t.enableBlur && s.blurFaceMin !== null && s.blurFaceMin < t.faceBlur) {
    reasons.push({
      code: 'blur',
      detail: `face out of focus ${round(s.blurFaceMin)} (threshold ${t.faceBlur})`,
      score: round(s.blurFaceMin),
      threshold: t.faceBlur,
    });
  }

  if (t.enableEyes && s.eyeMin !== null && s.eyeMin < t.eyes) {
    const which = s.faceCount > 1 ? ` · worst of ${s.faceCount} faces` : '';
    reasons.push({
      code: 'eyes-closed',
      detail: `eyes closed ${round(s.eyeMin)}${which} (threshold ${t.eyes})`,
      score: round(s.eyeMin),
      threshold: t.eyes,
    });
  }

  if (t.enableExposure && s.exposure < t.exposure) {
    reasons.push({
      code: 'exposure',
      detail: `exposure ${round(s.exposure)} (threshold ${t.exposure})`,
      score: round(s.exposure),
      threshold: t.exposure,
    });
  }

  const isKeeper = group === null || group.keeperId === record.file.relPath;
  if (t.enableDuplicates && group !== null && !isKeeper) {
    reasons.push({
      code: 'duplicate',
      detail: `burst duplicate — ${group.memberIds.length} similar, keeping ${group.keeperId}`,
      score: 0,
      threshold: 0,
    });
  }

  return {
    id: record.file.relPath,
    verdict: reasons.length > 0 ? 'rejected' : 'good',
    reasons,
    groupId: group?.id ?? null,
    isGroupKeeper: isKeeper,
  };
}

export function decideAll(
  records: PhotoRecord[],
  t: Thresholds,
  groups: BurstGroup[],
): Decision[] {
  const groupOf = new Map<string, BurstGroup>();
  for (const g of groups) for (const id of g.memberIds) groupOf.set(id, g);
  return records.map((r) => decide(r, t, groupOf.get(r.file.relPath) ?? null));
}
```

- [ ] **Step 5: Run tests**

```bash
npx vitest run tests/core/verdict.test.ts
```

Expected: 15 passing.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: add presets and pure verdict function"
```

---

### Task 12: Apply, manifest, and undo

**Files:**
- Create: `src/core/apply.ts`
- Test: `tests/core/apply.test.ts`

**Interfaces:**
- Consumes: `Decision`, `PhotoRecord`, `ScannedFile`.
- Produces:
  - `buildPlan(records, decisions, dests): CopyPlan`
  - `checkFreeSpace(plan: CopyPlan): Promise<{ ok: boolean; requiredBytes: number; availableBytes: number }>`
  - `executePlan(plan: CopyPlan, onProgress?): Promise<Manifest>`
  - `undo(manifestPath: string): Promise<UndoResult>`
  - Types `CopyPlan`, `CopyOp`, `Manifest`, `UndoResult`, `Destinations`

- [ ] **Step 1: Write the failing test**

Create `tests/core/apply.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, access, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPlan, executePlan, undo, checkFreeSpace } from '../../src/core/apply.ts';
import type { Decision, PhotoRecord } from '../../src/core/types.ts';

let src: string, staging: string, review: string;

const rec = (rel: string): PhotoRecord => ({
  file: { absPath: join(src, rel), relPath: rel, ext: 'jpg', bytes: 3, mtimeMs: 0 },
  meta: { captureTimeMs: 0, orientation: 1, cameraModel: null },
  scores: {
    blurGlobal: 70, blurSharpestRegion: 70, blurFaceMin: null,
    exposure: 80, eyeMin: null, faceCount: 0, phash: '0000000000000000',
  },
});

const dec = (id: string, verdict: Decision['verdict']): Decision => ({
  id, verdict, reasons: [], groupId: null, isGroupKeeper: true,
});

beforeEach(async () => {
  const base = await mkdtemp(join(tmpdir(), 'apply-'));
  src = join(base, 'src'); staging = join(base, 'staging'); review = join(base, 'review');
  await mkdir(join(src, 'sub'), { recursive: true });
  await writeFile(join(src, 'good.jpg'), 'aaa');
  await writeFile(join(src, 'sub', 'bad.jpg'), 'bbb');
});

const dests = () => ({ staging, review });

describe('executePlan', () => {
  it('copies keepers to staging and rejects to review', async () => {
    const records = [rec('good.jpg'), rec(join('sub', 'bad.jpg'))];
    const decisions = [dec('good.jpg', 'good'), dec(join('sub', 'bad.jpg'), 'rejected')];
    await executePlan(buildPlan(records, decisions, dests()));

    await access(join(staging, 'good.jpg'));
    await access(join(review, 'sub', 'bad.jpg'));
  });

  it('mirrors the source subfolder structure', async () => {
    await executePlan(buildPlan([rec(join('sub', 'bad.jpg'))], [dec(join('sub', 'bad.jpg'), 'rejected')], dests()));
    expect(await readdir(join(review, 'sub'))).toContain('bad.jpg');
  });

  it('leaves the source folder untouched', async () => {
    const before = (await readdir(src)).sort();
    await executePlan(buildPlan([rec('good.jpg')], [dec('good.jpg', 'good')], dests()));
    expect((await readdir(src)).sort()).toEqual(before);
    expect(await readFile(join(src, 'good.jpg'), 'utf8')).toBe('aaa');
  });

  it('routes unreadable files to their own bucket', async () => {
    await executePlan(buildPlan([rec('good.jpg')], [dec('good.jpg', 'unreadable')], dests()));
    await access(join(review, '_unreadable', 'good.jpg'));
  });

  it('suffixes rather than overwrites a differing file', async () => {
    await mkdir(staging, { recursive: true });
    await writeFile(join(staging, 'good.jpg'), 'DIFFERENT');
    await executePlan(buildPlan([rec('good.jpg')], [dec('good.jpg', 'good')], dests()));
    expect(await readFile(join(staging, 'good.jpg'), 'utf8')).toBe('DIFFERENT');
    await access(join(staging, 'good (2).jpg'));
  });

  it('skips a byte-identical file already at the destination', async () => {
    await mkdir(staging, { recursive: true });
    await writeFile(join(staging, 'good.jpg'), 'aaa');
    const m = await executePlan(buildPlan([rec('good.jpg')], [dec('good.jpg', 'good')], dests()));
    expect(m.skipped).toBe(1);
    expect(await readdir(staging)).toEqual(['good.jpg']);
  });

  it('writes a manifest listing every copy', async () => {
    const m = await executePlan(buildPlan([rec('good.jpg')], [dec('good.jpg', 'good')], dests()));
    expect(m.operations).toHaveLength(1);
    expect(JSON.parse(await readFile(m.manifestPath, 'utf8')).operations).toHaveLength(1);
  });
});

describe('undo', () => {
  it('removes copied files and leaves the source alone', async () => {
    const m = await executePlan(buildPlan([rec('good.jpg')], [dec('good.jpg', 'good')], dests()));
    const r = await undo(m.manifestPath);
    expect(r.removed).toBe(1);
    await expect(access(join(staging, 'good.jpg'))).rejects.toThrow();
    await access(join(src, 'good.jpg'));
  });

  it('refuses to remove a file that has been modified since the copy', async () => {
    const m = await executePlan(buildPlan([rec('good.jpg')], [dec('good.jpg', 'good')], dests()));
    await writeFile(join(staging, 'good.jpg'), 'edited by the user');
    const r = await undo(m.manifestPath);
    expect(r.removed).toBe(0);
    expect(r.skipped).toBe(1);
    await access(join(staging, 'good.jpg'));
  });
});

describe('checkFreeSpace', () => {
  it('reports the required bytes for the plan', async () => {
    const r = await checkFreeSpace(buildPlan([rec('good.jpg')], [dec('good.jpg', 'good')], dests()));
    expect(r.requiredBytes).toBeGreaterThan(0);
    expect(r.ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run tests/core/apply.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/core/apply.ts`**

```ts
import { copyFile, mkdir, readFile, writeFile, stat, unlink, statfs } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, extname, basename } from 'node:path';
import type { Decision, PhotoRecord, PhotoId } from './types.ts';

export interface Destinations {
  staging: string;
  review: string;
}

export interface CopyOp {
  id: PhotoId;
  from: string;
  to: string;
  bytes: number;
}

export interface CopyPlan {
  ops: CopyOp[];
  dests: Destinations;
  runId: string;
}

export interface Manifest {
  runId: string;
  createdAt: string;
  manifestPath: string;
  operations: Array<{ from: string; to: string; bytes: number; mtimeMs: number }>;
  skipped: number;
}

export interface UndoResult {
  removed: number;
  skipped: number;
}

/** Deterministic, filesystem-safe run identifier. */
function makeRunId(now: Date): string {
  return `run-${now.toISOString().replace(/[:.]/g, '-')}`;
}

export function buildPlan(
  records: PhotoRecord[],
  decisions: Decision[],
  dests: Destinations,
  now: Date = new Date(),
): CopyPlan {
  const byId = new Map(records.map((r) => [r.file.relPath, r]));
  const ops: CopyOp[] = [];

  for (const d of decisions) {
    const rec = byId.get(d.id);
    if (!rec) continue;
    const root =
      d.verdict === 'good' ? dests.staging
      : d.verdict === 'unreadable' ? join(dests.review, '_unreadable')
      : dests.review;
    ops.push({
      id: d.id,
      from: rec.file.absPath,
      to: join(root, d.verdict === 'unreadable' ? basename(d.id) : d.id),
      bytes: rec.file.bytes,
    });
  }
  return { ops, dests, runId: makeRunId(now) };
}

export async function checkFreeSpace(
  plan: CopyPlan,
): Promise<{ ok: boolean; requiredBytes: number; availableBytes: number }> {
  const requiredBytes = Math.ceil(plan.ops.reduce((a, o) => a + o.bytes, 0) * 1.05);
  await mkdir(plan.dests.staging, { recursive: true });
  const fs = await statfs(plan.dests.staging);
  const availableBytes = Number(fs.bavail) * Number(fs.bsize);
  return { ok: availableBytes >= requiredBytes, requiredBytes, availableBytes };
}

async function sha256(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

/** Never overwrite. Returns null when an identical file is already there. */
async function resolveTarget(to: string, from: string): Promise<string | null> {
  let candidate = to;
  let n = 1;
  for (;;) {
    try {
      await stat(candidate);
    } catch {
      return candidate; // free
    }
    if ((await sha256(candidate)) === (await sha256(from))) return null;
    n++;
    const ext = extname(to);
    candidate = join(dirname(to), `${basename(to, ext)} (${n})${ext}`);
  }
}

export async function executePlan(
  plan: CopyPlan,
  onProgress?: (done: number, total: number) => void,
): Promise<Manifest> {
  const operations: Manifest['operations'] = [];
  let skipped = 0;

  for (const [i, op] of plan.ops.entries()) {
    await mkdir(dirname(op.to), { recursive: true });
    const target = await resolveTarget(op.to, op.from);
    if (target === null) {
      skipped++;
    } else {
      await copyFile(op.from, target);
      const s = await stat(target);
      operations.push({ from: op.from, to: target, bytes: op.bytes, mtimeMs: s.mtimeMs });
    }
    onProgress?.(i + 1, plan.ops.length);
  }

  const runDir = join(plan.dests.staging, '_photo-triage', plan.runId);
  await mkdir(runDir, { recursive: true });
  const manifestPath = join(runDir, 'manifest.json');
  const manifest: Manifest = {
    runId: plan.runId,
    createdAt: new Date().toISOString(),
    manifestPath,
    operations,
    skipped,
  };
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  return manifest;
}

/**
 * Removes exactly the files this run created. A file whose size or mtime has
 * changed since the copy is left alone — the user may have edited it.
 */
export async function undo(manifestPath: string): Promise<UndoResult> {
  const manifest: Manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  let removed = 0, skipped = 0;

  for (const op of manifest.operations) {
    try {
      const s = await stat(op.to);
      if (Math.abs(s.mtimeMs - op.mtimeMs) > 1) { skipped++; continue; }
      await unlink(op.to);
      removed++;
    } catch {
      skipped++;
    }
  }
  return { removed, skipped };
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/core/apply.test.ts
```

Expected: 10 passing.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: add copy planning, execution, manifest and undo"
```

---

### Task 13: Analysis orchestration and reports

**Files:**
- Create: `src/core/analyze.ts`
- Create: `src/core/report.ts`
- Test: `tests/core/report.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 3-11.
- Produces:
  - `analyzePhoto(file: ScannedFile, reader: MetadataReader, detector: FaceDetector): Promise<PhotoRecord>` — throws `UnreadableError`.
  - `analyzeAll(files, reader, detector, onProgress?): Promise<{ records: PhotoRecord[]; unreadable: ScannedFile[] }>`
  - `toCsv(records: PhotoRecord[], decisions: Decision[]): string`
  - `toHtml(records, decisions, summary): string`
  - `summarize(decisions: Decision[]): Summary` where `Summary = { total: number; good: number; rejected: number; unreadable: number; byReason: Record<string, number> }`

- [ ] **Step 1: Write the failing test**

Create `tests/core/report.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { toCsv, summarize, toHtml } from '../../src/core/report.ts';
import type { Decision, PhotoRecord } from '../../src/core/types.ts';

const rec = (id: string): PhotoRecord => ({
  file: { absPath: '/' + id, relPath: id, ext: 'jpg', bytes: 1, mtimeMs: 0 },
  meta: { captureTimeMs: 0, orientation: 1, cameraModel: 'Test Cam' },
  scores: {
    blurGlobal: 70, blurSharpestRegion: 72, blurFaceMin: null,
    exposure: 80, eyeMin: null, faceCount: 0, phash: '0000000000000000',
  },
});

const good: Decision = { id: 'a.jpg', verdict: 'good', reasons: [], groupId: null, isGroupKeeper: true };
const bad: Decision = {
  id: 'b,with,commas.jpg', verdict: 'rejected',
  reasons: [{ code: 'blur', detail: 'blur 5 (threshold 35)', score: 5, threshold: 35 }],
  groupId: null, isGroupKeeper: true,
};

describe('toCsv', () => {
  it('writes a header plus one row per photo', () => {
    const lines = toCsv([rec('a.jpg'), rec('b,with,commas.jpg')], [good, bad]).trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('relPath');
  });

  it('quotes fields containing commas so the CSV stays parseable', () => {
    expect(toCsv([rec('b,with,commas.jpg')], [bad])).toContain('"b,with,commas.jpg"');
  });
});

describe('summarize', () => {
  it('counts verdicts and reasons', () => {
    const s = summarize([good, bad]);
    expect(s.total).toBe(2);
    expect(s.good).toBe(1);
    expect(s.rejected).toBe(1);
    expect(s.byReason.blur).toBe(1);
  });
});

describe('toHtml', () => {
  it('escapes HTML in filenames rather than injecting it', () => {
    const evil: Decision = { ...good, id: '<script>x</script>.jpg' };
    const html = toHtml([rec('<script>x</script>.jpg')], [evil], summarize([evil]));
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run tests/core/report.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/core/analyze.ts`**

```ts
import type { FaceDetector, PhotoRecord, ScannedFile } from './types.ts';
import { decodeToWorking, toGray, UnreadableError } from './decode.ts';
import { MetadataReader } from './metadata.ts';
import { scoreBlur, scoreFaceBlur } from './scores/blur.ts';
import { scoreExposure } from './scores/exposure.ts';
import { perceptualHash } from './scores/phash.ts';
import { filterSignificantFaces, minEyeScore } from './scores/faces.ts';

export async function analyzePhoto(
  file: ScannedFile,
  reader: MetadataReader,
  detector: FaceDetector,
): Promise<PhotoRecord> {
  const meta = await reader.read(file.absPath);
  const img = await decodeToWorking(file.absPath, file.ext, {}, (p) => reader.extractRawPreview(p));
  const gray = toGray(img);

  const faces = filterSignificantFaces(await detector.detect(img));
  const blur = scoreBlur(gray);

  return {
    file,
    meta,
    scores: {
      blurGlobal: blur.global,
      blurSharpestRegion: blur.sharpestRegion,
      blurFaceMin: scoreFaceBlur(gray, faces.map((f) => f.box)),
      exposure: scoreExposure(gray),
      eyeMin: minEyeScore(faces),
      faceCount: faces.length,
      phash: await perceptualHash(img),
    },
  };
}

export async function analyzeAll(
  files: ScannedFile[],
  reader: MetadataReader,
  detector: FaceDetector,
  onProgress?: (done: number, total: number, current: string) => void,
): Promise<{ records: PhotoRecord[]; unreadable: ScannedFile[] }> {
  const records: PhotoRecord[] = [];
  const unreadable: ScannedFile[] = [];

  for (const [i, file] of files.entries()) {
    try {
      records.push(await analyzePhoto(file, reader, detector));
    } catch (err) {
      // A file we cannot decode is reported, never silently dropped.
      if (err instanceof UnreadableError) unreadable.push(file);
      else throw err;
    }
    onProgress?.(i + 1, files.length, file.relPath);
  }
  return { records, unreadable };
}
```

- [ ] **Step 4: Implement `src/core/report.ts`**

```ts
import type { Decision, PhotoRecord } from './types.ts';

export interface Summary {
  total: number;
  good: number;
  rejected: number;
  unreadable: number;
  byReason: Record<string, number>;
}

export function summarize(decisions: Decision[]): Summary {
  const s: Summary = { total: decisions.length, good: 0, rejected: 0, unreadable: 0, byReason: {} };
  for (const d of decisions) {
    if (d.verdict === 'good') s.good++;
    else if (d.verdict === 'rejected') s.rejected++;
    else s.unreadable++;
    for (const r of d.reasons) s.byReason[r.code] = (s.byReason[r.code] ?? 0) + 1;
  }
  return s;
}

function csvField(v: unknown): string {
  const str = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

const CSV_HEADER = [
  'relPath', 'verdict', 'reasons', 'blurGlobal', 'blurSharpestRegion',
  'blurFaceMin', 'exposure', 'eyeMin', 'faceCount', 'phash', 'captureTime', 'camera',
];

export function toCsv(records: PhotoRecord[], decisions: Decision[]): string {
  const byId = new Map(records.map((r) => [r.file.relPath, r]));
  const rows = [CSV_HEADER.join(',')];

  for (const d of decisions) {
    const r = byId.get(d.id);
    rows.push([
      d.id,
      d.verdict,
      d.reasons.map((x) => x.detail).join('; '),
      r?.scores.blurGlobal.toFixed(1),
      r?.scores.blurSharpestRegion.toFixed(1),
      r?.scores.blurFaceMin?.toFixed(1) ?? '',
      r?.scores.exposure.toFixed(1),
      r?.scores.eyeMin?.toFixed(3) ?? '',
      r?.scores.faceCount,
      r?.scores.phash,
      r?.meta.captureTimeMs ? new Date(r.meta.captureTimeMs).toISOString() : '',
      r?.meta.cameraModel ?? '',
    ].map(csvField).join(','));
  }
  return rows.join('\n') + '\n';
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function toHtml(records: PhotoRecord[], decisions: Decision[], summary: Summary): string {
  const byId = new Map(records.map((r) => [r.file.relPath, r]));
  const rows = decisions.map((d) => {
    const r = byId.get(d.id);
    return `<tr class="${d.verdict}">
      <td>${escapeHtml(d.id)}</td>
      <td>${d.verdict}</td>
      <td>${escapeHtml(d.reasons.map((x) => x.detail).join('; '))}</td>
      <td>${r?.scores.blurSharpestRegion.toFixed(1) ?? ''}</td>
      <td>${r?.scores.exposure.toFixed(1) ?? ''}</td>
    </tr>`;
  }).join('\n');

  return `<!doctype html>
<meta charset="utf-8">
<title>Photo Triage report</title>
<style>
  body { font: 14px system-ui, sans-serif; margin: 2rem; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: .35rem .6rem; border-bottom: 1px solid #ddd; }
  tr.rejected { background: #fff5f5; }
  tr.unreadable { background: #fffbe6; }
</style>
<h1>Photo Triage report</h1>
<p>${summary.total} photos — ${summary.good} good, ${summary.rejected} rejected, ${summary.unreadable} unreadable.</p>
<table>
  <thead><tr><th>File</th><th>Verdict</th><th>Reasons</th><th>Blur</th><th>Exposure</th></tr></thead>
  <tbody>${rows}</tbody>
</table>
`;
}
```

- [ ] **Step 5: Run tests**

```bash
npx vitest run tests/core/report.test.ts
```

Expected: 5 passing.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: add analysis orchestration and CSV/HTML reports"
```

---

### Task 14: CLI and end-to-end integration test

**Files:**
- Create: `src/cli/index.ts`
- Create: `README.md`
- Test: `tests/integration/pipeline.test.ts`
- Test: `tests/architecture.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: a runnable CLI. No exported API — this is the top of the stack.

- [ ] **Step 1: Write the failing integration test**

Create `tests/integration/pipeline.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, copyFile, readdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanDirectory } from '../../src/core/scan.ts';
import { MetadataReader } from '../../src/core/metadata.ts';
import { NullFaceDetector } from '../../src/core/scores/faces.ts';
import { analyzeAll } from '../../src/core/analyze.ts';
import { clusterBursts } from '../../src/core/cluster.ts';
import { decideAll } from '../../src/core/verdict.ts';
import { PRESETS } from '../../src/core/presets.ts';
import { buildPlan, executePlan } from '../../src/core/apply.ts';
import { FIXTURE_DIR } from '../fixtures/globalSetup.ts';

let src: string, staging: string, review: string;
const reader = new MetadataReader();

beforeAll(async () => {
  const base = await mkdtemp(join(tmpdir(), 'pipeline-'));
  src = join(base, 'src'); staging = join(base, 'staging'); review = join(base, 'review');
  await mkdir(join(src, 'nested'), { recursive: true });
  for (const f of ['sharp.png', 'blurry.png', 'overexposed.png', 'burst-1.png', 'burst-2.png', 'corrupt.jpg']) {
    await copyFile(join(FIXTURE_DIR, f), join(src, f));
  }
  await copyFile(join(FIXTURE_DIR, 'sharp.png'), join(src, 'nested', 'deep.png'));
});

afterAll(() => reader.close());

describe('full pipeline', () => {
  it('sorts a folder end to end', async () => {
    const scan = await scanDirectory(src);
    expect(scan.images.length).toBe(7);

    const { records, unreadable } = await analyzeAll(scan.images, reader, new NullFaceDetector());
    expect(unreadable).toHaveLength(1);
    expect(unreadable[0]!.relPath).toBe('corrupt.jpg');

    const groups = clusterBursts(records, PRESETS.event);
    const decisions = decideAll(records, PRESETS.event, groups);
    decisions.push(...unreadable.map((f) => ({
      id: f.relPath, verdict: 'unreadable' as const, reasons: [], groupId: null, isGroupKeeper: true,
    })));

    await executePlan(buildPlan([...records,
      ...unreadable.map((f) => ({ file: f, meta: { captureTimeMs: null, orientation: 1, cameraModel: null }, scores: records[0]!.scores })),
    ], decisions, { staging, review }));

    // The sharp fixture is a keeper; the blurred one is not.
    await access(join(staging, 'sharp.png'));
    await access(join(review, 'blurry.png'));
    // Subfolder structure is mirrored.
    await access(join(staging, 'nested', 'deep.png'));
    // Corrupt files land in their own bucket.
    await access(join(review, '_unreadable', 'corrupt.jpg'));
    // Source is untouched.
    expect((await readdir(src)).length).toBe(7);
  });
});
```

- [ ] **Step 2: Write the architecture test**

Create `tests/architecture.test.ts`. This enforces the constraint that makes the engine reusable by the Electron app in Phase 2.

```ts
import { describe, it, expect } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...await walk(p));
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('core isolation', () => {
  it('never imports electron or UI layers', async () => {
    const offenders: string[] = [];
    for (const file of await walk('src/core')) {
      const src = await readFile(file, 'utf8');
      if (/from\s+['"](electron|\.\.\/(main|renderer|worker))/.test(src)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
```

- [ ] **Step 3: Run to verify they fail**

```bash
npx vitest run tests/integration/pipeline.test.ts tests/architecture.test.ts
```

Expected: the pipeline test fails (`src/cli/index.ts` not needed yet, but `analyze.ts` wiring may surface issues); the architecture test should pass immediately. If the architecture test fails, fix the import before continuing.

- [ ] **Step 4: Implement `src/cli/index.ts`**

```ts
import { parseArgs } from 'node:util';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { scanDirectory } from '../core/scan.ts';
import { MetadataReader } from '../core/metadata.ts';
import { NullFaceDetector } from '../core/scores/faces.ts';
import { analyzeAll } from '../core/analyze.ts';
import { clusterBursts } from '../core/cluster.ts';
import { decideAll } from '../core/verdict.ts';
import { PRESETS } from '../core/presets.ts';
import { buildPlan, executePlan, checkFreeSpace, undo } from '../core/apply.ts';
import { toCsv, toHtml, summarize } from '../core/report.ts';
import type { Decision, PhotoRecord, PresetName } from '../core/types.ts';

const USAGE = `
photo-triage — sort photos by defect

  --source <dir>     folder to scan (required)
  --staging <dir>    where keepers are copied (required)
  --review <dir>     where rejects are copied (required)
  --preset <name>    event | portrait | landscape   (default: event)
  --no-recurse       do not descend into subfolders
  --dry-run          analyse and report, copy nothing
  --undo <manifest>  reverse a previous run

Note: eye detection is not available in the CLI. It requires the Electron
renderer and arrives in Phase 2; runs here score blur, exposure and duplicates.
`;

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      source: { type: 'string' },
      staging: { type: 'string' },
      review: { type: 'string' },
      preset: { type: 'string', default: 'event' },
      'no-recurse': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      undo: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  if (values.help) { console.log(USAGE); return 0; }

  if (values.undo) {
    const r = await undo(values.undo);
    console.log(`Undo complete: ${r.removed} removed, ${r.skipped} left in place.`);
    return 0;
  }

  const { source, staging, review } = values;
  if (!source || !staging || !review) {
    console.error('Error: --source, --staging and --review are all required.');
    console.error(USAGE);
    return 2;
  }
  if (!(values.preset! in PRESETS)) {
    console.error(`Error: unknown preset "${values.preset}". Use event, portrait or landscape.`);
    return 2;
  }
  const thresholds = PRESETS[values.preset as PresetName];

  const reader = new MetadataReader();
  try {
    const scan = await scanDirectory(source, { recurse: !values['no-recurse'] });
    console.log(`Found ${scan.images.length} images (${scan.skipped} non-image files ignored).`);
    if (scan.images.length === 0) return 0;

    const { records, unreadable } = await analyzeAll(
      scan.images, reader, new NullFaceDetector(),
      (done, total, current) => {
        process.stdout.write(`\r  analysing ${done}/${total}  ${current.slice(0, 50).padEnd(50)}`);
      },
    );
    process.stdout.write('\n');

    const groups = clusterBursts(records, thresholds);
    const decisions: Decision[] = decideAll(records, thresholds, groups);

    const placeholderScores = records[0]?.scores;
    const unreadableRecords: PhotoRecord[] = unreadable.map((f) => ({
      file: f,
      meta: { captureTimeMs: null, orientation: 1, cameraModel: null },
      scores: placeholderScores ?? {
        blurGlobal: 0, blurSharpestRegion: 0, blurFaceMin: null, exposure: 0,
        eyeMin: null, faceCount: 0, phash: '0000000000000000',
      },
    }));
    for (const f of unreadable) {
      decisions.push({ id: f.relPath, verdict: 'unreadable', reasons: [], groupId: null, isGroupKeeper: true });
    }

    const summary = summarize(decisions);
    console.log(`\n  ${summary.good} good, ${summary.rejected} rejected, ${summary.unreadable} unreadable`);
    for (const [reason, count] of Object.entries(summary.byReason)) {
      console.log(`    ${reason}: ${count}`);
    }
    console.log(`  ${groups.length} burst group(s) detected`);

    const allRecords = [...records, ...unreadableRecords];
    const plan = buildPlan(allRecords, decisions, { staging, review });

    if (values['dry-run']) {
      console.log('\nDry run — nothing copied.');
      return 0;
    }

    const space = await checkFreeSpace(plan);
    if (!space.ok) {
      console.error(`Not enough free space: need ${space.requiredBytes} bytes, have ${space.availableBytes}.`);
      return 1;
    }

    const manifest = await executePlan(plan);
    const runDir = join(staging, '_photo-triage', manifest.runId);
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, 'report.csv'), toCsv(allRecords, decisions), 'utf8');
    await writeFile(join(runDir, 'report.html'), toHtml(allRecords, decisions, summary), 'utf8');

    console.log(`\nCopied ${manifest.operations.length} files (${manifest.skipped} already present).`);
    console.log(`Reports: ${runDir}`);
    console.log(`Undo:    npm run triage -- --undo "${manifest.manifestPath}"`);
    return 0;
  } finally {
    await reader.close();
  }
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 5: Run the whole suite**

```bash
npm test && npm run typecheck
```

Expected: all tests pass, no type errors.

- [ ] **Step 6: Verify the CLI by hand against real photos**

Use a folder of your own photos — this is the first time the engine meets files it did not generate, and it is where RAW preview extraction (R2) actually gets exercised.

```bash
npm run triage -- --source ~/Pictures/test-batch --staging /tmp/pt-staging --review /tmp/pt-review --dry-run
```

Expected: a count of images found, a per-reason breakdown, and no crash on any RAW or HEIC file. Investigate anything reported unreadable.

- [ ] **Step 7: Write `README.md`**

```markdown
# Photo Triage

Sorts a folder of photos into keepers and rejects, flagging blur, bad exposure,
closed eyes, and near-duplicate burst frames. Your source folder is never
modified — everything is copied.

## Status

Phase 1: analysis engine and CLI. The desktop application and eye detection
arrive in Phase 2.

## Requirements

Node 22 or newer.

## Usage

    npm install
    npm run triage -- --source ~/Pictures/shoot --staging ~/Pictures/keep --review ~/Pictures/check

Options:

| Flag | Meaning |
|---|---|
| `--preset` | `event` (default), `portrait`, or `landscape` |
| `--no-recurse` | Stay in the top folder |
| `--dry-run` | Analyse and report without copying |
| `--undo <manifest>` | Reverse a previous run |

Each run writes `manifest.json`, `report.csv`, and `report.html` under
`<staging>/_photo-triage/run-<timestamp>/`.

## Formats

JPEG, PNG, TIFF, WebP, AVIF, HEIC/HEIF, and camera RAW (CR2, CR3, NEF, ARW,
DNG, RAF, ORF, RW2, PEF, SRW). RAW files are analysed via their embedded JPEG
preview.

HEIC is decoded with `libheif-js` rather than `sharp` — sharp's prebuilt binary
ships libheif without the HEVC decoder, so it fails on iPhone photos with a
misleading "bad seek" error.

## Development

    npm test
    npm run typecheck
```

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: add CLI, integration test, and README"
```

- [ ] **Step 9: Push**

```bash
git push
```

---

## Self-Review

**Spec coverage.** Scan (T3), decode across all formats (T4), metadata and RAW previews (T5), blur (T6), exposure (T7), perceptual hash (T8), face interface (T9), burst clustering with the spec's exact weighted keeper formula (T10), presets and the pure verdict with face-aware promotion (T11), copy/manifest/undo/free-space/collisions/unreadable bucket (T12), CSV and HTML reports (T13), CLI and end-to-end test (T14).

**Deferred to Phase 2, by design:** the MediaPipe face detector implementation, the score cache (`cache.ts`), and everything Electron — shell, screens, review UI, live threshold sliders, packaging, CI. The cache is deferred because it is an optimisation with no consumer until repeat runs exist in the UI; the CLI re-analyses each time, which is acceptable at this scale.

**Known rough edge, deliberately accepted:** in Task 14 the CLI builds placeholder `PhotoRecord`s for unreadable files so `buildPlan` can route them, reusing another photo's scores. Those scores are never read for unreadable entries — `buildPlan` uses only `file`, and the CSV writer prints the verdict. It is ugly. Phase 2 should give `buildPlan` an explicit unreadable list instead.
