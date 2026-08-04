import sharp from 'sharp';

// Re-exported so existing callers keep working; the implementation lives in a
// Node-free module because the renderer needs it.
export { hammingDistance } from './hamming.ts';
import type { WorkingImage } from '../types.ts';

const N = 32;   // DCT input size
const K = 8;    // low-frequency block kept

/** Precomputed DCT-II basis: cosTable[u * N + x]. */
const cosTable = (() => {
  const t = new Float64Array(N * N);
  for (let u = 0; u < N; u++) {
    for (let x = 0; x < N; x++) {
      t[u * N + x] = Math.cos(((2 * x + 1) * u * Math.PI) / (2 * N));
    }
  }
  return t;
})();

/** Separable 2D DCT-II. Two passes, O(N^3), ~65k operations at N=32. */
function dct2d(input: Float64Array): Float64Array {
  const rows = new Float64Array(N * N);
  for (let y = 0; y < N; y++) {
    for (let u = 0; u < N; u++) {
      let sum = 0;
      for (let x = 0; x < N; x++) sum += input[y * N + x]! * cosTable[u * N + x]!;
      rows[y * N + u] = sum * (u === 0 ? Math.SQRT1_2 : 1);
    }
  }
  const out = new Float64Array(N * N);
  for (let u = 0; u < N; u++) {
    for (let v = 0; v < N; v++) {
      let sum = 0;
      for (let y = 0; y < N; y++) sum += rows[y * N + u]! * cosTable[v * N + y]!;
      out[v * N + u] = sum * (v === 0 ? Math.SQRT1_2 : 1);
    }
  }
  return out;
}

export async function perceptualHash(img: WorkingImage): Promise<string> {
  const buf = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength);
  const small = await sharp(buf, { raw: { width: img.width, height: img.height, channels: 4 } })
    .greyscale()
    .resize(N, N, { fit: 'fill' })
    .raw()
    .toBuffer();

  const input = new Float64Array(N * N);
  for (let i = 0; i < N * N; i++) input[i] = small[i]!;

  const dct = dct2d(input);

  // Top-left K x K block, excluding the DC term from the median.
  const block: number[] = [];
  for (let y = 0; y < K; y++) for (let x = 0; x < K; x++) block.push(dct[y * N + x]!);

  const forMedian = block.slice(1).sort((a, b) => a - b);
  const mid = forMedian.length >> 1;
  const median = forMedian.length % 2
    ? forMedian[mid]!
    : (forMedian[mid - 1]! + forMedian[mid]!) / 2;

  let hex = '';
  for (let nibble = 0; nibble < 16; nibble++) {
    let v = 0;
    for (let bit = 0; bit < 4; bit++) {
      if (block[nibble * 4 + bit]! > median) v |= 1 << (3 - bit);
    }
    hex += v.toString(16);
  }
  return hex;
}

