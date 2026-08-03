# Photo Triage Desktop Shell & Eye Detection — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Phase 1 engine into a runnable desktop application with working eye detection — a window where you pick folders, watch progress, cancel, and get sorted output.

**Architecture:** Electron with three processes. The main process owns file I/O and orchestration and reuses `src/core/` unchanged. A visible renderer shows the Setup and Progress screens. A *hidden* renderer runs MediaPipe's `FaceLandmarker`, because MediaPipe requires a real DOM — verified: it throws `document is not defined` under plain Node. The main process talks to it over IPC and exposes it to `core` as the existing `FaceDetector` interface, so nothing in `core/` changes.

**Tech Stack:** Electron 43, electron-vite 5, React 19, Vite 8, `@mediapipe/tasks-vision` 1.0.1, plus the Phase 1 stack.

**Source spec:** `docs/superpowers/specs/2026-08-03-photo-triage-design.md`
**Predecessor:** `docs/superpowers/plans/2026-08-03-photo-triage-core-engine.md` (complete, merged)

## Scope

Phase 2 is three plans. This is the first.

| Plan | Delivers |
|---|---|
| **This one** | Desktop shell, Setup and Progress screens, orchestration, cancellation, and eye detection. Sorting happens immediately on completion. |
| Next | Review screen — thumbnail grid, reason chips, zoom with face crops, live threshold sliders, per-photo overrides, burst stacks, keyboard navigation, and the Apply gate that defers all writing until the user confirms. |
| After that | Packaging: electron-builder, CI matrix, installers, score cache, release workflow. |

Splitting here because each produces working software on its own, and because the review screen is large enough to deserve undivided attention.

**Deliberately deferred to the review plan:** the spec requires that nothing is written to disk until the user presses Apply. This plan writes immediately once analysis finishes, because there is no review screen yet to gate it. The Setup screen therefore states plainly that sorting is immediate, and the existing `--dry-run` equivalent is offered as a checkbox.

## Global Constraints

- `src/core/` stays free of Electron imports. The Task 1 architecture test already enforces this and must keep passing.
- The face detector is injected into `core` through the existing `FaceDetector` interface. No `core` file is modified to accommodate Electron.
- **The source folder remains read-only.** Copy only.
- Score direction stays "higher is better"; eye scores are 0–1 where 1 is fully open.
- MediaPipe assets resolve from local paths only. No CDN at runtime, ever — the app must work offline.
- The face model is downloaded by a pinned, checksum-verified script and is **not** committed.
- Existing tests must keep passing: `npm test` and `npm run typecheck` are green at the end of every task.
- Commit after every task.

---

### Task 1: Electron scaffold that boots

**Files:**
- Modify: `package.json`, `tsconfig.json`, `.gitignore`
- Create: `electron.vite.config.ts`
- Create: `src/main/index.ts`, `src/preload/index.ts`
- Create: `src/renderer/index.html`, `src/renderer/main.tsx`, `src/renderer/App.tsx`
- Test: `tests/integration/app-boot.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `createMainWindow(): BrowserWindow` from `src/main/index.ts`; the app honours `PHOTO_TRIAGE_SMOKE=1` by booting, verifying its windows, printing `SMOKE_OK`, and exiting 0.

The smoke test exists because Phase 1 taught us that a bug can pass every unit test and still break the moment real Node loads the code. An Electron app has three more loaders to get wrong.

- [ ] **Step 1: Install dependencies**

```bash
npm i -D electron@43.2.0 electron-vite@5.0.0 vite@^8.2.0 @vitejs/plugin-react@^6.0.5 @types/react@^19.2.18 @types/react-dom@^19.2.0
npm i react@^19.2.8 react-dom@^19.2.8
```

- [ ] **Step 2: Add scripts and Electron entry point to `package.json`**

Set `"main": "out/main/index.js"` at the top level, and add to `scripts`:

```json
"dev": "electron-vite dev",
"build:app": "electron-vite build",
"start": "electron-vite preview",
"smoke": "electron-vite build && PHOTO_TRIAGE_SMOKE=1 electron ."
```

Keep `type: "module"`. Keep every existing script unchanged.

- [ ] **Step 3: Create `electron.vite.config.ts`**

```ts
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  // sharp and exiftool-vendored carry native binaries and must never be
  // bundled — externalizeDepsPlugin leaves them as runtime requires.
  main: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: resolve('src/main/index.ts') } },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: resolve('src/preload/index.ts') } },
  },
  renderer: {
    plugins: [react()],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          faceWorker: resolve('src/face-worker/index.html'),
        },
      },
    },
  },
});
```

`src/face-worker/index.html` does not exist yet; create a placeholder now so the build resolves:

```bash
mkdir -p src/face-worker
printf '<!doctype html><meta charset="utf-8"><title>face worker</title>\n' > src/face-worker/index.html
```

- [ ] **Step 4: Create `src/main/index.ts`**

```ts
import { app, BrowserWindow } from 'electron';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = dirname(fileURLToPath(import.meta.url));
const SMOKE = process.env.PHOTO_TRIAGE_SMOKE === '1';

let mainWindow: BrowserWindow | null = null;

export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    show: !SMOKE,
    title: 'Photo Triage',
    webPreferences: {
      preload: join(DIR, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void win.loadFile(join(DIR, '../renderer/index.html'));
  }
  return win;
}

void app.whenReady().then(async () => {
  mainWindow = createMainWindow();

  if (SMOKE) {
    await new Promise<void>((r) => mainWindow!.webContents.once('did-finish-load', () => r()));
    const title = await mainWindow!.webContents.executeJavaScript('document.title');
    if (typeof title !== 'string') throw new Error('renderer did not load');
    console.log('SMOKE_OK');
    app.exit(0);
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) mainWindow = createMainWindow();
});
```

- [ ] **Step 5: Create `src/preload/index.ts`**

```ts
import { contextBridge } from 'electron';

// Expanded in Task 6. contextIsolation is on, so the renderer only ever sees
// what is explicitly bridged here — never Node itself.
contextBridge.exposeInMainWorld('api', {
  version: process.versions.electron,
});
```

- [ ] **Step 6: Create the renderer**

`src/renderer/index.html`:

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy"
          content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: file:" />
    <title>Photo Triage</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./main.tsx"></script>
  </body>
</html>
```

`src/renderer/main.tsx`:

```tsx
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';

createRoot(document.getElementById('root')!).render(<App />);
```

`src/renderer/App.tsx`:

```tsx
export function App() {
  return <main style={{ font: '14px system-ui', padding: '2rem' }}>
    <h1>Photo Triage</h1>
    <p>Setup screen arrives in Task 7.</p>
  </main>;
}
```

- [ ] **Step 7: Update `tsconfig.json` and `.gitignore`**

Add `"jsx": "react-jsx"` to `compilerOptions`. Add to `.gitignore`:

```
out/
```

- [ ] **Step 8: Write the smoke test**

