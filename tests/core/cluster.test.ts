import { describe, it, expect } from 'vitest';
import { clusterBursts, combinedQuality } from '../../src/core/cluster.ts';
import type { PhotoRecord, Scores } from '../../src/core/types.ts';

const scores = (over: Partial<Scores> = {}): Scores => ({
  blurGlobal: 70, blurSharpestRegion: 70, blurFaceMin: null,
  exposure: 80, eyeMin: null, faceCount: 0,
  phash: '0000000000000000', ...over,
});

const rec = (id: string, phash: string, t: number, over: Partial<Scores> = {}): PhotoRecord => ({
  file: { absPath: '/' + id, relPath: id, ext: 'jpg', bytes: 1, mtimeMs: t },
  meta: { captureTimeMs: t, orientation: 1, cameraModel: null },
  faces: [],
  scores: scores({ phash, ...over }),
});

const OPTS = { burstHammingMax: 10, burstWindowMs: 10_000 };

describe('clusterBursts', () => {
  it('groups near-identical photos taken close together', () => {
    const g = clusterBursts([
      rec('a.jpg', '0000000000000000', 1000),
      rec('b.jpg', '0000000000000001', 3000),
    ], OPTS);
    expect(g).toHaveLength(1);
    expect(g[0]!.memberIds.sort()).toEqual(['a.jpg', 'b.jpg']);
  });

  it('does not group visually different photos', () => {
    expect(clusterBursts([
      rec('a.jpg', '0000000000000000', 1000),
      rec('b.jpg', 'ffffffffffffffff', 2000),
    ], OPTS)).toHaveLength(0);
  });

  it('does not group similar photos taken hours apart', () => {
    expect(clusterBursts([
      rec('a.jpg', '0000000000000000', 1000),
      rec('b.jpg', '0000000000000001', 9_000_000),
    ], OPTS)).toHaveLength(0);
  });

  it('picks the sharpest member as keeper', () => {
    const g = clusterBursts([
      rec('soft.jpg', '0000000000000000', 1000, { blurSharpestRegion: 30 }),
      rec('sharp.jpg', '0000000000000001', 2000, { blurSharpestRegion: 90 }),
    ], OPTS);
    expect(g[0]!.keeperId).toBe('sharp.jpg');
  });

  it('prefers open eyes over marginal extra sharpness', () => {
    const g = clusterBursts([
      rec('blink.jpg', '0000000000000000', 1000, { blurSharpestRegion: 92, eyeMin: 0.05, faceCount: 1, blurFaceMin: 80 }),
      rec('open.jpg', '0000000000000001', 2000, { blurSharpestRegion: 85, eyeMin: 0.95, faceCount: 1, blurFaceMin: 80 }),
    ], OPTS);
    expect(g[0]!.keeperId).toBe('open.jpg');
  });

  it('chains a three-frame burst into one group', () => {
    const g = clusterBursts([
      rec('a.jpg', '0000000000000000', 1000),
      rec('b.jpg', '0000000000000001', 2000),
      rec('c.jpg', '0000000000000003', 3000),
    ], OPTS);
    expect(g).toHaveLength(1);
    expect(g[0]!.memberIds).toHaveLength(3);
  });

  it('falls back to file mtime when there is no capture time', () => {
    const a = rec('a.jpg', '0000000000000000', 1000);
    const b = rec('b.jpg', '0000000000000001', 2000);
    a.meta.captureTimeMs = null;
    b.meta.captureTimeMs = null;
    expect(clusterBursts([a, b], OPTS)).toHaveLength(1);
  });
});

describe('combinedQuality', () => {
  it('ignores face terms when no faces are present', () => {
    expect(combinedQuality(scores({ blurSharpestRegion: 50, exposure: 50 }))).toBeCloseTo(50);
  });

  it('drops sharply when eyes are closed', () => {
    const open = combinedQuality(scores({ eyeMin: 0.95, faceCount: 1, blurFaceMin: 80 }));
    const shut = combinedQuality(scores({ eyeMin: 0.05, faceCount: 1, blurFaceMin: 80 }));
    expect(shut).toBeLessThan(open);
  });
});
