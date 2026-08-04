import type { Decision, PhotoId, PhotoRecord, PresetName, ScannedFile } from '../core/types.ts';
import type { BurstGroup } from '../core/cluster.ts';
import type { RunProgress, ApplyResult } from '../main/orchestrator.ts';

export type FolderKind = 'source' | 'staging' | 'review';

export interface RunConfig {
  source: string;
  staging: string;
  review: string;
  preset: PresetName;
  recurse: boolean;
}

export interface AnalysisPayload {
  runId: string;
  /** Thumbnail URL per photo id, built in the main process. */
  thumbUrls: Record<PhotoId, string>;
  records: PhotoRecord[];
  unreadable: ScannedFile[];
  groups: BurstGroup[];
  cancelled: boolean;
}

export interface ApplyPayload {
  runId: string;
  decisions: Decision[];
}

export interface TriageApi {
  pickFolder(kind: FolderKind): Promise<string | null>;
  /** Analyses only. Writes nothing to the destination folders. */
  startAnalysis(cfg: RunConfig): Promise<AnalysisPayload>;
  /** Copies according to the decisions given, after the user has approved them. */
  applyDecisions(payload: ApplyPayload): Promise<ApplyResult>;
  cancelRun(): void;
  /** Returns an unsubscribe function. */
  onProgress(cb: (p: RunProgress) => void): () => void;
}

export const CHANNELS = {
  pickFolder: 'triage:pickFolder',
  startAnalysis: 'triage:startAnalysis',
  applyDecisions: 'triage:applyDecisions',
  cancelRun: 'triage:cancelRun',
  progress: 'triage:progress',
} as const;

declare global {
  interface Window {
    triage: TriageApi;
  }
}