Create `tests/integration/app-boot.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('electron app', () => {
  it('boots, loads the renderer and exits cleanly', async () => {
    const { stdout } = await run('npm', ['run', 'smoke'], {
      cwd: ROOT,
      env: { ...process.env, ELECTRON_DISABLE_SANDBOX: '1' },
      timeout: 120_000,
    });
    expect(stdout).toContain('SMOKE_OK');
  }, 180_000);
});
```

- [ ] **Step 9: Run everything**

```bash
npm run smoke
npm test
npm run typecheck
```

Expected: `SMOKE_OK` printed; all previous tests still pass plus the new one.

If Electron cannot launch in this environment (no display), run `npm run dev` manually and confirm a window appears. Do not weaken the test to make it pass — record the limitation and move on.

- [ ] **Step 10: Commit**

```bash
git add -A && git commit -m "feat: add Electron shell that boots and loads a renderer"
```

---

### Task 2: Fetch and resolve MediaPipe assets

**Files:**
- Create: `scripts/fetch-model.mjs`
- Create: `src/main/assets.ts`
- Modify: `package.json`, `.gitignore`
- Test: `tests/main/assets.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `resolveModelPath(): string` and `resolveWasmDir(): string` from `src/main/assets.ts`, both returning absolute paths that work in development and when packaged.
  - `MODEL_SHA256: string`

- [ ] **Step 1: Write the fetch script**

Create `scripts/fetch-model.mjs`. The URL is version-pinned and the download is checksum-verified, so a changed or corrupted upstream file fails loudly instead of silently degrading detection.

```js
import { createHash } from 'node:crypto';
import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEST = join(ROOT, 'assets', 'models', 'face_landmarker.task');

const URL_ = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
const SHA256 = '64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff';

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

async function main() {
  try {
    await access(DEST);
    const existing = await readFile(DEST);
    if (sha(existing) === SHA256) {
      console.log('face_landmarker.task already present and verified.');
      return;
    }
    console.log('Existing model failed checksum; re-downloading.');
  } catch {
    // not present yet
  }

  console.log(`Downloading ${URL_}`);
  const res = await fetch(URL_);
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());

  const actual = sha(buf);
  if (actual !== SHA256) {
    throw new Error(`Checksum mismatch.\n  expected ${SHA256}\n  actual   ${actual}`);
  }

  await mkdir(dirname(DEST), { recursive: true });
  await writeFile(DEST, buf);
  console.log(`Wrote ${DEST} (${buf.length} bytes, checksum verified).`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
```

- [ ] **Step 2: Wire it into `package.json`**

Add to `scripts`:

```json
"fetch-model": "node scripts/fetch-model.mjs",
"postinstall": "node scripts/fetch-model.mjs"
```

Add to `.gitignore`:

```
assets/models/
```

- [ ] **Step 3: Run it**

```bash
npm run fetch-model
```

Expected: `Wrote .../face_landmarker.task (3758596 bytes, checksum verified).`

- [ ] **Step 4: Write the failing test**

Create `tests/main/assets.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolveModelPath, resolveWasmDir, MODEL_SHA256 } from '../../src/main/assets.ts';
import { access } from 'node:fs/promises';
import { join } from 'node:path';

describe('asset resolution', () => {
  it('resolves a model file that matches the pinned checksum', async () => {
    const buf = await readFile(resolveModelPath());
    expect(createHash('sha256').update(buf).digest('hex')).toBe(MODEL_SHA256);
  });

  it('resolves a wasm directory containing the MediaPipe runtime', async () => {
    await access(join(resolveWasmDir(), 'vision_wasm_internal.wasm'));
  });
});
```

- [ ] **Step 5: Run to verify it fails**

```bash
npx vitest run tests/main/assets.test.ts
```

Expected: FAIL — cannot resolve `src/main/assets.ts`.

- [ ] **Step 6: Implement `src/main/assets.ts`**

```ts
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MODEL_SHA256 =
  '64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff';

/**
 * Assets live in different places in development and when packaged, and this
 * module is imported both by the Electron main process and by plain Vitest —
 * so it must not import `electron`. Walking up from this file to the project
 * root works in every case; the packaged case is corrected in the packaging
 * plan when app.asar layout is settled.
 */
function projectRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/main -> src -> root, or out/main -> out -> root
  return join(here, '..', '..');
}

export function resolveModelPath(): string {
  return join(projectRoot(), 'assets', 'models', 'face_landmarker.task');
}

