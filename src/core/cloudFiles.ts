import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Paths per `stat` invocation, to stay well clear of the argument length limit. */
const BATCH = 400;

export interface BlockStat {
  size: number;
  blocks: number;
}

/**
 * Detection is macOS-only, deliberately.
 *
 * On Windows, Node reports `blocks` as 0 for every file, so the cheap prefilter
 * below would flag an entire library as not downloaded. Windows placeholders
 * need FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS, which Node does not expose; until
 * that is addressed, saying nothing is far better than saying something wrong.
 */
export const CLOUD_DETECTION_SUPPORTED = process.platform === 'darwin';

/**
 * Cheap prefilter: a file with a size but no allocated blocks holds no data.
 *
 * NOT sufficient on its own. A filesystem-compressed file also reports zero
 * blocks — real placeholders on this platform show flags `compressed,dataless`,
 * and treating every compressed file as absent would skip perfectly good
 * photos. Anything this flags must be confirmed by `confirmNotDownloaded`.
 */
export function looksNotDownloaded(s: BlockStat): boolean {
  return s.size > 0 && s.blocks === 0;
}

/** True when macOS reports the `dataless` file flag, which only placeholders carry. */
export function parseDatalessFlags(statOutput: string): Set<string> {
  const out = new Set<string>();
  for (const line of statOutput.split('\n')) {
    const sep = line.indexOf('|');
    if (sep === -1) continue;
    const flags = line.slice(0, sep);
    const path = line.slice(sep + 1);
    if (flags.split(',').includes('dataless')) out.add(path);
  }
  return out;
}

/**
 * Confirms which of the suspected paths are genuinely cloud placeholders.
 *
 * Uses `stat`, which reads metadata only. Opening or reading such a file would
 * make macOS download it — precisely what a user who has offloaded their
 * library does not want to happen behind their back.
 */
export async function confirmNotDownloaded(paths: string[]): Promise<Set<string>> {
  if (!CLOUD_DETECTION_SUPPORTED || paths.length === 0) return new Set();

  const confirmed = new Set<string>();
  for (let i = 0; i < paths.length; i += BATCH) {
    const batch = paths.slice(i, i + BATCH);
    try {
      const { stdout } = await run('stat', ['-f', '%Sf|%N', ...batch]);
      for (const p of parseDatalessFlags(stdout)) confirmed.add(p);
    } catch {
      // A failure here means we could not tell. Leaving the batch unconfirmed
      // treats the files as normal, so at worst they fail later as unreadable —
      // never silently skipped.
    }
  }
  return confirmed;
}
