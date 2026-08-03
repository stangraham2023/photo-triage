import type { PhotoRecord, PhotoId, Scores, Thresholds } from './types.ts';
import { hammingDistance } from './scores/phash.ts';

export interface BurstGroup {
  id: string;
  memberIds: PhotoId[];
  keeperId: PhotoId;
}

/**
 * Weighted mean used to pick the keeper of a burst. Weights favour the two
 * defects a viewer notices first: a blink and a missed focus on the face.
 * When no faces are present the face terms drop out and the rest renormalise.
 */
export function combinedQuality(s: Scores): number {
  const terms: Array<[value: number, weight: number]> = [
    [s.blurSharpestRegion, 3],
    [s.exposure, 1],
  ];
  if (s.faceCount > 0) {
    if (s.eyeMin !== null) terms.push([s.eyeMin * 100, 3]);
    if (s.blurFaceMin !== null) terms.push([s.blurFaceMin, 2]);
  }
  const totalWeight = terms.reduce((a, [, w]) => a + w, 0);
  return terms.reduce((a, [v, w]) => a + v * w, 0) / totalWeight;
}

function timeOf(r: PhotoRecord): number {
  return r.meta.captureTimeMs ?? r.file.mtimeMs;
}

export function clusterBursts(
  records: PhotoRecord[],
  t: Pick<Thresholds, 'burstHammingMax' | 'burstWindowMs'>,
): BurstGroup[] {
  const sorted = [...records].sort((a, b) => timeOf(a) - timeOf(b));

  // Union-find over the time-sorted list so chains (a~b, b~c) form one group
  // even when a and c are too far apart to match directly.
  const parent = sorted.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  const union = (a: number, b: number) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      if (timeOf(sorted[j]!) - timeOf(sorted[i]!) > t.burstWindowMs) break;
      if (hammingDistance(sorted[i]!.scores.phash, sorted[j]!.scores.phash) <= t.burstHammingMax) {
        union(i, j);
      }
    }
  }

  const byRoot = new Map<number, number[]>();
  for (let i = 0; i < sorted.length; i++) {
    const root = find(i);
    const list = byRoot.get(root);
    if (list) list.push(i); else byRoot.set(root, [i]);
  }

  const groups: BurstGroup[] = [];
  for (const indices of byRoot.values()) {
    if (indices.length < 2) continue;
    let keeper = indices[0]!;
    let best = combinedQuality(sorted[keeper]!.scores);
    for (const i of indices.slice(1)) {
      const q = combinedQuality(sorted[i]!.scores);
      // Strict greater-than breaks ties toward the earlier frame, since the
      // list is already sorted by capture time.
      if (q > best) { best = q; keeper = i; }
    }
    groups.push({
      id: `burst-${sorted[indices[0]!]!.file.relPath}`,
      memberIds: indices.map((i) => sorted[i]!.file.relPath),
      keeperId: sorted[keeper]!.file.relPath,
    });
  }
  return groups;
}