export function resolveWasmDir(): string {
  return join(projectRoot(), 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
}
```

- [ ] **Step 7: Run tests**

```bash
npx vitest run tests/main/assets.test.ts && npm run typecheck
```

Expected: 2 passing, no type errors.

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "feat: add checksum-verified model fetch and asset resolution"
```

---

### Task 3: Pure MediaPipe result mapping

**Files:**
- Create: `src/face-worker/mapping.ts`
- Test: `tests/face-worker/mapping.test.ts`

**Interfaces:**
- Consumes: `FaceResult`, `FaceBox` from `src/core/types.ts`.
- Produces:
  - `toFaceResults(mp: MpLikeResult): FaceResult[]`
  - `interface MpLikeResult { faceLandmarks: Array<Array<{ x: number; y: number }>>; faceBlendshapes?: Array<{ categories: Array<{ categoryName: string; score: number }> }> }`
  - `EAR_OPEN_RATIO: number`, `CONFIDENCE_DISAGREEMENT: number`

Doing this as a pure function is what makes eye detection testable at all. MediaPipe itself cannot run under Vitest, but its *output shape* is simple, so the interesting logic — turning landmarks and blendshapes into an eye-open score and a bounding box — is tested against hand-written fixtures with no browser anywhere.

- [ ] **Step 1: Write the failing test**

Create `tests/face-worker/mapping.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { toFaceResults, type MpLikeResult } from '../../src/face-worker/mapping.ts';

/** 478 landmarks, all at a default position, with the eye points overridable. */
function landmarks(overrides: Record<number, { x: number; y: number }> = {}) {
  const pts = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5 }));
  // A face spanning roughly 0.3-0.7 horizontally.
  pts[0] = { x: 0.3, y: 0.3 };
  pts[1] = { x: 0.7, y: 0.7 };
  for (const [i, p] of Object.entries(overrides)) pts[Number(i)] = p;
  return pts;
}

const blend = (left: number, right: number) => ({
  categories: [
    { categoryName: 'eyeBlinkLeft', score: left },
    { categoryName: 'eyeBlinkRight', score: right },
  ],
});

const result = (mp: Partial<MpLikeResult>): MpLikeResult => ({
  faceLandmarks: [landmarks()], ...mp,
} as MpLikeResult);

describe('toFaceResults', () => {
  it('returns nothing when no face was found', () => {
    expect(toFaceResults({ faceLandmarks: [] })).toEqual([]);
  });

  it('reports eyes open when blink scores are low', () => {
    const [f] = toFaceResults(result({ faceBlendshapes: [blend(0.02, 0.03)] }));
    expect(f!.eyeOpenScore).toBeGreaterThan(0.9);
  });

  it('reports eyes closed when blink scores are high', () => {
    const [f] = toFaceResults(result({ faceBlendshapes: [blend(0.95, 0.93)] }));
    expect(f!.eyeOpenScore).toBeLessThan(0.1);
  });

  it('takes the worst of the two eyes — a one-eyed blink still counts', () => {
    const [f] = toFaceResults(result({ faceBlendshapes: [blend(0.9, 0.01)] }));
    expect(f!.eyeOpenScore).toBeLessThan(0.2);
  });

  it('derives a normalised bounding box from the landmark extents', () => {
    const [f] = toFaceResults(result({ faceBlendshapes: [blend(0.1, 0.1)] }));
    expect(f!.box.x).toBeCloseTo(0.3, 1);
    expect(f!.box.width).toBeCloseTo(0.4, 1);
    expect(f!.box.width).toBeGreaterThan(0);
  });

  it('falls back to eye-aspect-ratio when blendshapes are absent', () => {
    // Eyelids far apart -> open.
    const open = toFaceResults({ faceLandmarks: [landmarks({
      33: { x: 0.40, y: 0.50 }, 133: { x: 0.46, y: 0.50 },
      159: { x: 0.43, y: 0.482 }, 145: { x: 0.43, y: 0.518 },
      362: { x: 0.54, y: 0.50 }, 263: { x: 0.60, y: 0.50 },
      386: { x: 0.57, y: 0.482 }, 374: { x: 0.57, y: 0.518 },
    })] });
    // Eyelids touching -> closed.
    const shut = toFaceResults({ faceLandmarks: [landmarks({
      33: { x: 0.40, y: 0.50 }, 133: { x: 0.46, y: 0.50 },
      159: { x: 0.43, y: 0.4995 }, 145: { x: 0.43, y: 0.5005 },
      362: { x: 0.54, y: 0.50 }, 263: { x: 0.60, y: 0.50 },
      386: { x: 0.57, y: 0.4995 }, 374: { x: 0.57, y: 0.5005 },
    })] });
    expect(open[0]!.eyeOpenScore).toBeGreaterThan(shut[0]!.eyeOpenScore + 0.4);
  });

  it('lowers confidence when the two measures disagree sharply', () => {
    // Blendshape says wide open; the landmarks say shut.
    const conflicted = toFaceResults({
      faceLandmarks: [landmarks({
        33: { x: 0.40, y: 0.50 }, 133: { x: 0.46, y: 0.50 },
        159: { x: 0.43, y: 0.4995 }, 145: { x: 0.43, y: 0.5005 },
        362: { x: 0.54, y: 0.50 }, 263: { x: 0.60, y: 0.50 },
        386: { x: 0.57, y: 0.4995 }, 374: { x: 0.57, y: 0.5005 },
      })],
      faceBlendshapes: [blend(0.01, 0.01)],
    });
    const agreed = toFaceResults(result({ faceBlendshapes: [blend(0.01, 0.01)] }));
    expect(conflicted[0]!.confidence).toBeLessThan(agreed[0]!.confidence);
  });

  it('maps every detected face', () => {
    expect(toFaceResults({
      faceLandmarks: [landmarks(), landmarks()],
      faceBlendshapes: [blend(0.1, 0.1), blend(0.9, 0.9)],
    })).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run tests/face-worker/mapping.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/face-worker/mapping.ts`**

```ts
import type { FaceResult } from '../core/types.ts';

export interface MpPoint { x: number; y: number }
export interface MpBlendshapes {
  categories: Array<{ categoryName: string; score: number }>;
}
export interface MpLikeResult {
  faceLandmarks: MpPoint[][];
  faceBlendshapes?: MpBlendshapes[];
}

/** CALIBRATION. Eye-aspect ratio at which an eye counts as fully open. */
export const EAR_OPEN_RATIO = 0.28;
/** Disagreement between the two measures above which confidence is reduced. */
export const CONFIDENCE_DISAGREEMENT = 0.4;

// Canonical MediaPipe face-mesh eyelid indices.
const LEFT = { outer: 33, inner: 133, upper: 159, lower: 145 };
const RIGHT = { outer: 362, inner: 263, upper: 386, lower: 374 };

function dist(a: MpPoint, b: MpPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Vertical eyelid separation over horizontal eye width. */
function eyeAspectRatio(pts: MpPoint[], idx: typeof LEFT): number | null {
  const outer = pts[idx.outer], inner = pts[idx.inner];
  const upper = pts[idx.upper], lower = pts[idx.lower];
  if (!outer || !inner || !upper || !lower) return null;
  const width = dist(outer, inner);
  if (width <= 0) return null;
  return dist(upper, lower) / width;
}

function score(v: number): number {
  return Math.max(0, Math.min(1, v));
}

export function toFaceResults(mp: MpLikeResult): FaceResult[] {
  return mp.faceLandmarks.map((pts, i) => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pts) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }

    // Landmark-derived openness, worst eye.
    const earL = eyeAspectRatio(pts, LEFT);
    const earR = eyeAspectRatio(pts, RIGHT);
    const ears = [earL, earR].filter((e): e is number => e !== null);
    const earOpen = ears.length
      ? score(Math.min(...ears) / EAR_OPEN_RATIO)
      : null;

    // Blendshape-derived openness, worst eye. This is the primary signal: the
    // blink blendshapes are purpose-built for exactly this question.
    const cats = mp.faceBlendshapes?.[i]?.categories ?? [];
    const blink = (name: string) => cats.find((c) => c.categoryName === name)?.score;
    const bl = blink('eyeBlinkLeft');
    const br = blink('eyeBlinkRight');
    const blendOpen = bl !== undefined || br !== undefined
      ? score(1 - Math.max(bl ?? 0, br ?? 0))
      : null;

    const eyeOpenScore = blendOpen ?? earOpen ?? 1;

    // The two measures are a cross-check, not a blend. Averaging them would
    // hide a disagreement; reporting lower confidence surfaces it to the user.
    let confidence = 0.9;
    if (blendOpen !== null && earOpen !== null
        && Math.abs(blendOpen - earOpen) > CONFIDENCE_DISAGREEMENT) {
      confidence = 0.45;
    }

    return {
      box: { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
      eyeOpenScore,
      confidence,
    };
  });
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/face-worker/mapping.test.ts && npm run typecheck
```

Expected: 8 passing.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: add pure MediaPipe result mapping with EAR cross-check"
```

---

### Task 4: The face worker window

**Files:**
- Modify: `src/face-worker/index.html`
- Create: `src/face-worker/worker.ts`
- Create: `src/main/faceClient.ts`
- Modify: `src/main/index.ts`
- Test: `tests/integration/face-detect.test.ts`

**Interfaces:**
- Consumes: `toFaceResults` (Task 3), `resolveModelPath`/`resolveWasmDir` (Task 2), `FaceDetector`/`WorkingImage`/`FaceResult` from core.
- Produces:
  - `class IpcFaceDetector implements FaceDetector` with `constructor(win: BrowserWindow)`, `detect(img)`, and `ready(): Promise<void>`.
  - `createFaceWindow(): BrowserWindow` exported from `src/main/index.ts`.
  - IPC channel names: `face:init`, `face:ready`, `face:detect`, `face:result`.
  - `FACE_DETECT_LONG_EDGE = 1024`

- [ ] **Step 1: Write the face worker HTML**

Replace `src/face-worker/index.html`:

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>face worker</title>
  </head>
  <body>
    <script type="module" src="./worker.ts"></script>
  </body>
</html>
```

- [ ] **Step 2: Write `src/face-worker/worker.ts`**

```ts
import { FilesetResolver, FaceLandmarker } from '@mediapipe/tasks-vision';
import { toFaceResults } from './mapping.ts';

// This window exists solely because MediaPipe requires a DOM: it throws
// "document is not defined" under plain Node, so the detector cannot live in
// the main process. Nothing is ever displayed here.
const api = (window as unknown as {
  faceWorker: {
    onInit(cb: (cfg: { modelPath: string; wasmDir: string; numFaces: number }) => void): void;
    onDetect(cb: (job: { id: number; width: number; height: number; data: Uint8ClampedArray }) => void): void;
    sendReady(error: string | null): void;
    sendResult(id: number, faces: unknown, error: string | null): void;
  };
}).faceWorker;

let landmarker: FaceLandmarker | null = null;

api.onInit(async (cfg) => {
  try {
    const fileset = await FilesetResolver.forVisionTasks(cfg.wasmDir);
    const modelBuffer = await fetch(`file://${cfg.modelPath}`).then((r) => r.arrayBuffer());
    landmarker = await FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetBuffer: new Uint8Array(modelBuffer), delegate: 'CPU' },
      runningMode: 'IMAGE',
      numFaces: cfg.numFaces,
      outputFaceBlendshapes: true,
    });
    api.sendReady(null);
  } catch (err) {
    api.sendReady(err instanceof Error ? err.message : String(err));
  }
});

