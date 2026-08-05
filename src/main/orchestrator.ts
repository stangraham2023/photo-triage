import { scanDirectory } from '../core/scan.ts';
import { analyzePhoto } from '../core/analyze.ts';
import { clusterBursts, type BurstGroup } from '../core/cluster.ts';
import { PRESETS } from '../core/presets.ts';
import { buildPlan, executePlan, checkFreeSpace } from '../core/apply.ts';
import { summarize, toCsv, toHtml } from '../core/report.ts';
import { UnreadableError } from '../core/decode.ts';
import type { MetadataReader } from '../core/metadata.ts';
import type {
  Decision, FaceDetector, PhotoRecord, PresetName, ScannedFile,
} from '../core/types.ts';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { writeThumbnail, thumbPathFor } from './thumbnails.ts';

export interface RunProgress {
  phase: 'scanning' | 'analysing' | 'copying';
  done: number;
  total: number;
  current: string;
}

export interface AnalyzeOptions {
  source: string;
  preset: PresetName;
  recurse: boolean;
  detector: FaceDetector;
  reader: MetadataReader;
  /** Root under which each run gets its own thumbnail directory. */
  thumbRoot: string;
  signal?: AbortSignal;
  onProgress?: (p: RunProgress) => void;
}

export interface AnalysisResult {
  runId: string;
  records: PhotoRecord[];
  unreadable: ScannedFile[];
  /** Cloud placeholders. Never opened, because opening one downloads it. */
  notDownloaded: ScannedFile[];
  groups: BurstGroup[];
  cancelled: boolean;
}

export interface ApplyOptions {
  runId: string;
  files: ScannedFile[];
  records: PhotoRecord[];
  decisions: Decision[];
  staging: string;
  review: string;
  onProgress?: (p: RunProgress) => void;
}

export interface ApplyResult {
  manifestPath: string;
  reportDir: string;
  copied: number;
  skipped: number;
}

function makeRunId(now: Date): string {
  return `run-${now.toISOString().replace(/[:.]/g, '-')}`;
}

/**
 * Analyses a folder and writes NOTHING to the destinations.
 *
 * Separating this from applyDecisions is what makes the review gate real: after
 * this returns, the user can change any verdict, and the decisions that reach
 * disk are the ones they approved rather than the ones this computed.
 */
export async function analyzeRun(opts: AnalyzeOptions): Promise<AnalysisResult> {
  const t = PRESETS[opts.preset];
  const cancelled = () => opts.signal?.aborted === true;
  const runId = makeRunId(new Date());
  const thumbDir = join(opts.thumbRoot, runId);

  opts.onProgress?.({ phase: 'scanning', done: 0, total: 0, current: opts.source });
  const scan = await scanDirectory(opts.source, { recurse: opts.recurse });

  const records: PhotoRecord[] = [];
  const unreadable: ScannedFile[] = [];
  const notDownloaded: ScannedFile[] = [];

  for (const [i, file] of scan.images.entries()) {
    if (cancelled()) break;
    // Skipped before any read: touching a placeholder makes macOS fetch it,
    // which for an offloaded library could mean gigabytes the user never asked
    // to download.
    if (!file.onDisk) {
      notDownloaded.push(file);
      opts.onProgress?.({
        phase: 'analysing', done: i + 1, total: scan.images.length, current: file.relPath,
      });
      continue;
    }
    try {
      records.push(await analyzePhoto(file, opts.reader, opts.detector, {
        onWorkingImage: (img) => writeThumbnail(img, thumbPathFor(thumbDir, file.relPath)),
      }));
    } catch (err) {
      if (err instanceof UnreadableError) unreadable.push(file);
      else throw err;
    }
    opts.onProgress?.({
      phase: 'analysing', done: i + 1, total: scan.images.length, current: file.relPath,
    });
  }

  return {
    runId,
    records,
    unreadable,
    notDownloaded,
    groups: clusterBursts(records, t),
    cancelled: cancelled(),
  };
}

/**
 * Copies according to the decisions it is handed.
 *
 * It deliberately does not recompute them: by this point the user may have
 * overridden any of them, and recomputing would silently discard those edits.
 */
export async function applyDecisions(opts: ApplyOptions): Promise<ApplyResult> {
  const plan = buildPlan(opts.files, opts.decisions, {
    staging: opts.staging,
    review: opts.review,
  }, new Date());

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
  const summary = summarize(opts.decisions);
  await mkdir(reportDir, { recursive: true });
  await writeFile(join(reportDir, 'report.csv'), toCsv(opts.records, opts.decisions), 'utf8');
  await writeFile(join(reportDir, 'report.html'), toHtml(opts.records, opts.decisions, summary), 'utf8');

  return {
    manifestPath: manifest.manifestPath,
    reportDir,
    copied: manifest.operations.length,
    skipped: manifest.skipped,
  };
}
