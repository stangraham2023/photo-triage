import { describe, it, expect } from 'vitest';
import {
  recompute, buildReviewState, applyOverride, clearOverride,
  effectiveDecisions, counts, isOverridden,
} from '../../src/renderer/review/model.ts';
import { PRESETS } from '../../src/core/presets.ts';
import type { PhotoRecord, Scores } from '../../src/core/types.ts';
import type { AnalysisPayload } from '../../src/shared/contract.ts';

const scores = (over: Partial<Scores> = {}): Scores => ({
  blurGlobal: 70, blurSharpestRegion: 70, blurFaceMin: null,
  exposure: 80, eyeMin: null, faceCount: 0, phash: '0000000000000000', ...over,
});

const rec = (id: string, over: Partial<Scores> = {}, t = 0): PhotoRecord => ({
  file: { absPath: '/' + id, relPath: id, ext: 'jpg', bytes: 1, mtimeMs: t, onDisk: true },
  meta: { captureTimeMs: t, orientation: 1, cameraModel: null },
  faces: [],
  scores: scores(over),
});

const file = (id: string) =>
  ({ absPath: '/' + id, relPath: id, ext: 'jpg', bytes: 1, mtimeMs: 0, onDisk: true });

const payload = (
  records: PhotoRecord[], unreadable: string[] = [], notDownloaded: string[] = [],
): AnalysisPayload => ({
  runId: 'run-1',
  thumbUrls: Object.fromEntries(records.map((r) => [r.file.relPath, `triage-thumb://run-1/${r.file.relPath}.jpg`])),
  records,
  unreadable: unreadable.map(file),
  notDownloaded: notDownloaded.map((id) => ({ ...file(id), onDisk: false })),
  groups: [],
  cancelled: false,
});

const T = PRESETS.event;

describe('recompute', () => {
  it('rejects a photo below the blur threshold', () => {
    const s = recompute(payload([rec('a.jpg', { blurSharpestRegion: 5, blurGlobal: 5 })]), T);
    expect(s.decisions[0]!.verdict).toBe('rejected');
  });

  it('moves that photo to good when the threshold is lowered', () => {
    const p = payload([rec('a.jpg', { blurSharpestRegion: 25, blurGlobal: 25 })]);
    expect(recompute(p, T).decisions[0]!.verdict).toBe('rejected');
    expect(recompute(p, { ...T, blur: 10 }).decisions[0]!.verdict).toBe('good');
  });

  it('re-clusters when the burst distance changes, proving cluster runs here', () => {
    const p = payload([
      rec('a.jpg', { phash: '0000000000000000' }, 1000),
      rec('b.jpg', { phash: '000000000000000f' }, 2000),
    ]);
    // Hamming distance is 4: grouped at 10, not grouped at 1.
    const grouped = recompute(p, T).decisions.filter((d) => d.reasons.some((r) => r.code === 'duplicate'));
    const apart = recompute(p, { ...T, burstHammingMax: 1 }).decisions
      .filter((d) => d.reasons.some((r) => r.code === 'duplicate'));
    expect(grouped).toHaveLength(1);
    expect(apart).toHaveLength(0);
  });

  it('is pure — same input, equal output, and the input is not mutated', () => {
    const p = payload([rec('a.jpg')]);
    const before = JSON.stringify(p);
    const one = recompute(p, T);
    const two = recompute(p, T);
    expect(one.decisions).toEqual(two.decisions);
    expect(JSON.stringify(p)).toBe(before);
  });

  it('includes unreadable photos as their own verdict', () => {
    const s = recompute(payload([rec('a.jpg')], ['bad.jpg']), T);
    expect(s.decisions.find((d) => d.id === 'bad.jpg')!.verdict).toBe('unreadable');
  });

  it('preserves overrides passed through it', () => {
    const p = payload([rec('a.jpg', { blurSharpestRegion: 5, blurGlobal: 5 })]);
    const overrides = new Map([['a.jpg', 'good' as const]]);
    const s = recompute(p, { ...T, blur: 1 }, overrides);
    expect(s.overrides.get('a.jpg')).toBe('good');
  });
});