api.onDetect((job) => {
  if (!landmarker) {
    api.sendResult(job.id, [], 'face landmarker not initialised');
    return;
  }
  try {
    const image = new ImageData(new Uint8ClampedArray(job.data), job.width, job.height);
    const raw = landmarker.detect(image);
    api.sendResult(job.id, toFaceResults(raw as never), null);
  } catch (err) {
    api.sendResult(job.id, [], err instanceof Error ? err.message : String(err));
  }
});
```

- [ ] **Step 3: Extend the preload**

Replace `src/preload/index.ts`:

```ts
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('api', {
  version: process.versions.electron,
});

// The face worker window loads the same preload; exposing this to the visible
// renderer as well is harmless because it only relays to the main process.
contextBridge.exposeInMainWorld('faceWorker', {
  onInit: (cb: (cfg: unknown) => void) =>
    ipcRenderer.on('face:init', (_e, cfg) => cb(cfg)),
  onDetect: (cb: (job: unknown) => void) =>
    ipcRenderer.on('face:detect', (_e, job) => cb(job)),
  sendReady: (error: string | null) => ipcRenderer.send('face:ready', error),
  sendResult: (id: number, faces: unknown, error: string | null) =>
    ipcRenderer.send('face:result', { id, faces, error }),
});
```

- [ ] **Step 4: Write `src/main/faceClient.ts`**

```ts
import { ipcMain, type BrowserWindow } from 'electron';
import sharp from 'sharp';
import type { FaceDetector, FaceResult, WorkingImage } from '../core/types.ts';
import { resolveModelPath, resolveWasmDir } from './assets.ts';

/**
 * Face detection runs on a downscale. Full 1600px frames would push ~7MB per
 * photo across IPC for no accuracy gain; 1024px still leaves a face at the 4%
 * significance threshold about 41 pixels wide, which the landmarker handles.
 */
export const FACE_DETECT_LONG_EDGE = 1024;
export const FACE_DETECT_TIMEOUT_MS = 30_000;
const NUM_FACES = 10;

