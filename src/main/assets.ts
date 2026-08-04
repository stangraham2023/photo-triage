import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MODEL_SHA256 =
  '64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff';

/**
 * Assets sit in different places in development and in a packaged app, and this
 * module is imported both by the Electron main process and by plain Vitest — so
 * it must not import `electron`.
 *
 * In a packaged build, electron-builder copies them to Resources as plain files
 * (see extraResources): the model is read with fs and the WASM is fetched by
 * URL, and neither can be done from inside the asar archive. Each lookup tries
 * the packaged location first and falls back to the source tree, so the same
 * code path works in `npm run dev`, in tests, and in the shipped app.
 */
function resourcesDir(): string | null {
  const p = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  return typeof p === 'string' && p.length > 0 ? p : null;
}

function projectRoot(): string {
  // src/main -> src -> root, or out/main -> out -> root
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

function firstExisting(candidates: Array<string | null>, label: string): string {
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  // Returning the dev path unchecked would fail later with a confusing error
  // from deep inside MediaPipe rather than here, where the cause is obvious.
  throw new Error(
    `Could not locate ${label}. Looked in:\n  ${candidates.filter(Boolean).join('\n  ')}\n` +
    `If this is a development checkout, run: npm run fetch-model`,
  );
}

export function resolveModelPath(): string {
  const res = resourcesDir();
  return firstExisting([
    res && join(res, 'models', 'face_landmarker.task'),
    join(projectRoot(), 'assets', 'models', 'face_landmarker.task'),
  ], 'the face detection model');
}

export function resolveWasmDir(): string {
  const res = resourcesDir();
  return firstExisting([
    res && join(res, 'mediapipe-wasm'),
    join(projectRoot(), 'node_modules', '@mediapipe', 'tasks-vision', 'wasm'),
  ], 'the MediaPipe WASM runtime');
}
