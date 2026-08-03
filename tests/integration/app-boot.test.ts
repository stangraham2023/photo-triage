import { describe, it, expect, beforeAll } from 'vitest';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIXTURE_DIR } from '../fixtures/globalSetup.ts';

const run = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const BOOT_TIMEOUT_MS = 90_000;

/**
 * Spawns the Electron binary directly rather than going through `npm run`.
 *
 * Killing an `npm run` child leaves its Electron grandchild orphaned, and those
 * accumulate: a previous version of this test stranded 23 live Electron
 * processes that then starved each other and turned a 25-second boot into a
 * three-minute timeout. Spawning the binary gives one process to kill.
 */
async function runSmoke(source?: string): Promise<string> {
  const electronPath = (await import('electron')).default as unknown as string;

  return new Promise<string>((resolve, reject) => {
    const child = spawn(electronPath, ['.'], {
      cwd: ROOT,
      env: {
        ...process.env,
        PHOTO_TRIAGE_SMOKE: '1',
        ELECTRON_DISABLE_SANDBOX: '1',
        ...(source ? { PHOTO_TRIAGE_SMOKE_SOURCE: source } : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let out = '';
    child.stdout.on('data', (d) => { out += String(d); });
    child.stderr.on('data', (d) => { out += String(d); });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Electron did not finish within ${BOOT_TIMEOUT_MS}ms. Output:\n${out}`));
    }, BOOT_TIMEOUT_MS);

    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`Electron exited ${code}. Output:\n${out}`));
    });
  });
}

describe('electron app', () => {
  beforeAll(async () => {
    await run('npm', ['run', 'build:app'], { cwd: ROOT, timeout: 180_000 });
  }, 200_000);

  /**
   * One launch asserts both boot and face detection. Booting Electron twice
   * would double a slow test for no extra coverage — this exercises the
   * renderer, the hidden face window, MediaPipe initialisation and the full
   * IPC round trip in a single pass.
   *
   * `faces=0` on a blank image proves the pipeline is wired, NOT that eye
   * detection is accurate. Only real photographs can show that.
   */
  it('boots, initialises MediaPipe and completes a detection round trip', async () => {
    expect(await runSmoke()).toContain('SMOKE_OK faces=0');
  }, 120_000);

  /**
   * Every orchestrator test injects a null or stub detector, so this is the
   * only thing that would catch the real IPC detector coming unwired from the
   * run pipeline.
   */
  it('completes a whole run driven by the real face detector', async () => {
    const out = await runSmoke(FIXTURE_DIR);
    expect(out).toContain('total=10');
    expect(out).toContain('unreadable=1');
  }, 120_000);
});
