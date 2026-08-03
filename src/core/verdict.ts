import type { Decision, PhotoRecord, Reason, Thresholds } from './types.ts';
import type { BurstGroup } from './cluster.ts';

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

export function decide(
  record: PhotoRecord,
  t: Thresholds,
  group: BurstGroup | null,
): Decision {
  const s = record.scores;
  const reasons: Reason[] = [];

  const facesSharp = s.blurFaceMin !== null && s.blurFaceMin >= t.faceBlur;
  const eyesOpen = s.eyeMin !== null && s.eyeMin >= t.eyes;

  if (t.enableBlur && s.blurSharpestRegion < t.blur) {
    // Face-aware promotion: a portrait with a deliberately soft background is
    // not a mistake, provided the faces themselves are sharp and eyes are open.
    const promoted = s.faceCount > 0 && facesSharp && (!t.enableEyes || eyesOpen);
    if (!promoted) {
      reasons.push({
        code: 'blur',
        detail: `blur ${round(s.blurSharpestRegion)} (threshold ${t.blur})`,
        score: round(s.blurSharpestRegion),
        threshold: t.blur,
      });
    }
  }

  if (t.enableBlur && s.blurFaceMin !== null && s.blurFaceMin < t.faceBlur) {
    reasons.push({
      code: 'blur',
      detail: `face out of focus ${round(s.blurFaceMin)} (threshold ${t.faceBlur})`,
      score: round(s.blurFaceMin),
      threshold: t.faceBlur,
    });
  }

  if (t.enableEyes && s.eyeMin !== null && s.eyeMin < t.eyes) {
    const which = s.faceCount > 1 ? ` · worst of ${s.faceCount} faces` : '';
    reasons.push({
      code: 'eyes-closed',
      detail: `eyes closed ${round(s.eyeMin)}${which} (threshold ${t.eyes})`,
      score: round(s.eyeMin),
      threshold: t.eyes,
    });
  }

  if (t.enableExposure && s.exposure < t.exposure) {
    reasons.push({
      code: 'exposure',
      detail: `exposure ${round(s.exposure)} (threshold ${t.exposure})`,
      score: round(s.exposure),
      threshold: t.exposure,
    });
  }

  const isKeeper = group === null || group.keeperId === record.file.relPath;
  if (t.enableDuplicates && group !== null && !isKeeper) {
    reasons.push({
      code: 'duplicate',
      detail: `burst duplicate — ${group.memberIds.length} similar, keeping ${group.keeperId}`,
      score: 0,
      threshold: 0,
    });
  }

  return {
    id: record.file.relPath,
    verdict: reasons.length > 0 ? 'rejected' : 'good',
    reasons,
    groupId: group?.id ?? null,
    isGroupKeeper: isKeeper,
  };
}

export function decideAll(
  records: PhotoRecord[],
  t: Thresholds,
  groups: BurstGroup[],
): Decision[] {
  const groupOf = new Map<string, BurstGroup>();
  for (const g of groups) for (const id of g.memberIds) groupOf.set(id, g);
  return records.map((r) => decide(r, t, groupOf.get(r.file.relPath) ?? null));
}
