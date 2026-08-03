import { describe, it, expect, beforeAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, access, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIXTURE_DIR } from '../fixtures/globalSetup.ts';

const run = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(ROOT, 'src', 'cli', 'index.ts');

let src: string, staging: string, review: string;

/**
 * Runs the CLI as a real subprocess under plain Node.
 *
 * This exists because Vitest's module transform is more forgiving than Node's
 * own ESM loader. A CommonJS interop bug that made every HEIC file unreadable
 * passed the unit tests and only appeared when the CLI was run by hand.
 */
function triage(args: string[]) {
  return run(process.execPath, ['--experimental-strip-types', CLI, ...args], {
    cwd: ROOT,
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });
}

beforeAll(async () => {
  const base = await mkdtemp(join(tmpdir(), 'cli-'));
  src = join(base, 'src'); staging = join(base, 'staging'); review = join(base, 'review');
  await mkdir(src, { recursive: true });
  for (const f of ['sharp.png', 'blurry.png', 'corrupt.jpg']) {
    await copyFile(join(FIXTURE_DIR, f), join(src, f));
  }
  const b64 = await readFile(join(ROOT, 'tests', 'fixtures', 'hevc-sample.heic.base64'), 'utf8');
  await writeFile(join(src, 'photo.heic'), Buffer.from(b64.trim(), 'base64'));
});

describe('CLI end to end', () => {
  it('decodes HEIC under plain Node, not just under the test runner', async () => {
    const { stdout } = await triage(['--source', src, '--staging', staging, '--review', review, '--dry-run']);
    // corrupt.jpg is the only file that should ever be unreadable.
    expect(stdout).toContain('1 unreadable');
    expect(stdout).toContain('Found 4 images');
  });

  it('copies files and writes reports, then undoes cleanly', async () => {
    const { stdout } = await triage(['--source', src, '--staging', staging, '--review', review]);
    await access(join(staging, 'sharp.png'));
    await access(join(review, '_unreadable', 'corrupt.jpg'));

    const runDir = join(staging, '_photo-triage');
    const runs = await readdir(runDir);
    expect(runs.length).toBeGreaterThan(0);
    await access(join(runDir, runs[0]!, 'report.csv'));
    await access(join(runDir, runs[0]!, 'report.html'));

    const manifest = join(runDir, runs[0]!, 'manifest.json');
    expect(stdout).toContain('Copied');

    const undone = await triage(['--undo', manifest]);
    expect(undone.stdout).toContain('Undo complete');
    await expect(access(join(staging, 'sharp.png'))).rejects.toThrow();
    // The source is never touched by any of this.
    expect((await readdir(src)).sort()).toEqual(['blurry.png', 'corrupt.jpg', 'photo.heic', 'sharp.png']);
  });

  it('exits with an error when required arguments are missing', async () => {
    await expect(triage(['--source', src])).rejects.toMatchObject({ code: 2 });
  });
});