interface Pending {
  resolve: (faces: FaceResult[]) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class IpcFaceDetector implements FaceDetector {
  private readonly win: BrowserWindow;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private readyPromise: Promise<void> | null = null;

  constructor(win: BrowserWindow) {
    this.win = win;

    ipcMain.on('face:result', (_e, msg: { id: number; faces: FaceResult[]; error: string | null }) => {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error));
      else p.resolve(msg.faces);
    });
  }

  ready(): Promise<void> {
    this.readyPromise ??= new Promise<void>((resolve, reject) => {
      ipcMain.once('face:ready', (_e, error: string | null) => {
        if (error) reject(new Error(`Face detector failed to start: ${error}`));
        else resolve();
      });
      this.win.webContents.send('face:init', {
        modelPath: resolveModelPath(),
        wasmDir: resolveWasmDir(),
        numFaces: NUM_FACES,
      });
    });
    return this.readyPromise;
  }

  async detect(img: WorkingImage): Promise<FaceResult[]> {
    await this.ready();

    const scale = FACE_DETECT_LONG_EDGE / Math.max(img.width, img.height);
    let payload = img;
    if (scale < 1) {
      const buf = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength);
      const { data, info } = await sharp(buf, {
        raw: { width: img.width, height: img.height, channels: 4 },
      })
        .resize({ width: Math.round(img.width * scale), height: Math.round(img.height * scale) })
        .raw()
        .toBuffer({ resolveWithObject: true });
      payload = { width: info.width, height: info.height, data: new Uint8ClampedArray(data) };
    }

    const id = this.nextId++;
    return new Promise<FaceResult[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Face detection timed out after ${FACE_DETECT_TIMEOUT_MS}ms`));
      }, FACE_DETECT_TIMEOUT_MS);

      this.pending.set(id, { resolve, reject, timer });
      this.win.webContents.send('face:detect', {
        id,
        width: payload.width,
        height: payload.height,
        data: payload.data,
      });
    });
  }
}
```

- [ ] **Step 5: Create the hidden window in `src/main/index.ts`**

Add alongside `createMainWindow`:

```ts
export function createFaceWindow(): BrowserWindow {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: join(DIR, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      offscreen: false,
    },
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/src/face-worker/index.html`);
  } else {
    void win.loadFile(join(DIR, '../renderer/src/face-worker/index.html'));
  }
  return win;
}
```

The packaged path depends on how electron-vite emits the second HTML entry. Run `npm run build:app` and inspect `out/renderer/` to confirm the exact filename, then correct the path above rather than guessing.

Extend the smoke block so it also proves detection works:

```ts
if (SMOKE) {
  await new Promise<void>((r) => mainWindow!.webContents.once('did-finish-load', () => r()));

  const faceWin = createFaceWindow();
  await new Promise<void>((r) => faceWin.webContents.once('did-finish-load', () => r()));
  const detector = new IpcFaceDetector(faceWin);
  await detector.ready();

  // A blank image has no faces. Getting an empty array back — rather than a
  // crash or a timeout — proves the whole IPC and MediaPipe path is live.
  const blank = { width: 64, height: 64, data: new Uint8ClampedArray(64 * 64 * 4).fill(128) };
  const faces = await detector.detect(blank);
  if (!Array.isArray(faces)) throw new Error('detector did not return an array');

  console.log(`SMOKE_OK faces=${faces.length}`);
  app.exit(0);
}
```

- [ ] **Step 6: Write the integration test**

Create `tests/integration/face-detect.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('face detection', () => {
  it('initialises MediaPipe in a hidden window and returns a result', async () => {
    const { stdout } = await run('npm', ['run', 'smoke'], {
      cwd: ROOT,
      env: { ...process.env, ELECTRON_DISABLE_SANDBOX: '1' },
      timeout: 180_000,
    });
    expect(stdout).toContain('SMOKE_OK faces=0');
  }, 240_000);
});
```

- [ ] **Step 7: Run it**

```bash
npm run smoke
```

Expected: `SMOKE_OK faces=0`.

If MediaPipe fails to initialise, read the error text from `face:ready` — it is propagated deliberately. The two likely causes are a wrong `wasmDir` and the `file://` fetch of the model being blocked; in the second case, read the model in the main process and send the bytes over `face:init` instead.

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "feat: add MediaPipe face worker window and IPC detector"
```

---

### Task 5: Run orchestration with progress and cancellation

**Files:**
- Create: `src/main/orchestrator.ts`
- Test: `tests/main/orchestrator.test.ts`

**Interfaces:**
- Consumes: everything in `src/core/`, plus `FaceDetector`.
- Produces:
  - `runTriage(opts: RunOptions): Promise<RunResult>`
  - `interface RunOptions { source: string; staging: string; review: string; preset: PresetName; recurse: boolean; dryRun: boolean; detector: FaceDetector; reader: MetadataReader; signal?: AbortSignal; onProgress?: (p: RunProgress) => void }`
  - `interface RunProgress { phase: 'scanning' | 'analysing' | 'copying'; done: number; total: number; current: string }`
  - `interface RunResult { summary: Summary; groups: number; unreadable: number; manifestPath: string | null; cancelled: boolean }`

Orchestration lives in its own module, not in `main/index.ts`, so it can be tested with a stub detector and no Electron at all.

- [ ] **Step 1: Write the failing test**

Create `tests/main/orchestrator.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtemp, mkdir, copyFile, access, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTriage } from '../../src/main/orchestrator.ts';
import { MetadataReader } from '../../src/core/metadata.ts';
import { NullFaceDetector, StubFaceDetector } from '../../src/core/scores/faces.ts';
import { FIXTURE_DIR } from '../fixtures/globalSetup.ts';

let src: string, staging: string, review: string;
const reader = new MetadataReader();
afterAll(() => reader.close());

beforeEach(async () => {
  const base = await mkdtemp(join(tmpdir(), 'orch-'));
  src = join(base, 'src'); staging = join(base, 'staging'); review = join(base, 'review');
  await mkdir(src, { recursive: true });
  for (const f of ['sharp.png', 'blurry.png', 'corrupt.jpg']) {
    await copyFile(join(FIXTURE_DIR, f), join(src, f));
  }
});

const base = () => ({
  source: src, staging, review,
  preset: 'event' as const, recurse: true, dryRun: false,
  detector: new NullFaceDetector(), reader,
});

