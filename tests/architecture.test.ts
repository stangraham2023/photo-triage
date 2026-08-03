import { describe, it, expect } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...await walk(p));
    else if (e.name.endsWith('.ts')) out.push(p);
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
