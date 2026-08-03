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
  /**
   * One launch asserts both boot and face detection. Booting Electron twice
   * would double a ~30s test for no extra coverage — the smoke run exercises
   * the renderer, the hidden face window, MediaPipe initialisation and the
   * full IPC round trip in a single pass.
   *
   * `faces=0` on a blank image proves the pipeline is wired, NOT that eye
   * detection is accurate. Only real photographs can show that, which is why
   * the plan ends with a manual verification task.
   */
  it('boots, initialises MediaPipe and completes a detection round trip', async () => {
    const { stdout } = await run('npm', ['run', 'smoke'], {
      cwd: ROOT,
      env: { ...process.env, ELECTRON_DISABLE_SANDBOX: '1' },
      timeout: 180_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    expect(stdout).toContain('SMOKE_OK faces=0');
  }, 240_000);
});
