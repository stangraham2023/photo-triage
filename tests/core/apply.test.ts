import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, access, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPlan, executePlan, undo, checkFreeSpace } from '../../src/core/apply.ts';
import type { Decision, ScannedFile } from '../../src/core/types.ts';

let src: string, staging: string, review: string;

const rec = (rel: string): ScannedFile =>
  ({ absPath: join(src, rel), relPath: rel, ext: 'jpg', bytes: 3, mtimeMs: 0 });

const dec = (id: string, verdict: Decision['verdict']): Decision => ({
  id, verdict, reasons: [], groupId: null, isGroupKeeper: true,
});

beforeEach(async () => {
  const base = await mkdtemp(join(tmpdir(), 'apply-'));
  src = join(base, 'src'); staging = join(base, 'staging'); review = join(base, 'review');
  await mkdir(join(src, 'sub'), { recursive: true });
  await writeFile(join(src, 'good.jpg'), 'aaa');
  await writeFile(join(src, 'sub', 'bad.jpg'), 'bbb');
});

const dests = () => ({ staging, review });

describe('executePlan', () => {
  it('copies keepers to staging and rejects to review', async () => {
    const files = [rec('good.jpg'), rec(join('sub', 'bad.jpg'))];
    const decisions = [dec('good.jpg', 'good'), dec(join('sub', 'bad.jpg'), 'rejected')];
    await executePlan(buildPlan(files, decisions, dests()));

    await access(join(staging, 'good.jpg'));
    await access(join(review, 'sub', 'bad.jpg'));
  });

  it('mirrors the source subfolder structure', async () => {
    await executePlan(buildPlan([rec(join('sub', 'bad.jpg'))], [dec(join('sub', 'bad.jpg'), 'rejected')], dests()));
    expect(await readdir(join(review, 'sub'))).toContain('bad.jpg');
  });

  it('leaves the source folder untouched', async () => {
    const before = (await readdir(src)).sort();
    await executePlan(buildPlan([rec('good.jpg')], [dec('good.jpg', 'good')], dests()));
    expect((await readdir(src)).sort()).toEqual(before);
    expect(await readFile(join(src, 'good.jpg'), 'utf8')).toBe('aaa');
  });

  it('routes unreadable files to their own bucket', async () => {
    await executePlan(buildPlan([rec('good.jpg')], [dec('good.jpg', 'unreadable')], dests()));
    await access(join(review, '_unreadable', 'good.jpg'));
  });

  it('suffixes rather than overwrites a differing file', async () => {
    await mkdir(staging, { recursive: true });
    await writeFile(join(staging, 'good.jpg'), 'DIFFERENT');
    await executePlan(buildPlan([rec('good.jpg')], [dec('good.jpg', 'good')], dests()));
    expect(await readFile(join(staging, 'good.jpg'), 'utf8')).toBe('DIFFERENT');
    await access(join(staging, 'good (2).jpg'));
  });

  it('skips a byte-identical file already at the destination', async () => {
    await mkdir(staging, { recursive: true });
    await writeFile(join(staging, 'good.jpg'), 'aaa');
    const m = await executePlan(buildPlan([rec('good.jpg')], [dec('good.jpg', 'good')], dests()));
    expect(m.skipped).toBe(1);
    expect((await readdir(staging)).filter((n) => n.endsWith('.jpg'))).toEqual(['good.jpg']);
  });

  it('writes a manifest listing every copy', async () => {
    const m = await executePlan(buildPlan([rec('good.jpg')], [dec('good.jpg', 'good')], dests()));
    expect(m.operations).toHaveLength(1);
    expect(JSON.parse(await readFile(m.manifestPath, 'utf8')).operations).toHaveLength(1);
  });
});

describe('undo', () => {
  it('removes copied files and leaves the source alone', async () => {
    const m = await executePlan(buildPlan([rec('good.jpg')], [dec('good.jpg', 'good')], dests()));
    const r = await undo(m.manifestPath);
    expect(r.removed).toBe(1);
    await expect(access(join(staging, 'good.jpg'))).rejects.toThrow();
    await access(join(src, 'good.jpg'));
  });

  it('refuses to remove a file that has been modified since the copy', async () => {
    const m = await executePlan(buildPlan([rec('good.jpg')], [dec('good.jpg', 'good')], dests()));
    await new Promise((r) => setTimeout(r, 15));
    await writeFile(join(staging, 'good.jpg'), 'edited by the user');
    const r = await undo(m.manifestPath);
    expect(r.removed).toBe(0);
    expect(r.skipped).toBe(1);
    await access(join(staging, 'good.jpg'));
  });
});

describe('checkFreeSpace', () => {
  it('reports the required bytes for the plan', async () => {
    const r = await checkFreeSpace(buildPlan([rec('good.jpg')], [dec('good.jpg', 'good')], dests()));
    expect(r.requiredBytes).toBeGreaterThan(0);
    expect(r.ok).toBe(true);
  });
});
