# Photo Triage Review Screen — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put a review step between analysis and disk. Every decision is shown with the reason and score behind it, strictness is adjustable with live sliders, any verdict can be overridden, and **nothing is written until Apply is pressed**.

**Architecture:** The payoff of Phase 1's separation of scoring from verdict. Scoring stays in the main process and runs once. `verdict.ts` and `cluster.ts` are pure, so the *renderer* imports them directly and re-decides all 2,000 photos locally on every slider drag — no IPC, no re-analysis. Main serves cached thumbnails over a custom protocol. Apply is a second IPC call that takes the final decisions.

**Tech Stack:** As Phase 2a, plus jsdom 30 and @testing-library/react 16 for component tests.

**Source spec:** `docs/superpowers/specs/2026-08-03-photo-triage-design.md`
**Predecessors:** core-engine and electron-shell plans (both complete, merged)

## Global Constraints

- `src/core/` stays free of Electron imports; the existing architecture test enforces it.
- **A new constraint, enforced by a new test:** `verdict.ts`, `cluster.ts` and the modules they import must not pull in `sharp`, `exiftool-vendored`, `node:fs` or any Node built-in. They run in the renderer. Breaking this is what would silently kill live re-filtering.
- **The source folder stays read-only.** Copy only.
- Nothing is written to the staging or review folders until the user presses Apply.
- Score direction stays "higher is better".
- Existing tests keep passing; `npm test` and `npm run typecheck` green at the end of every task.
- Commit after every task.

## Deferred deliberately

Full keyboard navigation beyond arrows and G/R, and the score cache, both move to the packaging plan. The review screen is already the largest piece of work in the project.

---

### Task 1: Make clustering and verdict renderer-safe

**Files:**
- Create: `src/core/scores/hamming.ts`
- Modify: `src/core/scores/phash.ts`, `src/core/cluster.ts`
- Test: `tests/architecture.test.ts` (extend)

**Interfaces:**
- Produces: `hammingDistance(a: string, b: string): number` from `src/core/scores/hamming.ts`. `phash.ts` re-exports it for compatibility.

`cluster.ts` currently imports `hammingDistance` from `phash.ts`, which imports `sharp`. Importing `cluster.ts` in the renderer would therefore try to load a native Node module and fail. Splitting the pure function out is the whole enabler for live re-filtering.

- [ ] **Step 1: Extend the architecture test first**

Add to `tests/architecture.test.ts`:

