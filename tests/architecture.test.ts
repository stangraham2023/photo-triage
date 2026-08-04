import { describe, it, expect } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...await walk(p));
    else if (e.name.endsWith('.ts') || e.name.endsWith('.tsx')) out.push(p);
  }
  return out;
}

describe('core isolation', () => {
  it('never imports electron or UI layers', async () => {
    const offenders: string[] = [];
    for (const file of await walk('src/core')) {
      const src = await readFile(file, 'utf8');
      if (/from\s+['"](electron|\.\.\/(main|renderer|worker))/.test(src)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * Modules the renderer imports directly so it can re-filter 2,000 photos on a
 * slider drag with no IPC. A stray `sharp` import here would not fail the
 * build — it would quietly push re-filtering back onto IPC and make the
 * sliders laggy, which is exactly the kind of regression nobody notices.
 */
const RENDERER_SAFE_ENTRY = ['src/core/verdict.ts', 'src/core/cluster.ts'];
const FORBIDDEN = /from\s+['"](sharp|exiftool-vendored|libheif-js|electron|node:)/;

async function transitiveImports(entry: string, seen = new Set<string>()): Promise<string[]> {
  if (seen.has(entry)) return [];
  seen.add(entry);
  let src: string;
  try {
    src = await readFile(entry, 'utf8');
  } catch {
    return [];
  }
  const out = [entry];
  for (const m of src.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
    out.push(...(await transitiveImports(join(dirname(entry), m[1]!), seen)));
  }
  return out;
}

describe('renderer-safe core', () => {
  it('keeps verdict and cluster free of Node-only dependencies', async () => {
    const offenders: string[] = [];
    for (const entry of RENDERER_SAFE_ENTRY) {
      for (const file of await transitiveImports(entry)) {
        const src = await readFile(file, 'utf8');
        for (const line of src.split('\n')) {
          // `import type` is erased at build time and cannot pull in a runtime dep.
          if (line.includes('import type')) continue;
          if (FORBIDDEN.test(line)) offenders.push(`${file}: ${line.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('renderer-safe UI', () => {
  /**
   * The renderer has no Node. A `node:crypto` import here built fine under
   * Vitest and only exploded at bundle time — this catches it in the suite,
   * where the failure names the file instead of a rollup stack trace.
   */
  it('keeps everything under src/renderer free of Node built-ins', async () => {
    const offenders: string[] = [];
    for (const file of await walk('src/renderer')) {
      const src = await readFile(file, 'utf8');
      for (const line of src.split('\n')) {
        if (line.includes('import type')) continue;
        if (/from\s+['"](node:|sharp|exiftool-vendored|libheif-js|electron)/.test(line)) {
          offenders.push(`${file}: ${line.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
