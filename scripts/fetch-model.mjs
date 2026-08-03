import { createHash } from 'node:crypto';
import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEST = join(ROOT, 'assets', 'models', 'face_landmarker.task');

// Version-pinned URL, checksum-verified download. A changed or corrupted
// upstream file fails loudly rather than silently degrading eye detection.
const URL_ = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
const SHA256 = '64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff';

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

async function main() {
  try {
    await access(DEST);
    const existing = await readFile(DEST);
    if (sha(existing) === SHA256) {
      console.log('face_landmarker.task already present and verified.');
      return;
    }
    console.log('Existing model failed checksum; re-downloading.');
  } catch {
    // not present yet
  }

  console.log(`Downloading ${URL_}`);
  const res = await fetch(URL_);
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());

  const actual = sha(buf);
  if (actual !== SHA256) {
    throw new Error(`Checksum mismatch.\n  expected ${SHA256}\n  actual   ${actual}`);
  }

  await mkdir(dirname(DEST), { recursive: true });
  await writeFile(DEST, buf);
  console.log(`Wrote ${DEST} (${buf.length} bytes, checksum verified).`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
