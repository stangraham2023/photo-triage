# Photo Triage

Sorts a folder of photos into keepers and rejects, flagging blur, bad exposure,
closed eyes, and near-duplicate burst frames. Your source folder is never
modified — everything is copied.

## Status

**Desktop app with eye detection and a review screen — working.**

Pick your folders and the app analyses them, writing nothing. You then see every
photo with the reason it was flagged and the score behind it, drag sliders to
move the line, click into any photo for a 100% crop of each detected face, and
override anything you disagree with. **Nothing is copied until you press Apply.**

Still to come: packaged installers for Mac and PC.

## Requirements

Node 22 or newer. `npm install` downloads the face-detection model
(3.7MB, checksum-verified), so the first install needs a network connection.

## The desktop app

```
npm install
npm run dev
```

This is the one that detects closed eyes.

## The command line

```
npm run triage -- --source ~/Pictures/shoot --staging ~/Pictures/keep --review ~/Pictures/check
```

The CLI scores blur, exposure and burst duplicates but **not** eyes. MediaPipe
requires a browser DOM — it throws `document is not defined` under plain Node —
so eye detection only runs in the desktop app, which has one.

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

## The review screen

The strictness sliders re-sort every photo the instant you drag them. That works
because scoring and judging are separate stages: scoring is the expensive part
and runs once, while turning scores into verdicts is pure arithmetic that runs
in the window itself. So you can watch the boundary move across two thousand
photos in real time instead of arguing with a number you cannot see.

Overrides survive slider changes. If you rescue a photo by hand and then move a
threshold, your decision stands.

Clicking a photo opens a crop of each face it found, captioned with that face's
eye score, and marks a call as *unsure* when the two eye measurements disagree.
An eye verdict you cannot check is one you cannot trust.

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
- **Eyes** — MediaPipe's per-eye blink signal, cross-checked against eyelid
  geometry. A face takes the worse of its two eyes and a photo takes the worst
  face in the frame, so one person blinking in a group of six decides it.
  Openness is a continuous 0–1 score rather than a yes/no, so where "partially
  closed" becomes a reject is set by the preset: `event` cuts at 0.35 (clearly
  shut), `portrait` at 0.5 (also catches half-lidded). Faces narrower than 4% of
  the frame are ignored as background strangers.
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
this — so the same engine backs both the CLI and the desktop app.

Eye-detection *accuracy* is not covered by any automated test, and cannot be:
MediaPipe needs a browser, and verifying a blink detector requires photographs
of real people, which do not belong in a public repository. The test suite
proves the pipeline is wired end to end (`SMOKE_OK faces=0` on a blank image);
only real photos show whether it is right.
