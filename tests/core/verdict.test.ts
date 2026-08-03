import { describe, it, expect } from 'vitest';
import { decide, decideAll } from '../../src/core/verdict.ts';
import { PRESETS } from '../../src/core/presets.ts';
import type { PhotoRecord, Scores } from '../../src/core/types.ts';

const scores = (over: Partial<Scores> = {}): Scores => ({
  blurGlobal: 70, blurSharpestRegion: 70, blurFaceMin: null,
  exposure: 80, eyeMin: null, faceCount: 0,
  phash: '0000000000000000', ...over,
});

const rec = (id: string, over: Partial<Scores> = {}): PhotoRecord => ({
  file: { absPath: '/' + id, relPath: id, ext: 'jpg', bytes: 1, mtimeMs: 0 },
  meta: { captureTimeMs: 0, orientation: 1, cameraModel: null },
  scores: scores(over),
});

const T = PRESETS.event;

describe('decide', () => {
  it('passes a clean photo', () => {
    expect(decide(rec('a.jpg'), T, null).verdict).toBe('good');
  });

  it('rejects a blurred photo and says so', () => {
    const d = decide(rec('a.jpg', { blurGlobal: 5, blurSharpestRegion: 5 }), T, null);
    expect(d.verdict).toBe('rejected');
    expect(d.reasons.map((r) => r.code)).toContain('blur');
  });

  it('rejects closed eyes', () => {
    const d = decide(rec('a.jpg', { eyeMin: 0.05, faceCount: 1, blurFaceMin: 80 }), T, null);
    expect(d.reasons.map((r) => r.code)).toContain('eyes-closed');
  });

  it('rejects bad exposure', () => {
    expect(decide(rec('a.jpg', { exposure: 10 }), T, null).reasons.map((r) => r.code)).toContain('exposure');
  });

  it('lists every failing check, not just the first', () => {
    const d = decide(rec('a.jpg', { blurSharpestRegion: 5, blurGlobal: 5, exposure: 5 }), T, null);
    expect(d.reasons.length).toBeGreaterThanOrEqual(2);
  });

  it('never rejects for eyes when no face was found', () => {
    const d = decide(rec('a.jpg', { eyeMin: null, faceCount: 0 }), T, null);
    expect(d.reasons.map((r) => r.code)).not.toContain('eyes-closed');
  });

  // The shallow depth-of-field correction.
  it('keeps a soft-background portrait when every face is sharp and eyes are open', () => {
    const d = decide(
      rec('a.jpg', { blurGlobal: 10, blurSharpestRegion: 10, blurFaceMin: 85, eyeMin: 0.9, faceCount: 1 }),
      T, null,
    );
    expect(d.verdict).toBe('good');
  });

  it('does not promote a portrait whose face is also soft', () => {
    const d = decide(
      rec('a.jpg', { blurGlobal: 10, blurSharpestRegion: 10, blurFaceMin: 12, eyeMin: 0.9, faceCount: 1 }),
      T, null,
    );
    expect(d.verdict).toBe('rejected');
  });

  it('rejects non-keeper burst members as duplicates', () => {
    const group = { id: 'g', memberIds: ['a.jpg', 'b.jpg'], keeperId: 'a.jpg' };
    expect(decide(rec('a.jpg'), T, group).verdict).toBe('good');
    const loser = decide(rec('b.jpg'), T, group);
    expect(loser.verdict).toBe('rejected');
    expect(loser.reasons.map((r) => r.code)).toContain('duplicate');
  });

  it('respects the enable flags', () => {
    const off = { ...T, enableBlur: false };
    expect(decide(rec('a.jpg', { blurGlobal: 1, blurSharpestRegion: 1 }), off, null).verdict).toBe('good');
  });

  it('is pure — the same input always gives the same output', () => {
    const r = rec('a.jpg', { blurSharpestRegion: 5, blurGlobal: 5 });
    expect(decide(r, T, null)).toEqual(decide(r, T, null));
  });
});

describe('presets', () => {
  it('disables eye checks in landscape mode', () => {
    expect(PRESETS.landscape.enableEyes).toBe(false);
  });

  it('is stricter about eyes in portrait than in event mode', () => {
    expect(PRESETS.portrait.eyes).toBeGreaterThan(PRESETS.event.eyes);
  });
});

describe('decideAll', () => {
  it('returns one decision per record', () => {
    expect(decideAll([rec('a.jpg'), rec('b.jpg')], T, [])).toHaveLength(2);
  });
});
