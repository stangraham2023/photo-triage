import { scanDirectory } from '../core/scan.ts';
import { analyzePhoto } from '../core/analyze.ts';
import { clusterBursts } from '../core/cluster.ts';
import { decideAll } from '../core/verdict.ts';
import { PRESETS } from '../core/presets.ts';
import { buildPlan, executePlan, checkFreeSpace } from '../core/apply.ts';
import { summarize, toCsv, toHtml, type Summary } from '../core/report.ts';
import { UnreadableError } from '../core/decode.ts';
import type { MetadataReader } from '../core/metadata.ts';
import type { Decision, FaceDetector, PhotoRecord, PresetName, ScannedFile } from '../core/types.ts';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface RunProgress {
  phase: 'scanning' | 'analysing' | 'copying';
  done: number;
  total: number;
  current: string;
}

export interface RunOptions {
  source: string;
  staging: string;
  review: string;
  preset: PresetName;
  recurse: boolean;
  dryRun: boolean;
  detector: FaceDetector;
  reader: MetadataReader;
  signal?: AbortSignal;
  onProgress?: (p: RunProgress) => void;
}

export interface RunResult {
  summary: Summary;
  groups: number;
  unreadable: number;
  manifestPath: string | null;
  reportDir: string | null;
  cancelled: boolean;
}

export async function runTriage(opts: RunOptions): Promise<RunResult> {
  const t = PRESETS[opts.preset];
  const cancelled = () => opts.signal?.aborted === true;

  opts.onProgress?.({ phase: 'scanning', done: 0, total: 0, current: opts.source });
  const scan = await scanDirectory(opts.source, { recurse: opts.recurse });

  const records: PhotoRecord[] = [];
  const unreadable: ScannedFile[] = [];

  for (const [i, file] of scan.images.entries()) {
    if (cancelled()) break;
    try {
      records.push(await analyzePhoto(file, opts.reader, opts.detector));
    } catch (err) {
      if (err instanceof UnreadableError) unreadable.push(file);
      else throw err;
    }
    opts.onProgress?.({
      phase: 'analysing', done: i + 1, total: scan.images.length, current: file.relPath,
    });
  }

  const groups = clusterBursts(records, t);
  const decisions: Decision[] = decideAll(records, t, groups);
  for (const f of unreadable) {
    decisions.push({ id: f.relPath, verdict: 'unreadable', reasons: [], groupId: null, isGroupKeeper: true });
  }
  const summary = summarize(decisions);

  // Cancelling must leave the destinations exactly as they were. This returns
  // before checkFreeSpace, which would otherwise create the staging folder.
  if (cancelled() || opts.dryRun) {
    return {
      summary, groups: groups.length, unreadable: unreadable.length,
      manifestPath: null, reportDir: null, cancelled: cancelled(),
    };
  }

  const plan = buildPlan(scan.images, decisions, { staging: opts.staging, review: opts.review });
  const space = await checkFreeSpace(plan);
  if (!space.ok) {
    throw new Error(
      `Not enough free space: need ${space.requiredBytes} bytes, ${space.availableBytes} available.`,
    );
  }

  const manifest = await executePlan(plan, (done, total) =>
    opts.onProgress?.({ phase: 'copying', done, total, current: '' }),
  );

  const reportDir = dirname(manifest.manifestPath);
  await mkdir(reportDir, { recursive: true });
  await writeFile(join(reportDir, 'report.csv'), toCsv(records, decisions), 'utf8');
  await writeFile(join(reportDir, 'report.html'), toHtml(records, decisions, summary), 'utf8');

  return {
    summary, groups: groups.length, unreadable: unreadable.length,
    manifestPath: manifest.manifestPath, reportDir, cancelled: false,
  };
}
