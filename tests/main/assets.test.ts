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
