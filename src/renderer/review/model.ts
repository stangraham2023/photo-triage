import { decideAll } from '../../core/verdict.ts';
import { clusterBursts } from '../../core/cluster.ts';
import type { Decision, PhotoId, Thresholds, Verdict } from '../../core/types.ts';
import type { BurstGroup } from '../../core/cluster.ts';
import type { AnalysisPayload } from '../../shared/contract.ts';

export interface ReviewState {
  payload: AnalysisPayload;
  thresholds: Thresholds;
  /**
   * The groups these decisions were built from. Kept here rather than read back
   * off the payload: changing the duplicate slider re-clusters, so the payload's
   * original groups go stale the moment the user touches it.
   */
  groups: BurstGroup[];
  /** Manual verdicts that win over anything the thresholds compute. */
  overrides: Map<PhotoId, Verdict>;
  /** Computed from thresholds, before overrides are applied. */
  decisions: Decision[];
}

/**
 * Unreadable photos have no scores to threshold, and calling them "good" would
 * put a file that cannot be decoded into the keepers pile.
 */
/** Neither an undecodable file nor an absent one can be argued into a keeper. */
function isFixed(state: { payload: AnalysisPayload }, id: PhotoId): boolean {
  return state.payload.unreadable.some((f) => f.relPath === id)
    || state.payload.notDownloaded.some((f) => f.relPath === id);
}

function fixedDecisions(payload: AnalysisPayload): Decision[] {
  return [
    ...payload.unreadable.map((f) => ({
      id: f.relPath, verdict: 'unreadable' as const,
      reasons: [], groupId: null, isGroupKeeper: true,
    })),
    ...payload.notDownloaded.map((f) => ({
      id: f.relPath, verdict: 'not-downloaded' as const,
      reasons: [], groupId: null, isGroupKeeper: true,
    })),
  ];
}

/**
 * Re-clusters and re-decides from the cached scores.
 *
 * This is the whole point of keeping verdict and cluster pure: it runs in the
 * renderer on every slider drag, over all the photos, with no IPC and no
 * re-analysis. Overrides are held separately and reapplied, so moving a slider
 * never silently discards a decision the user made by hand.
 */
export function recompute(
  payload: AnalysisPayload,
  thresholds: Thresholds,
  overrides: Map<PhotoId, Verdict> = new Map(),
): ReviewState {
  const groups = thresholds.enableDuplicates
    ? clusterBursts(payload.records, thresholds)
    : [];
  const decisions = [
    ...decideAll(payload.records, thresholds, groups),
    ...fixedDecisions(payload),
  ];
  return { payload, thresholds, groups, overrides: new Map(overrides), decisions };
}

export function buildReviewState(payload: AnalysisPayload, thresholds: Thresholds): ReviewState {
  return recompute(payload, thresholds);
}

export function applyOverride(state: ReviewState, id: PhotoId, verdict: Verdict): ReviewState {
  if (isFixed(state, id)) return state;
  const overrides = new Map(state.overrides);
  overrides.set(id, verdict);
  return { ...state, overrides };
}

export function clearOverride(state: ReviewState, id: PhotoId): ReviewState {
  if (!state.overrides.has(id)) return state;
  const overrides = new Map(state.overrides);
  overrides.delete(id);
  return { ...state, overrides };
}

/**
 * The decisions that would reach disk. Overridden photos keep their original
 * reasons so the UI can still show why they *were* flagged.
 */
export function effectiveDecisions(state: ReviewState): Decision[] {
  return state.decisions.map((d) => {
    const override = state.overrides.get(d.id);
    return override === undefined || override === d.verdict ? d : { ...d, verdict: override };
  });
}

export function isOverridden(state: ReviewState, id: PhotoId): boolean {
  const override = state.overrides.get(id);
  if (override === undefined) return false;
  return state.decisions.find((d) => d.id === id)?.verdict !== override;
}

export interface ReviewCounts {
  good: number;
  rejected: number;
  unreadable: number;
  notDownloaded: number;
  overridden: number;
}

export function counts(state: ReviewState): ReviewCounts {
  const c: ReviewCounts = { good: 0, rejected: 0, unreadable: 0, notDownloaded: 0, overridden: 0 };
  for (const d of effectiveDecisions(state)) {
    if (d.verdict === 'good') c.good++;
    else if (d.verdict === 'rejected') c.rejected++;
    else if (d.verdict === 'not-downloaded') c.notDownloaded++;
    else c.unreadable++;
    if (isOverridden(state, d.id)) c.overridden++;
  }
  return c;
}
