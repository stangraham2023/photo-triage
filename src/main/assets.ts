import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MODEL_SHA256 =
  '64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff';

/**
 * Assets live in different places in development and when packaged, and this
 * module is imported both by the Electron main process and by plain Vitest —
 * so it must not import `electron`. Walking up from this file to the project
 * root works in both cases (`src/main/` and `out/main/` are both one level
 * below the root). The packaged case is corrected in the packaging plan, once
 * the app.asar layout is settled.
 */
function projectRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', '..');
}

export function resolveModelPath(): string {
  return join(projectRoot(), 'assets', 'models', 'face_landmarker.task');
}

export function resolveWasmDir(): string {
  return join(projectRoot(), 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
}
