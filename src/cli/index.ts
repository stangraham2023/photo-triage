import { parseArgs } from 'node:util';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { scanDirectory } from '../core/scan.ts';
import { MetadataReader } from '../core/metadata.ts';
import { NullFaceDetector } from '../core/scores/faces.ts';
import { analyzeAll } from '../core/analyze.ts';
import { clusterBursts } from '../core/cluster.ts';
import { decideAll } from '../core/verdict.ts';
import { PRESETS } from '../core/presets.ts';
import { buildPlan, executePlan, checkFreeSpace, undo } from '../core/apply.ts';
import { toCsv, toHtml, summarize } from '../core/report.ts';
import type { Decision, PresetName } from '../core/types.ts';

const USAGE = `
photo-triage — sort photos by defect

  --source <dir>     folder to scan (required)
  --staging <dir>    where keepers are copied (required)
  --review <dir>     where rejects are copied (required)
  --preset <name>    event | portrait | landscape   (default: event)
  --no-recurse       do not descend into subfolders
  --dry-run          analyse and report, copy nothing
  --undo <manifest>  reverse a previous run

The source folder is opened read-only. Photos are copied, never moved.

Note: eye detection is not available in the CLI. It requires the Electron
renderer and arrives in Phase 2; runs here score blur, exposure and duplicates.
`;

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      source: { type: 'string' },
      staging: { type: 'string' },
      review: { type: 'string' },
      preset: { type: 'string', default: 'event' },
      'no-recurse': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      undo: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  if (values.help) { console.log(USAGE); return 0; }

  if (values.undo) {
    const r = await undo(values.undo);
    console.log(`Undo complete: ${r.removed} removed, ${r.skipped} left in place.`);
    return 0;
  }

  const { source, staging, review } = values;
  if (!source || !staging || !review) {
    console.error('Error: --source, --staging and --review are all required.');
    console.error(USAGE);
    return 2;
  }
  if (!(values.preset! in PRESETS)) {
    console.error(`Error: unknown preset "${values.preset}". Use event, portrait or landscape.`);
    return 2;
  }
  const thresholds = PRESETS[values.preset as PresetName];

  const reader = new MetadataReader();
  try {
    const scan = await scanDirectory(source, { recurse: !values['no-recurse'] });
    console.log(`Found ${scan.images.length} images (${scan.skipped} non-image files ignored).`);
    if (scan.notDownloaded > 0) {
      console.log(
        `  ${scan.notDownloaded} are stored in the cloud and not on this Mac — skipping them.\n` +
        '  Select them in Finder and choose "Download Now" to include them.',
      );
    }
    if (scan.images.length === 0) return 0;

    const { records, unreadable } = await analyzeAll(
      scan.images.filter((f) => f.onDisk), reader, new NullFaceDetector(),
      (done, total, current) => {
        process.stdout.write(`\r  analysing ${done}/${total}  ${current.slice(0, 50).padEnd(50)}`);
      },
    );
    process.stdout.write('\n');

    const groups = clusterBursts(records, thresholds);
    const decisions: Decision[] = decideAll(records, thresholds, groups);
    for (const f of unreadable) {
      decisions.push({ id: f.relPath, verdict: 'unreadable', reasons: [], groupId: null, isGroupKeeper: true });
    }
    for (const f of scan.images.filter((x) => !x.onDisk)) {
      decisions.push({ id: f.relPath, verdict: 'not-downloaded', reasons: [], groupId: null, isGroupKeeper: true });
    }

    const summary = summarize(decisions);
    console.log(
      `\n  ${summary.good} good, ${summary.rejected} rejected, ` +
      `${summary.unreadable} unreadable, ${summary.notDownloaded} not downloaded`,
    );
    for (const [reason, count] of Object.entries(summary.byReason)) {
      console.log(`    ${reason}: ${count}`);
    }
    console.log(`  ${groups.length} burst group(s) detected`);

    const plan = buildPlan(scan.images, decisions, { staging, review });

    if (values['dry-run']) {
      console.log('\nDry run — nothing copied.');
      return 0;
    }

    const space = await checkFreeSpace(plan);
    if (!space.ok) {
      console.error(`Not enough free space: need ${space.requiredBytes} bytes, have ${space.availableBytes}.`);
      return 1;
    }

    const manifest = await executePlan(plan);
    const runDir = join(staging, '_photo-triage', manifest.runId);
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, 'report.csv'), toCsv(records, decisions), 'utf8');
    await writeFile(join(runDir, 'report.html'), toHtml(records, decisions, summary), 'utf8');

    console.log(`\nCopied ${manifest.operations.length} files (${manifest.skipped} already present).`);
    console.log(`Reports: ${runDir}`);
    console.log(`Undo:    npm run triage -- --undo "${manifest.manifestPath}"`);
    return 0;
  } finally {
    await reader.close();
  }
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error(err);
  process.exit(1);
});