describe('applyOverride', () => {
  it('flips a verdict in the effective decisions', () => {
    const s = applyOverride(
      buildReviewState(payload([rec('a.jpg', { blurSharpestRegion: 5, blurGlobal: 5 })]), T),
      'a.jpg', 'good',
    );
    expect(effectiveDecisions(s)[0]!.verdict).toBe('good');
  });

  it('keeps the original reasons so the UI can still show why it was flagged', () => {
    const s = applyOverride(
      buildReviewState(payload([rec('a.jpg', { blurSharpestRegion: 5, blurGlobal: 5 })]), T),
      'a.jpg', 'good',
    );
    expect(effectiveDecisions(s)[0]!.reasons.map((r) => r.code)).toContain('blur');
  });

  it('survives a threshold change', () => {
    let s = buildReviewState(payload([rec('a.jpg', { blurSharpestRegion: 5, blurGlobal: 5 })]), T);
    s = applyOverride(s, 'a.jpg', 'good');
    const after = recompute(s.payload, { ...s.thresholds, blur: 90 }, s.overrides);
    expect(effectiveDecisions(after)[0]!.verdict).toBe('good');
  });

  it('refuses to override an unreadable photo', () => {
    const s = applyOverride(buildReviewState(payload([], ['bad.jpg']), T), 'bad.jpg', 'good');
    expect(effectiveDecisions(s)[0]!.verdict).toBe('unreadable');
  });

  it('does not mutate the state it was given', () => {
    const s = buildReviewState(payload([rec('a.jpg', { blurSharpestRegion: 5, blurGlobal: 5 })]), T);
    applyOverride(s, 'a.jpg', 'good');
    expect(s.overrides.size).toBe(0);
  });
});

describe('clearOverride', () => {
  it('restores the computed verdict', () => {
    let s = buildReviewState(payload([rec('a.jpg', { blurSharpestRegion: 5, blurGlobal: 5 })]), T);
    s = applyOverride(s, 'a.jpg', 'good');
    s = clearOverride(s, 'a.jpg');
    expect(effectiveDecisions(s)[0]!.verdict).toBe('rejected');
  });
});

describe('isOverridden', () => {
  it('is false when the override agrees with the computed verdict', () => {
    const s = applyOverride(buildReviewState(payload([rec('a.jpg')]), T), 'a.jpg', 'good');
    expect(isOverridden(s, 'a.jpg')).toBe(false);
  });

  it('is true when it disagrees', () => {
    const s = applyOverride(buildReviewState(payload([rec('a.jpg')]), T), 'a.jpg', 'rejected');
    expect(isOverridden(s, 'a.jpg')).toBe(true);
  });
});

describe('counts', () => {
  it('counts verdicts and overrides separately', () => {
    let s = buildReviewState(
      payload([rec('a.jpg'), rec('b.jpg', { blurSharpestRegion: 5, blurGlobal: 5 })], ['bad.jpg']),
      T,
    );
    s = applyOverride(s, 'b.jpg', 'good');
    expect(counts(s)).toEqual({ good: 2, rejected: 0, unreadable: 1, notDownloaded: 0, overridden: 1 });
  });
});

describe('groups in state', () => {
  it('exposes the groups the decisions were actually built from', () => {
    const p = payload([
      rec('a.jpg', { phash: '0000000000000000' }, 1000),
      rec('b.jpg', { phash: '000000000000000f' }, 2000),
    ]);
    // The payload carries no groups, but recompute finds one.
    expect(p.groups).toHaveLength(0);
    expect(recompute(p, T).groups).toHaveLength(1);
  });

  it('drops groups when duplicate detection is switched off', () => {
    const p = payload([
      rec('a.jpg', { phash: '0000000000000000' }, 1000),
      rec('b.jpg', { phash: '000000000000000f' }, 2000),
    ]);
    expect(recompute(p, { ...T, enableDuplicates: false }).groups).toHaveLength(0);
  });

  it('re-clusters groups when the slider moves, so a stale count cannot be shown', () => {
    const p = payload([
      rec('a.jpg', { phash: '0000000000000000' }, 1000),
      rec('b.jpg', { phash: '000000000000000f' }, 2000),
    ]);
    expect(recompute(p, T).groups[0]!.memberIds).toHaveLength(2);
    expect(recompute(p, { ...T, burstHammingMax: 1 }).groups).toHaveLength(0);
  });
});

describe('cloud placeholders', () => {
  it('gets its own verdict rather than being called unreadable', () => {
    const s = recompute(payload([], [], ['offloaded.jpg']), T);
    expect(s.decisions[0]!.verdict).toBe('not-downloaded');
  });

  it('cannot be overridden into a keeper — there is nothing to copy', () => {
    const s = applyOverride(recompute(payload([], [], ['offloaded.jpg']), T), 'offloaded.jpg', 'good');
    expect(effectiveDecisions(s)[0]!.verdict).toBe('not-downloaded');
  });

  it('is counted apart from unreadable files', () => {
    const s = recompute(payload([rec('a.jpg')], ['broken.jpg'], ['offloaded.jpg']), T);
    expect(counts(s)).toMatchObject({ good: 1, unreadable: 1, notDownloaded: 1 });
  });
});
