import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtemp, mkdir, copyFile, access, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeRun, applyDecisions } from '../../src/main/orchestrator.ts';
import { thumbPathFor } from '../../src/main/thumbnails.ts';
import { MetadataReader } from '../../src/core/metadata.ts';
import { NullFaceDetector, StubFaceDetector } from '../../src/core/scores/faces.ts';
import { decideAll } from '../../src/core/verdict.ts';
import { PRESETS } from '../../src/core/presets.ts';
import { FIXTURE_DIR } from '../fixtures/globalSetup.ts';
import type { Decision } from '../../src/core/types.ts';

let src: string, staging: string, review: string, thumbRoot: string;
const reader = new MetadataReader();
afterAll(() => reader.close());

beforeEach(async () => {
  const base = await mkdtemp(join(tmpdir(), 'orch-'));
  src = join(base, 'src');
  staging = join(base, 'staging');
  review = join(base, 'review');
  thumbRoot = join(base, 'thumbs');
  await mkdir(src, { recursive: true });
  for (const f of ['sharp.png', 'blurry.png', 'corrupt.jpg']) {
    await copyFile(join(FIXTURE_DIR, f), join(src, f));
  }
});

const base = () => ({
  source: src,
  preset: 'event' as const,
  recurse: true,
  detector: new NullFaceDetector(),
  reader,
  thumbRoot,
});

describe('analyzeRun', () => {
  it('returns records and unreadable files', async () => {
    const r = await analyzeRun(base());
    expect(r.records).toHaveLength(2);
    expect(r.unreadable).toHaveLength(1);
    expect(r.unreadable[0]!.relPath).toBe('corrupt.jpg');
  });

  // The guarantee the whole review gate exists to provide.
  it('writes nothing to the destinations', async () => {
    await analyzeRun(base());
    await expect(access(staging)).rejects.toThrow();
    await expect(access(review)).rejects.toThrow();
  });

  it('writes a thumbnail for every readable photo', async () => {
    const r = await analyzeRun(base());
    for (const rec of r.records) {
      await access(thumbPathFor(join(thumbRoot, r.runId), rec.file.relPath));
    }
  });

  it('reports burst groups', async () => {
    const r = await analyzeRun(base());
    expect(Array.isArray(r.groups)).toBe(true);
  });

  it('stops early when aborted', async () => {
    const ac = new AbortController();
    const r = await analyzeRun({ ...base(), signal: ac.signal, onProgress: () => ac.abort() });
    expect(r.cancelled).toBe(true);
    expect(r.records.length).toBeLessThan(3);
  });

  it('uses the injected face detector', async () => {
    const detector = new StubFaceDetector([
      { box: { x: 0.2, y: 0.2, width: 0.4, height: 0.4 }, eyeOpenScore: 0.02, confidence: 0.9 },
    ]);
    const r = await analyzeRun({ ...base(), detector });
    expect(r.records[0]!.scores.eyeMin).toBeCloseTo(0.02);
    expect(r.records[0]!.faces).toHaveLength(1);
  });
});

describe('applyDecisions', () => {
  const allGood = (ids: string[]): Decision[] =>
    ids.map((id) => ({ id, verdict: 'good', reasons: [], groupId: null, isGroupKeeper: true }));

  it('copies according to the decisions it is given, not the computed ones', async () => {
    const a = await analyzeRun(base());
    const files = [...a.records.map((r) => r.file), ...a.unreadable];

    // blurry.png would normally be rejected. An override says keep it.
    await applyDecisions({
      runId: a.runId, files, records: a.records,
      decisions: allGood(files.map((f) => f.relPath)),
      staging, review,
    });

    await access(join(staging, 'blurry.png'));
    await expect(access(join(review, 'blurry.png'))).rejects.toThrow();
  });

  it('writes a manifest and both reports', async () => {
    const a = await analyzeRun(base());
    const files = [...a.records.map((r) => r.file), ...a.unreadable];
    const decisions = decideAll(a.records, PRESETS.event, a.groups);
    const r = await applyDecisions({
      runId: a.runId, files, records: a.records, decisions, staging, review,
    });
    await access(r.manifestPath);
    await access(join(r.reportDir, 'report.csv'));
    await access(join(r.reportDir, 'report.html'));
    expect(r.copied).toBeGreaterThan(0);
  });

  it('leaves the source folder untouched', async () => {
    const before = (await readdir(src)).sort();
    const a = await analyzeRun(base());
    const files = [...a.records.map((r) => r.file), ...a.unreadable];
    await applyDecisions({
      runId: a.runId, files, records: a.records,
      decisions: allGood(files.map((f) => f.relPath)),
      staging, review,
    });
    expect((await readdir(src)).sort()).toEqual(before);
  });
});