describe('runTriage', () => {
  it('sorts a folder and reports a summary', async () => {
    const r = await runTriage(base());
    expect(r.summary.total).toBe(3);
    expect(r.unreadable).toBe(1);
    await access(join(staging, 'sharp.png'));
    await access(join(review, 'blurry.png'));
  });

  it('writes nothing in dry-run mode', async () => {
    const r = await runTriage({ ...base(), dryRun: true });
    expect(r.manifestPath).toBeNull();
    await expect(access(staging)).rejects.toThrow();
  });

  it('emits progress for each phase', async () => {
    const phases = new Set<string>();
    await runTriage({ ...base(), onProgress: (p) => phases.add(p.phase) });
    expect(phases.has('analysing')).toBe(true);
    expect(phases.has('copying')).toBe(true);
  });

  it('stops when the signal is aborted and copies nothing', async () => {
    const ac = new AbortController();
    const r = await runTriage({
      ...base(),
      signal: ac.signal,
      onProgress: (p) => { if (p.phase === 'analysing') ac.abort(); },
    });
    expect(r.cancelled).toBe(true);
    expect(r.manifestPath).toBeNull();
    await expect(access(staging)).rejects.toThrow();
  });

  it('uses the injected face detector', async () => {
    const detector = new StubFaceDetector([
      { box: { x: 0.2, y: 0.2, width: 0.4, height: 0.4 }, eyeOpenScore: 0.02, confidence: 0.9 },
    ]);
    const r = await runTriage({ ...base(), detector });
    // A closed-eye face on every photo means every readable photo is rejected.
    expect(r.summary.byReason['eyes-closed']).toBeGreaterThan(0);
  });

  it('leaves the source folder untouched', async () => {
    await runTriage(base());
    expect((await readdir(src)).sort()).toEqual(['blurry.png', 'corrupt.jpg', 'sharp.png']);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run tests/main/orchestrator.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/main/orchestrator.ts`**

```ts
import { scanDirectory } from '../core/scan.ts';
import { analyzePhoto } from '../core/analyze.ts';
import { clusterBursts } from '../core/cluster.ts';
import { decideAll } from '../core/verdict.ts';
import { PRESETS } from '../core/presets.ts';
import { buildPlan, executePlan, checkFreeSpace } from '../core/apply.ts';
import { summarize, type Summary } from '../core/report.ts';
import { UnreadableError } from '../core/decode.ts';
import type { MetadataReader } from '../core/metadata.ts';
import type { Decision, FaceDetector, PhotoRecord, PresetName, ScannedFile } from '../core/types.ts';

export interface RunProgress {
  phase: 'scanning' | 'analysing' | 'copying';
  done: number;
  total: number;
  current: string;
}

export interface RunOptions {
  source: string;
  staging: string;
  review: string;
  preset: PresetName;
  recurse: boolean;
  dryRun: boolean;
  detector: FaceDetector;
  reader: MetadataReader;
  signal?: AbortSignal;
  onProgress?: (p: RunProgress) => void;
}

export interface RunResult {
  summary: Summary;
  groups: number;
  unreadable: number;
  manifestPath: string | null;
  cancelled: boolean;
}

export async function runTriage(opts: RunOptions): Promise<RunResult> {
  const t = PRESETS[opts.preset];
  const cancelled = () => opts.signal?.aborted === true;

  opts.onProgress?.({ phase: 'scanning', done: 0, total: 0, current: opts.source });
  const scan = await scanDirectory(opts.source, { recurse: opts.recurse });

  const records: PhotoRecord[] = [];
  const unreadable: ScannedFile[] = [];

  for (const [i, file] of scan.images.entries()) {
    if (cancelled()) break;
    try {
      records.push(await analyzePhoto(file, opts.reader, opts.detector));
    } catch (err) {
      if (err instanceof UnreadableError) unreadable.push(file);
      else throw err;
    }
    opts.onProgress?.({
      phase: 'analysing', done: i + 1, total: scan.images.length, current: file.relPath,
    });
  }

  const groups = clusterBursts(records, t);
  const decisions: Decision[] = decideAll(records, t, groups);
  for (const f of unreadable) {
    decisions.push({ id: f.relPath, verdict: 'unreadable', reasons: [], groupId: null, isGroupKeeper: true });
  }
  const summary = summarize(decisions);

  // Cancelling must leave the destinations exactly as they were.
  if (cancelled() || opts.dryRun) {
    return {
      summary, groups: groups.length, unreadable: unreadable.length,
      manifestPath: null, cancelled: cancelled(),
    };
  }

  const plan = buildPlan(scan.images, decisions, { staging: opts.staging, review: opts.review });
  const space = await checkFreeSpace(plan);
  if (!space.ok) {
    throw new Error(
      `Not enough free space: need ${space.requiredBytes} bytes, ${space.availableBytes} available.`,
    );
  }

  const manifest = await executePlan(plan, (done, total) =>
    opts.onProgress?.({ phase: 'copying', done, total, current: '' }),
  );

  return {
    summary, groups: groups.length, unreadable: unreadable.length,
    manifestPath: manifest.manifestPath, cancelled: false,
  };
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/main/orchestrator.test.ts && npm run typecheck
```

Expected: 6 passing.

Note: the dry-run test asserts `staging` does not exist. `checkFreeSpace` creates it, so the dry-run branch must return *before* that call — it does. If the test fails, that ordering is what broke.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: add run orchestration with progress and cancellation"
```

---

### Task 6: IPC surface between renderer and main

**Files:**
- Modify: `src/preload/index.ts`, `src/main/index.ts`
- Create: `src/main/ipc.ts`, `src/shared/contract.ts`
- Test: `tests/main/contract.test.ts`

**Interfaces:**
- Produces:
  - `src/shared/contract.ts`: `interface TriageApi { pickFolder(kind): Promise<string | null>; startRun(cfg): Promise<RunResult>; cancelRun(): void; onProgress(cb): () => void }`, plus `RunConfig`.
  - `registerIpc(getWindows): void` in `src/main/ipc.ts`.

A single shared contract file typed on both sides means the renderer and main process cannot drift apart silently.

- [ ] **Step 1: Write `src/shared/contract.ts`**

```ts
import type { PresetName } from '../core/types.ts';
import type { RunProgress, RunResult } from '../main/orchestrator.ts';

export type FolderKind = 'source' | 'staging' | 'review';

export interface RunConfig {
  source: string;
  staging: string;
  review: string;
  preset: PresetName;
  recurse: boolean;
  dryRun: boolean;
}

export interface TriageApi {
  pickFolder(kind: FolderKind): Promise<string | null>;
  startRun(cfg: RunConfig): Promise<RunResult>;
  cancelRun(): void;
  /** Returns an unsubscribe function. */
  onProgress(cb: (p: RunProgress) => void): () => void;
}

export const CHANNELS = {
  pickFolder: 'triage:pickFolder',
  startRun: 'triage:startRun',
  cancelRun: 'triage:cancelRun',
  progress: 'triage:progress',
} as const;

declare global {
  interface Window { triage: TriageApi }
}
```

- [ ] **Step 2: Write the failing test**

Create `tests/main/contract.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { CHANNELS } from '../../src/shared/contract.ts';

describe('IPC contract', () => {
  it('namespaces every channel so they cannot collide with face worker channels', () => {
    for (const name of Object.values(CHANNELS)) {
      expect(name.startsWith('triage:')).toBe(true);
    }
  });

  it('exposes exactly the four channels the renderer needs', () => {
    expect(Object.keys(CHANNELS).sort()).toEqual(['cancelRun', 'pickFolder', 'progress', 'startRun']);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

```bash
npx vitest run tests/main/contract.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 4: Write `src/main/ipc.ts`**

```ts
import { ipcMain, dialog, type BrowserWindow } from 'electron';
import { CHANNELS, type RunConfig } from '../shared/contract.ts';
import { runTriage, type RunResult } from './orchestrator.ts';
import { MetadataReader } from '../core/metadata.ts';
import { IpcFaceDetector } from './faceClient.ts';

export function registerIpc(getWindows: () => { main: BrowserWindow; face: BrowserWindow }) {
  let controller: AbortController | null = null;

  ipcMain.handle(CHANNELS.pickFolder, async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(getWindows().main, {
      properties: ['openDirectory', 'createDirectory'],
    });
    return canceled ? null : filePaths[0] ?? null;
  });

  ipcMain.on(CHANNELS.cancelRun, () => controller?.abort());

  ipcMain.handle(CHANNELS.startRun, async (_e, cfg: RunConfig): Promise<RunResult> => {
    const { main, face } = getWindows();
    controller = new AbortController();
    const reader = new MetadataReader();
    try {
      return await runTriage({
        ...cfg,
        detector: new IpcFaceDetector(face),
        reader,
        signal: controller.signal,
        onProgress: (p) => {
          if (!main.isDestroyed()) main.webContents.send(CHANNELS.progress, p);
        },
      });
    } finally {
      // exiftool keeps a child process alive; failing to close it wedges quit.
      await reader.close();
      controller = null;
    }
  });
}
```

- [ ] **Step 5: Extend the preload**

Add to `src/preload/index.ts`:

```ts
import { CHANNELS } from '../shared/contract.ts';

contextBridge.exposeInMainWorld('triage', {
  pickFolder: (kind: string) => ipcRenderer.invoke(CHANNELS.pickFolder, kind),
  startRun: (cfg: unknown) => ipcRenderer.invoke(CHANNELS.startRun, cfg),
  cancelRun: () => ipcRenderer.send(CHANNELS.cancelRun),
  onProgress: (cb: (p: unknown) => void) => {
    const handler = (_e: unknown, p: unknown) => cb(p);
    ipcRenderer.on(CHANNELS.progress, handler);
    return () => { ipcRenderer.removeListener(CHANNELS.progress, handler); };
  },
});
```

- [ ] **Step 6: Wire it in `src/main/index.ts`**

Inside `app.whenReady()`, after both windows exist and before the smoke block:

```ts
const faceWindow = createFaceWindow();
registerIpc(() => ({ main: mainWindow!, face: faceWindow }));
```

- [ ] **Step 7: Run tests**

```bash
npx vitest run && npm run typecheck && npm run smoke
```

Expected: all tests pass, `SMOKE_OK faces=0` still printed.

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "feat: add typed IPC contract between renderer and main"
```

---

### Task 7: Setup and Progress screens

**Files:**
- Create: `src/renderer/screens/Setup.tsx`, `src/renderer/screens/Progress.tsx`, `src/renderer/screens/Done.tsx`
- Create: `src/renderer/styles.css`
- Modify: `src/renderer/App.tsx`
- Test: `tests/renderer/setup.test.tsx`

**Interfaces:**
- Consumes: `window.triage` from the contract.
- Produces: `App` renders `Setup` → `Progress` → `Done` based on run state.
- `canStart(cfg: Partial<RunConfig>): boolean` exported from `Setup.tsx` — pure, and the part worth testing.

Testing React components needs a DOM environment. Rather than add jsdom and Testing Library for two simple screens, the *validation logic* is extracted as a pure function and tested directly; the screens themselves are verified by running the app. This is a deliberate trade — revisit it in the review-screen plan, where the UI logic is complex enough to justify the tooling.

- [ ] **Step 1: Write the failing test**

Create `tests/renderer/setup.test.tsx`:

```ts
import { describe, it, expect } from 'vitest';
import { canStart } from '../../src/renderer/screens/Setup.tsx';

describe('canStart', () => {
  it('requires all three folders', () => {
    expect(canStart({ source: '/a', staging: '/b', review: '/c' })).toBe(true);
    expect(canStart({ source: '/a', staging: '/b' })).toBe(false);
    expect(canStart({})).toBe(false);
  });

  it('rejects a staging folder identical to the source', () => {
    expect(canStart({ source: '/a', staging: '/a', review: '/c' })).toBe(false);
  });

  it('rejects a review folder identical to the source', () => {
    expect(canStart({ source: '/a', staging: '/b', review: '/a' })).toBe(false);
  });

  it('rejects staging and review pointing at the same place', () => {
    expect(canStart({ source: '/a', staging: '/b', review: '/b' })).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run tests/renderer/setup.test.tsx
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/renderer/screens/Setup.tsx`**

```tsx
import { useState } from 'react';
import type { RunConfig, FolderKind } from '../../shared/contract.ts';
import type { PresetName } from '../../core/types.ts';

/**
 * Writing output into the source folder would break the guarantee that the
 * source is never modified, so identical paths are rejected outright.
 */
export function canStart(cfg: Partial<RunConfig>): boolean {
  const { source, staging, review } = cfg;
  if (!source || !staging || !review) return false;
  if (source === staging || source === review) return false;
  if (staging === review) return false;
  return true;
}

const PRESET_HELP: Record<PresetName, string> = {
  event: 'All checks at balanced thresholds.',
  portrait: 'Strict on faces and eyes, lenient on background blur.',
  landscape: 'Eye checks off. Blur and exposure strict.',
};

export function Setup({ onStart }: { onStart: (cfg: RunConfig) => void }) {
  const [cfg, setCfg] = useState<Partial<RunConfig>>({
    preset: 'event', recurse: true, dryRun: false,
  });

  const pick = async (kind: FolderKind) => {
    const dir = await window.triage.pickFolder(kind);
    if (dir) setCfg((c) => ({ ...c, [kind]: dir }));
  };

  const folder = (kind: FolderKind, label: string, hint: string) => (
    <div className="field" key={kind}>
      <label>{label}</label>
      <div className="row">
        <button onClick={() => void pick(kind)}>Choose…</button>
        <span className="path">{cfg[kind] ?? <em>not set</em>}</span>
      </div>
      <small>{hint}</small>
    </div>
  );

  return (
    <main>
      <h1>Photo Triage</h1>

      {folder('source', 'Photos to sort', 'Opened read-only. Never modified.')}
      {folder('staging', 'Keepers go here', 'Good photos are copied here.')}
      {folder('review', 'Rejects go here', 'Flagged photos are copied here for you to check.')}

      <div className="field">
        <label>Preset</label>
        <select
          value={cfg.preset}
          onChange={(e) => setCfg((c) => ({ ...c, preset: e.target.value as PresetName }))}
        >
          <option value="event">Event</option>
          <option value="portrait">Portrait</option>
          <option value="landscape">Landscape</option>
        </select>
        <small>{PRESET_HELP[cfg.preset ?? 'event']}</small>
      </div>

      <label className="check">
        <input
          type="checkbox"
          checked={cfg.recurse ?? true}
          onChange={(e) => setCfg((c) => ({ ...c, recurse: e.target.checked }))}
        />
        Include subfolders
      </label>

      <label className="check">
        <input
          type="checkbox"
          checked={cfg.dryRun ?? false}
          onChange={(e) => setCfg((c) => ({ ...c, dryRun: e.target.checked }))}
        />
        Dry run — analyse and report without copying anything
      </label>

      <p className="notice">
        Photos are sorted as soon as analysis finishes. The review screen, where
        you can change decisions before anything is written, arrives next.
      </p>

      <button
        className="primary"
        disabled={!canStart(cfg)}
        onClick={() => onStart(cfg as RunConfig)}
      >
        Sort photos
      </button>
    </main>
  );
}
```

- [ ] **Step 4: Implement `src/renderer/screens/Progress.tsx`**

```tsx
import { useEffect, useState } from 'react';
import type { RunProgress } from '../../main/orchestrator.ts';

const LABEL: Record<RunProgress['phase'], string> = {
  scanning: 'Scanning folder',
  analysing: 'Analysing photos',
  copying: 'Copying files',
};

export function Progress() {
  const [p, setP] = useState<RunProgress | null>(null);

  useEffect(() => window.triage.onProgress(setP), []);

  const pct = p && p.total > 0 ? Math.round((p.done / p.total) * 100) : 0;

  return (
    <main>
      <h1>{p ? LABEL[p.phase] : 'Starting…'}</h1>
      <div className="bar"><div className="bar-fill" style={{ width: `${pct}%` }} /></div>
      <p className="muted">
        {p && p.total > 0 ? `${p.done} of ${p.total}` : ''} {p?.current ?? ''}
      </p>
      <button onClick={() => window.triage.cancelRun()}>Cancel</button>
      <p className="notice">Cancelling is safe. Nothing is copied until analysis finishes.</p>
    </main>
  );
}
```

- [ ] **Step 5: Implement `src/renderer/screens/Done.tsx`**

```tsx
import type { RunResult } from '../../main/orchestrator.ts';

export function Done({ result, onAgain }: { result: RunResult; onAgain: () => void }) {
  const s = result.summary;
  return (
    <main>
      <h1>{result.cancelled ? 'Cancelled' : 'Finished'}</h1>
      <ul className="stats">
        <li><strong>{s.good}</strong> keepers</li>
        <li><strong>{s.rejected}</strong> flagged for review</li>
        <li><strong>{s.unreadable}</strong> unreadable</li>
        <li><strong>{result.groups}</strong> burst group(s)</li>
      </ul>
      {Object.entries(s.byReason).length > 0 && (
        <>
          <h2>Why photos were flagged</h2>
          <ul>{Object.entries(s.byReason).map(([k, v]) => <li key={k}>{k}: {v}</li>)}</ul>
        </>
      )}
      {result.manifestPath && <p className="muted">Manifest: {result.manifestPath}</p>}
      {result.cancelled && <p className="notice">Nothing was copied.</p>}
      <button className="primary" onClick={onAgain}>Sort another folder</button>
    </main>
  );
}
```

- [ ] **Step 6: Wire `src/renderer/App.tsx`**

```tsx
import { useState } from 'react';
import { Setup } from './screens/Setup.tsx';
import { Progress } from './screens/Progress.tsx';
import { Done } from './screens/Done.tsx';
import type { RunConfig } from '../shared/contract.ts';
import type { RunResult } from '../main/orchestrator.ts';
import './styles.css';

type State =
  | { name: 'setup' }
  | { name: 'running' }
  | { name: 'done'; result: RunResult }
  | { name: 'error'; message: string };

export function App() {
  const [state, setState] = useState<State>({ name: 'setup' });

  const start = async (cfg: RunConfig) => {
    setState({ name: 'running' });
    try {
      setState({ name: 'done', result: await window.triage.startRun(cfg) });
    } catch (err) {
      setState({ name: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  };

  if (state.name === 'running') return <Progress />;
  if (state.name === 'done') return <Done result={state.result} onAgain={() => setState({ name: 'setup' })} />;
  if (state.name === 'error') {
    return (
      <main>
        <h1>Something went wrong</h1>
        <pre className="error">{state.message}</pre>
        <button onClick={() => setState({ name: 'setup' })}>Back</button>
      </main>
    );
  }
  return <Setup onStart={(cfg) => void start(cfg)} />;
}
```

- [ ] **Step 7: Add `src/renderer/styles.css`**

```css
:root { color-scheme: light dark; }
body { margin: 0; font: 14px/1.5 system-ui, sans-serif; }
main { max-width: 640px; margin: 0 auto; padding: 2rem; }
h1 { font-size: 1.4rem; }
.field { margin: 1.25rem 0; }
.field label { display: block; font-weight: 600; margin-bottom: .35rem; }
.row { display: flex; gap: .6rem; align-items: center; }
.path { font-family: ui-monospace, monospace; font-size: .85rem; word-break: break-all; }
small { color: #666; }
.check { display: block; margin: .6rem 0; }
.notice { background: #f3f4f6; padding: .7rem .9rem; border-radius: 6px; font-size: .9rem; }
.error { background: #fff5f5; padding: .8rem; white-space: pre-wrap; }
button { padding: .45rem .9rem; font: inherit; cursor: pointer; }
button.primary { background: #2563eb; color: #fff; border: 0; border-radius: 6px; padding: .6rem 1.2rem; }
button.primary:disabled { background: #9ca3af; cursor: not-allowed; }
.bar { height: 10px; background: #e5e7eb; border-radius: 5px; overflow: hidden; }
.bar-fill { height: 100%; background: #2563eb; transition: width .2s; }
.muted { color: #666; font-size: .9rem; }
.stats { list-style: none; padding: 0; }
.stats li { padding: .2rem 0; }
@media (prefers-color-scheme: dark) {
  small, .muted { color: #9ca3af; }
  .notice { background: #1f2937; }
  .error { background: #3f1d1d; }
  .bar { background: #374151; }
}
```

- [ ] **Step 8: Run tests**

```bash
npx vitest run && npm run typecheck
```

Expected: all pass including the 4 new `canStart` tests.

- [ ] **Step 9: Commit**

```bash
git add -A && git commit -m "feat: add Setup, Progress and Done screens"
```

---

### Task 8: End-to-end verification with real photos

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-08-03-photo-triage-design.md` (risk status only)

This task has no new code. It exists because eye detection cannot be verified by any automated test in this repository — MediaPipe needs a browser, and the only honest check is real photographs of real people, which do not belong in a public git repository.

- [ ] **Step 1: Run the app**

```bash
npm run dev
```

- [ ] **Step 2: Verify against a folder containing known-bad photos**

Use a folder of your own photos that you know contains at least one of each:

- a photo where somebody is mid-blink
- a photo that missed focus
- a group shot where one person of several has their eyes shut
- a portrait with a deliberately soft background and a sharp face
- a burst of near-identical frames
- at least one HEIC and one RAW file

Record for each whether the app agreed with you. **The portrait is the important one** — if it is rejected for blur, the face-aware promotion rule is not firing, and that is a bug, not a calibration matter.

- [ ] **Step 3: Check the CSV**

Open `<staging>/_photo-triage/run-*/report.csv` and confirm the `eyeMin` and `faceCount` columns are populated for photos containing faces. If `faceCount` is 0 everywhere, the detector is not running and the smoke test's `faces=0` was a false comfort.

- [ ] **Step 4: Record the outcome**

Update R3 in the spec with what you actually observed — how reliable eye detection proved on real photos, and at what face size it stopped working. Replace the guessed 4% minimum with a measured one if they differ.

- [ ] **Step 5: Update the README**

Change the Status section: the desktop app now exists and eye detection works. Document `npm run dev`, and note that the review screen is still to come. Remove the line saying eye detection is unavailable.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "docs: record eye detection verification against real photos"
```

---

## Self-Review

**Spec coverage for this plan's scope:** Electron shell (T1), MediaPipe assets resolved locally with no CDN (T2), eye scoring including the blendshape/EAR cross-check and the 4% face-size floor (T3, T4), the hidden-renderer architecture the spec specifies (T4), orchestration with progress and cancellation (T5), typed IPC (T6), Setup and Progress screens with presets and recurse (T7), real-photo verification (T8).

**Carried forward to the review-screen plan:** the Apply gate (nothing written until confirmed), the thumbnail grid, reason chips, zoom with face crops, live threshold sliders, per-photo overrides, burst stacks, and keyboard navigation. Also jsdom plus Testing Library, which that plan's UI complexity will justify and this one's does not.

**Carried forward to the packaging plan:** electron-builder configuration, `asarUnpack` for `sharp` and exiftool, the packaged-path correction in `assets.ts`, the score cache, and the CI release matrix.

**Known risks in this plan.** Two steps are explicitly written as "check, then correct" rather than asserted, because they depend on build output that cannot be known until the build runs: the face worker's packaged HTML path in Task 4 Step 5, and MediaPipe's ability to `fetch` a `file://` URL for the model in Task 4 Step 7. Both have a stated fallback. Everything else is specified concretely.
