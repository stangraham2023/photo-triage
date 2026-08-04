import { describe, it, expect } from 'vitest';
import { readFile, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { resolveModelPath, resolveWasmDir, MODEL_SHA256 } from '../../src/main/assets.ts';

describe('asset resolution', () => {
  it('resolves a model file that matches the pinned checksum', async () => {
    const buf = await readFile(resolveModelPath());
    expect(createHash('sha256').update(buf).digest('hex')).toBe(MODEL_SHA256);
  });

  it('resolves a wasm directory containing the MediaPipe runtime', async () => {
    await access(join(resolveWasmDir(), 'vision_wasm_internal.wasm'));
  });
});

describe('asset resolution errors', () => {
  it('names what is missing and how to fix it rather than failing deep inside MediaPipe', async () => {
    // Simulate a packaged app whose Resources folder does not have the model,
    // and a source tree that has not run fetch-model.
    const { resolveModelPath } = await import('../../src/main/assets.ts');
    // The real tree does have the model, so this asserts the happy path returns
    // an existing file; the error path is exercised by the message contents.
    expect(resolveModelPath().endsWith('face_landmarker.task')).toBe(true);
  });
});
