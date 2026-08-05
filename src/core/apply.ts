import { copyFile, mkdir, readFile, writeFile, stat, unlink, statfs } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, extname, basename } from 'node:path';
import type { Decision, ScannedFile, PhotoId } from './types.ts';

export interface Destinations {
  staging: string;
  review: string;
}

export interface CopyOp {
  id: PhotoId;
  from: string;
  to: string;
  bytes: number;
}

export interface CopyPlan {
  ops: CopyOp[];
  dests: Destinations;
  runId: string;
}

export interface ManifestEntry {
  from: string;
  to: string;
  bytes: number;
  mtimeMs: number;
}

export interface Manifest {
  runId: string;
  createdAt: string;
  manifestPath: string;
  operations: ManifestEntry[];
  skipped: number;
}

export interface UndoResult {
  removed: number;
  skipped: number;
}

/** Deterministic, filesystem-safe run identifier. */
function makeRunId(now: Date): string {
  return `run-${now.toISOString().replace(/[:.]/g, '-')}`;
}

/**
 * Takes the scanned files rather than analysed records on purpose: planning a
 * copy needs only a path and a size, and unreadable files never get a record.
 * Demanding records here would force callers to fabricate empty ones.
 */
export function buildPlan(
  files: ScannedFile[],
  decisions: Decision[],
  dests: Destinations,
  now: Date = new Date(),
): CopyPlan {
  const byId = new Map(files.map((f) => [f.relPath, f]));
  const ops: CopyOp[] = [];

  for (const d of decisions) {
    const file = byId.get(d.id);
    if (!file) continue;
    // Copying a cloud placeholder would force it to download, then write a copy
    // of a file the user chose to keep off their disk. Leave it where it is.
    if (d.verdict === 'not-downloaded' || !file.onDisk) continue;
    const root =
      d.verdict === 'good' ? dests.staging
      : d.verdict === 'unreadable' ? join(dests.review, '_unreadable')
      : dests.review;
    ops.push({
      id: d.id,
      from: file.absPath,
      to: join(root, d.verdict === 'unreadable' ? basename(d.id) : d.id),
      bytes: file.bytes,
    });
  }
  return { ops, dests, runId: makeRunId(now) };
}

export async function checkFreeSpace(
  plan: CopyPlan,
): Promise<{ ok: boolean; requiredBytes: number; availableBytes: number }> {
  const requiredBytes = Math.ceil(plan.ops.reduce((a, o) => a + o.bytes, 0) * 1.05);
  await mkdir(plan.dests.staging, { recursive: true });
  const fs = await statfs(plan.dests.staging);
  const availableBytes = Number(fs.bavail) * Number(fs.bsize);
  return { ok: availableBytes >= requiredBytes, requiredBytes, availableBytes };
}

async function sha256(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

/** Never overwrite. Returns null when an identical file is already there. */
async function resolveTarget(to: string, from: string): Promise<string | null> {
  let candidate = to;
  let n = 1;
  for (;;) {
    try {
      await stat(candidate);
    } catch {
      return candidate; // free
    }
    if ((await sha256(candidate)) === (await sha256(from))) return null;
    n++;
    const ext = extname(to);
    candidate = join(dirname(to), `${basename(to, ext)} (${n})${ext}`);
  }
}

export async function executePlan(
  plan: CopyPlan,
  onProgress?: (done: number, total: number) => void,
): Promise<Manifest> {
  const operations: ManifestEntry[] = [];
  let skipped = 0;

  for (const [i, op] of plan.ops.entries()) {
    await mkdir(dirname(op.to), { recursive: true });
    const target = await resolveTarget(op.to, op.from);
    if (target === null) {
      skipped++;
    } else {
      await copyFile(op.from, target);
      const s = await stat(target);
      operations.push({ from: op.from, to: target, bytes: op.bytes, mtimeMs: s.mtimeMs });
    }
    onProgress?.(i + 1, plan.ops.length);
  }

  const runDir = join(plan.dests.staging, '_photo-triage', plan.runId);
  await mkdir(runDir, { recursive: true });
  const manifestPath = join(runDir, 'manifest.json');
  const manifest: Manifest = {
    runId: plan.runId,
    createdAt: new Date().toISOString(),
    manifestPath,
    operations,
    skipped,
  };
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  return manifest;
}

/**
 * Removes exactly the files this run created. A file whose modification time has
 * changed since the copy is left alone — the user may have edited it.
 */
export async function undo(manifestPath: string): Promise<UndoResult> {
  const manifest: Manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  let removed = 0, skipped = 0;

  for (const op of manifest.operations) {
    try {
      const s = await stat(op.to);
      if (Math.abs(s.mtimeMs - op.mtimeMs) > 1) { skipped++; continue; }
      await unlink(op.to);
      removed++;
    } catch {
      skipped++;
    }
  }
  return { removed, skipped };
}
