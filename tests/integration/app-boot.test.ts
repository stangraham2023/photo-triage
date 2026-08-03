import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Boots the real Electron app rather than mocking it.
 *
 * Phase 1 taught us that a bug can pass every unit test and still break the
 * moment real Node loads the code — a CommonJS interop mistake made every HEIC
 * unreadable while the suite stayed green. An Electron app adds three more
 * module loaders to get wrong, so the only trustworthy check is launching it.
 */
describe('electron app', () => {
  it('boots, loads the renderer and exits cleanly', async () => {
    const { stdout } = await run('npm', ['run', 'smoke'], {
      cwd: ROOT,
      env: { ...process.env, ELECTRON_DISABLE_SANDBOX: '1' },
      timeout: 180_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    expect(stdout).toContain('SMOKE_OK');
  }, 240_000);
});
