# Photo Triage

Sorts a folder of photos into keepers and rejects, flagging blur, bad exposure,
closed eyes, and near-duplicate burst frames. Your source folder is never
modified — everything is copied.

## Status

**Phase 1: analysis engine and CLI.** The desktop application, the review UI
with live threshold sliders, and eye detection arrive in Phase 2.

Eye detection is defined here as an interface with a null implementation, so
CLI runs score blur, exposure and burst duplicates only. Nothing downstream
changes when the real detector lands.

## Requirements

Node 22 or newer.

## Usage

```
npm install
npm run triage -- --source ~/Pictures/shoot --staging ~/Pictures/keep --review ~/Pictures/check
```

| Flag | Meaning |
|---|---|
| `--preset` | `event` (default), `portrait`, or `landscape` |
| `--no-recurse` | Stay in the top folder |
| `--dry-run` | Analyse and report without copying anything |
| `--undo <manifest>` | Reverse a previous run |

Start with `--dry-run`. It prints the full breakdown without touching disk.

Each run writes `manifest.json`, `report.csv`, and `report.html` under
`<staging>/_photo-triage/run-<timestamp>/`. The CSV has one row per photo with
every score, so you can see exactly why a decision was made.

### Presets

| Preset | Behaviour |
|---|---|
| `event` | All checks at balanced thresholds |
| `portrait` | Strict on faces and eyes, lenient on background blur |
| `landscape` | Eye checks off entirely, blur and exposure strict |

## How it decides

Every score is normalised so **higher is better**, and a check fails when its
score falls below its threshold.

- **Blur** — Laplacian variance normalised by local contrast, measured on the
  sharpest region and on each face rather than the whole frame. Scoring the
  whole frame would throw away every portrait with a deliberately soft
  background; normalising by contrast stops fog and snow reading as blur.
- **Exposure** — histogram clipping, mean luminance, and contrast spread.
  Highlights are punished harder than shadows, because clipped highlights are
  unrecoverable while a dark frame can usually be lifted.
- **Bursts** — perceptual hash within a capture-time window. The best frame in
  a group is kept and the rest are flagged as duplicates of it.

A photo whose faces are all sharp with open eyes is kept even if the frame as a
whole reads as blurred. That is the shallow depth-of-field correction, and it
applies only when faces are present.

## Formats

JPEG, PNG, TIFF, WebP, AVIF, HEIC/HEIF, and camera RAW (CR2, CR3, NEF, NRW,
ARW, SRF, SR2, DNG, RAF, ORF, RW2, PEF, SRW). RAW files are analysed via their
largest embedded JPEG preview, which is both far faster than a full RAW decode
and sufficient for defect detection.

HEIC is decoded with `libheif-js`, not `sharp`. Sharp's prebuilt binary ships
libheif *without* the HEVC decoder, so it fails on every iPhone photo — and it
fails with a misleading `bad seek` error that reads like file corruption.

## Safety

- The source folder is opened read-only. Files are copied, never moved.
- Free space is checked before any copying starts.
- Existing files are never overwritten. Identical files are skipped; differing
  ones get a ` (2)` suffix.
- Corrupt or undecodable files go to `<review>/_unreadable/` and appear in the
  report. They are never silently dropped.
- `--undo` removes exactly the files a run created, and leaves alone anything
  whose modification time has changed since — you may have edited it.

## Development

```
npm test
npm run typecheck
```

Test fixtures are generated, not committed, so there are no binaries in git.
The one exception is a 586-byte HEVC-coded HEIC, which is committed as base64
because no cross-platform library can *encode* HEVC to recreate it.

`src/core/` is plain TypeScript with no Electron imports — a test enforces
this — so the engine can be reused by the desktop app in Phase 2 unchanged.
