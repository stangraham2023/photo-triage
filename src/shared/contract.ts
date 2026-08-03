import type { PresetName } from '../core/types.ts';
import type { RunProgress, RunResult } from '../main/orchestrator.ts';

export type FolderKind = 'source' | 'staging' | 'review';

export interface RunConfig {
  source: string;
  staging: string;
  review: string;
  preset: PresetName;
  recurse: boolean;
  dryRun: boolean;
}

export interface TriageApi {
  pickFolder(kind: FolderKind): Promise<string | null>;
  startRun(cfg: RunConfig): Promise<RunResult>;
  cancelRun(): void;
  /** Returns an unsubscribe function. */
  onProgress(cb: (p: RunProgress) => void): () => void;
}

export const CHANNELS = {
  pickFolder: 'triage:pickFolder',
  startRun: 'triage:startRun',
  cancelRun: 'triage:cancelRun',
  progress: 'triage:progress',
} as const;

declare global {
  interface Window {
    triage: TriageApi;
  }
}
