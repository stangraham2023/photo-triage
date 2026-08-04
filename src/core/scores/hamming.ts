/**
 * Split out of phash.ts so that cluster.ts — and therefore the verdict chain —
 * can be imported by the renderer. phash.ts needs sharp to downscale an image
 * before hashing it; comparing two finished hashes is pure arithmetic and must
 * stay that way, because the renderer re-clusters on every slider drag.
 */
export function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length) throw new Error(`hash length mismatch: ${a.length} vs ${b.length}`);
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i]!, 16) ^ parseInt(b[i]!, 16);
    while (x) { d += x & 1; x >>= 1; }
  }
  return d;
}