```ts
/** Modules the renderer imports directly. They must stay free of Node. */
const RENDERER_SAFE_ENTRY = ['src/core/verdict.ts', 'src/core/cluster.ts'];
const FORBIDDEN = /from\s+['"](sharp|exiftool-vendored|libheif-js|electron|node:)/;

async function transitiveImports(entry: string, seen = new Set<string>()): Promise<string[]> {
  if (seen.has(entry)) return [];
  seen.add(entry);
  const src = await readFile(entry, 'utf8');
  const out = [entry];
  for (const m of src.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
    const rel = m[1]!;
    const resolved = join(dirname(entry), rel);
    out.push(...await transitiveImports(resolved, seen));
  }
  return out;
}

describe('renderer-safe core', () => {
  it('keeps verdict and cluster free of Node-only dependencies', async () => {
    const offenders: string[] = [];
    for (const entry of RENDERER_SAFE_ENTRY) {
      for (const file of await transitiveImports(entry)) {
        const src = await readFile(file, 'utf8');
        // `import type` is erased at build time and cannot pull in a runtime dep.
        for (const line of src.split('\n')) {
          if (line.includes('import type')) continue;
          if (FORBIDDEN.test(line)) offenders.push(`${file}: ${line.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
```

Add `dirname` to the existing `node:path` import.

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run tests/architecture.test.ts
```

Expected: FAIL, naming `src/core/scores/phash.ts` importing `sharp`.

- [ ] **Step 3: Create `src/core/scores/hamming.ts`**

```ts
/**
 * Split out of phash.ts so that cluster.ts — and therefore verdict — can be
 * imported by the renderer. phash.ts needs sharp to downscale an image; this
 * comparison is pure arithmetic and must stay that way.
 */
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

- [ ] **Step 4: Update `phash.ts` and `cluster.ts`**

In `phash.ts`, delete the `hammingDistance` implementation and add at the top:

```ts
export { hammingDistance } from './hamming.ts';
```

In `cluster.ts`, change the import to:

```ts
import { hammingDistance } from './scores/hamming.ts';
```

- [ ] **Step 5: Run tests**

```bash
npx vitest run && npm run typecheck
```

Expected: all pass, including the existing phash tests, which still import `hammingDistance` from `phash.ts`.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "refactor: split hamming distance out so cluster is renderer-safe"
```

---

### Task 2: Carry face boxes through to the UI

**Files:**
- Modify: `src/core/types.ts`, `src/core/analyze.ts`
- Test: `tests/core/analyze-faces.test.ts`

**Interfaces:**
- Produces: `PhotoRecord.faces: FaceResult[]` — the significant faces, with normalised boxes.

The review screen shows a 100% crop of the face behind an "eyes closed" call, so the box has to survive to the renderer. Today `analyzePhoto` computes faces, uses them, and throws them away.

- [ ] **Step 1: Write the failing test**

Create `tests/core/analyze-faces.test.ts`:

```ts
import { describe, it, expect, afterAll } from 'vitest';
import { join } from 'node:path';
import { analyzePhoto } from '../../src/core/analyze.ts';
import { MetadataReader } from '../../src/core/metadata.ts';
import { StubFaceDetector, NullFaceDetector } from '../../src/core/scores/faces.ts';
import { FIXTURE_DIR } from '../fixtures/globalSetup.ts';
import type { ScannedFile } from '../../src/core/types.ts';

const reader = new MetadataReader();
afterAll(() => reader.close());

const file = (name: string): ScannedFile => ({
  absPath: join(FIXTURE_DIR, name), relPath: name, ext: 'png', bytes: 1, mtimeMs: 0,
});

describe('analyzePhoto face reporting', () => {
  it('keeps the boxes of significant faces', async () => {
    const face = { box: { x: 0.2, y: 0.1, width: 0.3, height: 0.3 }, eyeOpenScore: 0.1, confidence: 0.9 };
    const r = await analyzePhoto(file('sharp.png'), reader, new StubFaceDetector([face]));
    expect(r.faces).toHaveLength(1);
    expect(r.faces[0]!.box.width).toBeCloseTo(0.3);
  });

  it('drops faces too small to be significant, matching faceCount', async () => {
    const big = { box: { x: 0.2, y: 0.1, width: 0.3, height: 0.3 }, eyeOpenScore: 0.9, confidence: 0.9 };
    const tiny = { box: { x: 0.8, y: 0.8, width: 0.01, height: 0.01 }, eyeOpenScore: 0.1, confidence: 0.9 };
    const r = await analyzePhoto(file('sharp.png'), reader, new StubFaceDetector([big, tiny]));
    expect(r.faces).toHaveLength(1);
    expect(r.scores.faceCount).toBe(1);
  });

  it('reports an empty list when there are no faces', async () => {
    const r = await analyzePhoto(file('sharp.png'), reader, new NullFaceDetector());
    expect(r.faces).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run tests/core/analyze-faces.test.ts
```

Expected: FAIL — `faces` is undefined.

- [ ] **Step 3: Add the field**

In `src/core/types.ts`, add to `PhotoRecord`:

```ts
  /** Significant faces only, in the same order the detector returned them. */
  faces: FaceResult[];
```

In `src/core/analyze.ts`, return `faces` alongside `file`, `meta` and `scores`.

- [ ] **Step 4: Fix the type errors this causes**

`npm run typecheck` will now flag every place a `PhotoRecord` literal is built in tests. Add `faces: []` to each. Do not weaken the type to optional — a record always knows its faces, even when the list is empty.

- [ ] **Step 5: Run tests**

```bash
npx vitest run && npm run typecheck
```

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: carry face boxes through to PhotoRecord"
```

---

### Task 3: Thumbnails and a protocol to serve them

**Files:**
- Modify: `src/core/analyze.ts`, `src/main/orchestrator.ts`, `src/main/index.ts`
- Create: `src/main/thumbnails.ts`
- Test: `tests/main/thumbnails.test.ts`

**Interfaces:**
- `analyzePhoto(file, reader, detector, opts?: { onWorkingImage?: (img: WorkingImage) => Promise<void> })` — a hook so callers can use the decoded pixels without `core` learning about the filesystem.
- `writeThumbnail(img: WorkingImage, dest: string): Promise<void>` and `THUMB_LONG_EDGE = 400` from `src/main/thumbnails.ts`.
- `thumbPathFor(runDir: string, id: PhotoId): string` — a flat, collision-free filename derived from a hash of the id.
- `registerThumbProtocol(): void` — serves `triage-thumb://<runId>/<hash>.jpg`.

Thumbnails are written from the already-decoded working image, so no photo is decoded twice. A custom protocol is used rather than `file://` URLs because the renderer runs under a strict CSP and should not be handed arbitrary filesystem access.

- [ ] **Step 1: Write the failing test**

Create `tests/main/thumbnails.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { writeThumbnail, thumbPathFor, THUMB_LONG_EDGE } from '../../src/main/thumbnails.ts';

const img = (w: number, h: number) => ({
  width: w, height: h, data: new Uint8ClampedArray(w * h * 4).fill(200),
});

describe('writeThumbnail', () => {
  it('writes a JPEG no larger than the long edge', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'thumb-'));
    const dest = join(dir, 'a.jpg');
    await writeThumbnail(img(1600, 1200), dest);
    const meta = await sharp(await readFile(dest)).metadata();
    expect(meta.format).toBe('jpeg');
    expect(Math.max(meta.width!, meta.height!)).toBe(THUMB_LONG_EDGE);
  });

  it('does not enlarge an image smaller than the long edge', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'thumb-'));
    const dest = join(dir, 'b.jpg');
    await writeThumbnail(img(100, 80), dest);
    const meta = await sharp(await readFile(dest)).metadata();
    expect(meta.width).toBe(100);
  });
});

describe('thumbPathFor', () => {
  it('flattens nested ids into a single safe filename', () => {
    const p = thumbPathFor('/runs/r1', join('sub', 'deep', 'photo.jpg'));
    expect(p.startsWith(join('/runs/r1'))).toBe(true);
    expect(p.endsWith('.jpg')).toBe(true);
    expect(p.slice('/runs/r1'.length + 1)).not.toContain('/');
  });

  it('gives different ids different paths', () => {
    expect(thumbPathFor('/r', 'a.jpg')).not.toBe(thumbPathFor('/r', 'b.jpg'));
  });

  it('is stable for the same id', () => {
    expect(thumbPathFor('/r', 'a.jpg')).toBe(thumbPathFor('/r', 'a.jpg'));
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run tests/main/thumbnails.test.ts
```

- [ ] **Step 3: Implement `src/main/thumbnails.ts`**

```ts
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { WorkingImage, PhotoId } from '../core/types.ts';

export const THUMB_LONG_EDGE = 400;

export async function writeThumbnail(img: WorkingImage, dest: string): Promise<void> {
  const buf = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength);
  const out = await sharp(buf, { raw: { width: img.width, height: img.height, channels: 4 } })
    .resize({
      width: THUMB_LONG_EDGE, height: THUMB_LONG_EDGE,
      fit: 'inside', withoutEnlargement: true,
    })
    .jpeg({ quality: 78 })
    .toBuffer();
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, out);
}

/**
 * Flat filename derived from a hash of the id. Photo ids are relative paths and
 * may contain separators, so mirroring them would recreate the source tree in
 * the cache and risk collisions with '..' segments.
 */
export function thumbPathFor(runDir: string, id: PhotoId): string {
  return join(runDir, `${createHash('sha256').update(id).digest('hex').slice(0, 32)}.jpg`);
}
```

- [ ] **Step 4: Add the hook to `analyzePhoto`**

In `src/core/analyze.ts`, add a fourth parameter and call it after decoding:

```ts
export async function analyzePhoto(
  file: ScannedFile,
  reader: MetadataReader,
  detector: FaceDetector,
  opts: { onWorkingImage?: (img: WorkingImage) => Promise<void> } = {},
): Promise<PhotoRecord> {
```

and after `const gray = toGray(img);`:

```ts
  // Lets the caller reuse the decoded pixels — for a thumbnail, say — without
  // core needing to know anything about the filesystem.
  await opts.onWorkingImage?.(img);
```

Thread the same option through `analyzeAll`.

- [ ] **Step 5: Register the protocol in `src/main/index.ts`**

Before `app.whenReady()`:

```ts
import { protocol, net } from 'electron';
import { pathToFileURL } from 'node:url';

protocol.registerSchemesAsPrivileged([
  { scheme: 'triage-thumb', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);
```

Inside `whenReady`, before creating windows:

```ts
// Thumbnails are served from the run cache over a dedicated scheme rather than
// file:// URLs, so the renderer never gets general filesystem read access.
protocol.handle('triage-thumb', (request) => {
  const url = new URL(request.url);
  const file = join(thumbRoot(), url.hostname, url.pathname.replace(/^\//, ''));
  // Refuse anything that escapes the cache directory.
  if (!file.startsWith(thumbRoot())) return new Response('forbidden', { status: 403 });
  return net.fetch(pathToFileURL(file).toString());
});
```

with

```ts
function thumbRoot(): string {
  return join(app.getPath('userData'), 'thumbs');
}
export { thumbRoot };
```

- [ ] **Step 6: Run tests**

```bash
npx vitest run && npm run typecheck
```

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat: generate thumbnails and serve them over a custom protocol"
```

---

### Task 4: Split the run into analyse and apply

**Files:**
- Modify: `src/main/orchestrator.ts`, `src/main/ipc.ts`, `src/shared/contract.ts`, `src/main/index.ts`
- Test: `tests/main/orchestrator.test.ts` (rewrite)

**Interfaces:**
- `analyzeRun(opts): Promise<AnalysisResult>` where `AnalysisResult = { runId: string; records: PhotoRecord[]; unreadable: ScannedFile[]; groups: BurstGroup[]; cancelled: boolean }`
- `applyDecisions(opts: { runId, files, decisions, staging, review, onProgress? }): Promise<ApplyResult>` where `ApplyResult = { manifestPath: string; reportDir: string; copied: number; skipped: number }`
- `runTriage` is **removed**. Its only caller was the IPC handler and the smoke path; both move to the two-step flow.
- Contract gains `startAnalysis(cfg)`, `applyDecisions(payload)`, and `thumbUrl(runId, id)`.

This is the change that makes the Apply gate real: analysis no longer has the authority to write anything.

- [ ] **Step 1: Rewrite the orchestrator test**

Replace `tests/main/orchestrator.test.ts` with tests for the two functions. Key cases, all against a temp folder seeded with `sharp.png`, `blurry.png`, `corrupt.jpg`:

```ts
describe('analyzeRun', () => {
  it('returns records and unreadable files without writing anything', async () => {
    const r = await analyzeRun(base());
    expect(r.records).toHaveLength(2);
    expect(r.unreadable).toHaveLength(1);
    await expect(access(staging)).rejects.toThrow();
    await expect(access(review)).rejects.toThrow();
  });

  it('reports burst groups', async () => {
    const r = await analyzeRun(base());
    expect(Array.isArray(r.groups)).toBe(true);
  });

  it('stops early when aborted', async () => {
    const ac = new AbortController();
    const r = await analyzeRun({ ...base(), signal: ac.signal, onProgress: () => ac.abort() });
    expect(r.cancelled).toBe(true);
  });

  it('writes a thumbnail for every readable photo', async () => {
    const r = await analyzeRun(base());
    for (const rec of r.records) {
      await access(thumbPathFor(join(thumbDir, r.runId), rec.file.relPath));
    }
  });
});

describe('applyDecisions', () => {
  it('copies according to the decisions it is given, not the computed ones', async () => {
    const a = await analyzeRun(base());
    // Force the blurred photo to be a keeper — this is what an override does.
    const decisions = a.records.map((rec) => ({
      id: rec.file.relPath, verdict: 'good' as const,
      reasons: [], groupId: null, isGroupKeeper: true,
    }));
    await applyDecisions({ runId: a.runId, files: [...a.records.map(r => r.file), ...a.unreadable], decisions, staging, review });
    await access(join(staging, 'blurry.png'));
  });

  it('writes manifest and reports', async () => { /* assert manifest.json, report.csv, report.html */ });

  it('leaves the source untouched', async () => { /* readdir before/after */ });
});
```

- [ ] **Step 2: Run to verify it fails**

Expected: FAIL — `analyzeRun` and `applyDecisions` do not exist.

- [ ] **Step 3: Rewrite `src/main/orchestrator.ts`**

Split the existing body at the point where it used to call `buildPlan`. `analyzeRun` keeps scanning, analysis, clustering and thumbnail writing, and returns. `applyDecisions` takes the decisions it is given verbatim — it must not recompute them, because the user may have overridden them — then does the free-space check, `executePlan`, and report writing.

Generate `runId` in `analyzeRun` with `makeRunId`-style formatting and thread it through, so thumbnails and the manifest share a directory name.

- [ ] **Step 4: Update the IPC layer**

`startAnalysis` returns the analysis result. Records cross IPC as structured-cloneable plain objects — they already are. `applyDecisions` is a second handler. Keep the single long-lived `IpcFaceDetector`.

Add to the contract:

```ts
export interface AnalysisPayload {
  runId: string;
  records: PhotoRecord[];
  unreadable: ScannedFile[];
  groups: BurstGroup[];
  cancelled: boolean;
}
export function thumbUrl(runId: string, id: PhotoId): string;
```

`thumbUrl` mirrors `thumbPathFor`'s hash so the renderer can build the URL without another IPC call. Put the shared hashing in `src/shared/thumbId.ts` and have `thumbPathFor` use it, so the two cannot drift.

- [ ] **Step 5: Update the smoke path in `src/main/index.ts`**

Replace the `runTriage` call with `analyzeRun` followed by `applyDecisions` using the computed decisions, and keep the same `SMOKE_OK ... run=` output so the existing assertions hold.

- [ ] **Step 6: Run tests**

```bash
npx vitest run && npm run typecheck
```

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat: split analysis from apply so nothing is written before review"
```

---

### Task 5: The review state model

**Files:**
- Create: `src/renderer/review/model.ts`
- Test: `tests/renderer/review-model.test.ts`

**Interfaces:**
- `buildReviewState(payload: AnalysisPayload, thresholds: Thresholds): ReviewState`
- `recompute(state, thresholds): ReviewState` — re-clusters and re-decides; **pure**
- `applyOverride(state, id, verdict): ReviewState`
- `clearOverride(state, id): ReviewState`
- `effectiveDecisions(state): Decision[]` — computed decisions with overrides applied
- `counts(state): { good: number; rejected: number; unreadable: number; overridden: number }`
- `ReviewState = { payload; thresholds; overrides: Map<PhotoId, Verdict>; decisions: Decision[] }`

All the interesting logic lives here as pure functions, which is what makes it testable without a DOM. The components become thin.

- [ ] **Step 1: Write the failing test**

Cases to cover in `tests/renderer/review-model.test.ts`, built from hand-made `PhotoRecord`s:

- `recompute` with a lower blur threshold moves a photo from rejected to good
- `recompute` preserves existing overrides
- changing `burstHammingMax` re-clusters (proves cluster runs in the renderer)
- `applyOverride` flips a verdict and `effectiveDecisions` reflects it
- an overridden photo keeps its original reasons, so the UI can still show why it *was* flagged
- `clearOverride` restores the computed verdict
- `counts` counts overrides separately
- unreadable photos are never overridable — `applyOverride` on one is a no-op
- `recompute` is pure: calling it twice with the same thresholds gives equal output and does not mutate the input state

- [ ] **Step 2: Run to verify it fails**

- [ ] **Step 3: Implement the model**

```ts
import { decideAll } from '../../core/verdict.ts';
import { clusterBursts } from '../../core/cluster.ts';
// Both are pure and Node-free — see the architecture test.
```

`recompute` calls `clusterBursts` then `decideAll`, then reapplies overrides. Overrides are kept separate from decisions so that a slider change never silently discards a user's manual choice.

- [ ] **Step 4: Run tests, then commit**

```bash
npx vitest run && npm run typecheck
git add -A && git commit -m "feat: add pure review state model with live re-filtering"
```

---

### Task 6: The review grid

**Files:**
- Modify: `package.json` (add jsdom, @testing-library/react), `vitest.config.ts`
- Create: `src/renderer/screens/Review.tsx`, `src/renderer/review/PhotoCard.tsx`, `src/renderer/review/ReasonChip.tsx`, `src/renderer/review/Thresholds.tsx`
- Modify: `src/renderer/App.tsx`, `src/renderer/styles.css`
- Test: `tests/renderer/review-grid.test.tsx`

**Interfaces:**
- `Review({ payload, onApply, onCancel })`

- [ ] **Step 1: Add the DOM test environment**

```bash
npm i -D jsdom@^30.0.1 @testing-library/react@^16.3.2
```

In `vitest.config.ts`, set `environment: 'node'` as the default and override per-file with a docblock, or simpler: add `environmentMatchGlobs` is removed in Vitest 4 — instead add `test.projects` or put `// @vitest-environment jsdom` at the top of the component test file. Use the docblock; it keeps the fast node environment everywhere else.

- [ ] **Step 2: Write the failing test**

`tests/renderer/review-grid.test.tsx`, starting with `// @vitest-environment jsdom`:

- renders one card per photo
- a rejected card shows a chip with the reason text, including the score
- dragging the blur slider moves a photo between sections without any IPC call (assert `window.triage.startAnalysis` was never called)
- clicking Keep on a rejected card moves it to the keepers section
- the Apply button reports the current counts
- the Apply button passes the *effective* decisions, including overrides, to `onApply`
- a burst group renders as one stack showing the number of frames

Stub `window.triage` with vi.fn()s in the test setup.

- [ ] **Step 3: Implement the components**

`ReasonChip` renders `reason.detail` verbatim — it is already written for humans by `verdict.ts`, and duplicating that formatting in the UI would let the two drift.

`PhotoCard` shows the thumbnail via `thumbUrl(runId, id)`, the filename, chips for each reason, and Keep/Reject buttons. An overridden card is visibly marked so the user can see their own edits.

`Thresholds` renders sliders bound to the numeric fields of `Thresholds`, calling `recompute` on change. Debouncing is not needed — recompute is pure arithmetic over already-computed scores.

`Review` composes them, holds the `ReviewState`, and renders Keepers and Rejected sections with counts.

- [ ] **Step 4: Run tests, then commit**

```bash
npx vitest run && npm run typecheck
git add -A && git commit -m "feat: add review grid with live thresholds and overrides"
```

---

### Task 7: Zoom view with face crops

**Files:**
- Create: `src/renderer/review/ZoomView.tsx`
- Modify: `src/renderer/screens/Review.tsx`, `src/renderer/styles.css`
- Test: `tests/renderer/zoom.test.tsx`

**Interfaces:**
- `ZoomView({ record, runId, onClose, onKeep, onReject })`
- `faceCropStyle(box: FaceBox, containerPx: number): CSSProperties` — pure, and the only part worth testing

This is the feature that makes an "eyes closed" verdict checkable rather than something to be taken on faith. It is the direct answer to "did it really see a blink?".

- [ ] **Step 1: Write the failing test for the crop maths**

- a centred box produces a background position that centres that region
- a larger box produces less zoom than a small one
- a box at the image edge does not produce a negative offset that would show empty space
- zero-width boxes are handled without dividing by zero

- [ ] **Step 2: Implement**

`ZoomView` shows the full thumbnail large, plus one crop per detected face rendered by scaling and offsetting the same image with CSS `background-position` and `background-size`. Each crop is captioned with that face's eye score and confidence, so a low-confidence call is visible as such.

Escape closes; the existing Keep/Reject actions are available without leaving the view.

- [ ] **Step 3: Run tests, then commit**

```bash
npx vitest run && npm run typecheck
git add -A && git commit -m "feat: add zoom view with per-face crops for verifying eye calls"
```

---

### Task 8: Wire the Apply gate end to end

**Files:**
- Modify: `src/renderer/App.tsx`, `src/main/index.ts`, `README.md`
- Test: `tests/integration/app-boot.test.ts` (extend)

- [ ] **Step 1: Wire the flow**

`App` becomes: Setup → Progress → **Review** → Applying → Done. The dry-run checkbox is removed from Setup: with a review gate, every run is effectively a dry run until Apply is pressed. Say so on the Setup screen.

- [ ] **Step 2: Extend the smoke assertion**

The smoke path already runs analyse-then-apply. Add an assertion that after `analyzeRun` and before `applyDecisions`, the staging directory does not exist — the guarantee this whole plan exists to provide, checked by a machine rather than by reading the code.

- [ ] **Step 3: Update the README**

Describe the review screen. Remove the "sorts as soon as analysis finishes" caveat and the dry-run advice, both of which become untrue.

- [ ] **Step 4: Verify by hand**

```bash
npm run dev
```

Run a real folder through. Confirm the sliders re-filter instantly, an override survives a slider change, and the output folders do not exist until Apply is pressed.

- [ ] **Step 5: Run everything, then commit**

```bash
npx vitest run && npm run typecheck
git add -A && git commit -m "feat: wire the Apply gate end to end"
```

---

## Self-Review

**Spec coverage:** thumbnail grid split by verdict (T6), reason chips with scores (T6), live threshold sliders re-filtering instantly (T5, T6), per-photo overrides (T5, T6), burst stacks (T6), zoom with 100% face crops (T7), and the Apply gate with nothing written beforehand (T4, T8).

**The load-bearing decision** is Task 1. Live re-filtering only works because `verdict.ts` and `cluster.ts` can run in the renderer, and they can only do that once `hammingDistance` stops dragging `sharp` in behind it. The architecture test added there is what keeps it true — a future import of `sharp` into `cluster.ts` would not fail the build, it would just quietly move re-filtering back onto IPC and make the sliders laggy.

**Deferred:** keyboard navigation beyond arrows and G/R, and the score cache — both to the packaging plan.

**Known risk:** Vitest 4 removed `environmentMatchGlobs`, so the jsdom environment is selected with a per-file `// @vitest-environment jsdom` docblock. If that proves unreliable, switch to `test.projects` with separate node and jsdom projects rather than making the whole suite jsdom, which would slow every core test.
