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

  it('writes reports alongside the manifest', async () => {
    const r = await runTriage(base());
    await access(join(r.reportDir!, 'report.csv'));
    await access(join(r.reportDir!, 'report.html'));
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
