import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, copyFile, readdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanDirectory } from '../../src/core/scan.ts';
import { MetadataReader } from '../../src/core/metadata.ts';
import { NullFaceDetector } from '../../src/core/scores/faces.ts';
import { analyzeAll } from '../../src/core/analyze.ts';
import { clusterBursts } from '../../src/core/cluster.ts';
import { decideAll } from '../../src/core/verdict.ts';
import { PRESETS } from '../../src/core/presets.ts';
import { buildPlan, executePlan } from '../../src/core/apply.ts';
import { FIXTURE_DIR } from '../fixtures/globalSetup.ts';
import type { Decision } from '../../src/core/types.ts';

let src: string, staging: string, review: string;
const reader = new MetadataReader();

beforeAll(async () => {
  const base = await mkdtemp(join(tmpdir(), 'pipeline-'));
  src = join(base, 'src'); staging = join(base, 'staging'); review = join(base, 'review');
  await mkdir(join(src, 'nested'), { recursive: true });
  for (const f of ['sharp.png', 'blurry.png', 'overexposed.png', 'burst-1.png', 'burst-2.png', 'corrupt.jpg']) {
    await copyFile(join(FIXTURE_DIR, f), join(src, f));
  }
  // A structurally different scene, so the nested keeper is not a duplicate of
  // sharp.png — otherwise burst detection correctly rejects one of the two and
  // the test is really asserting which copy won a tie-break.
  await copyFile(join(FIXTURE_DIR, 'different.png'), join(src, 'nested', 'deep.png'));
});

afterAll(() => reader.close());

describe('full pipeline', () => {
  it('sorts a folder end to end', async () => {
    const scan = await scanDirectory(src);
    expect(scan.images.length).toBe(7);

    const { records, unreadable } = await analyzeAll(scan.images, reader, new NullFaceDetector());
    expect(unreadable).toHaveLength(1);
    expect(unreadable[0]!.relPath).toBe('corrupt.jpg');

    const groups = clusterBursts(records, PRESETS.event);
    const decisions: Decision[] = decideAll(records, PRESETS.event, groups);
    for (const f of unreadable) {
      decisions.push({ id: f.relPath, verdict: 'unreadable', reasons: [], groupId: null, isGroupKeeper: true });
    }

    await executePlan(buildPlan(scan.images, decisions, { staging, review }));

    // The sharp fixture is a keeper; the blurred one is not.
    await access(join(staging, 'sharp.png'));
    await access(join(review, 'blurry.png'));
    // Subfolder structure is mirrored.
    await access(join(staging, 'nested', 'deep.png'));
    // Corrupt files land in their own bucket.
    await access(join(review, '_unreadable', 'corrupt.jpg'));
    // Source is untouched.
    expect((await readdir(src)).length).toBe(7);
  });

  it('detects the burst pair and rejects only the non-keeper', async () => {
    const scan = await scanDirectory(src);
    const { records } = await analyzeAll(scan.images, reader, new NullFaceDetector());
    const groups = clusterBursts(records, PRESETS.event);

    const burst = groups.find((g) => g.memberIds.includes('burst-1.png'));
    expect(burst).toBeDefined();
    expect(burst!.memberIds.sort()).toEqual(['burst-1.png', 'burst-2.png']);

    // Exactly one member of each group survives; the rest are duplicates.
    const decisions = decideAll(records, PRESETS.event, groups);
    const dups = decisions.filter((d) => d.reasons.some((r) => r.code === 'duplicate'));
    const expectedDups = groups.reduce((n, g) => n + g.memberIds.length - 1, 0);
    expect(dups.length).toBe(expectedDups);
  });
});
