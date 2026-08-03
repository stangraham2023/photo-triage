# Photo Triage — Design

**Date:** 2026-08-03
**Status:** Approved for planning

## Problem

Sorting a shoot or an event import by hand is slow and mind-numbing. The genuinely unusable frames — someone mid-blink, a shot that missed focus, a badly exposed frame, the four near-identical burst shots where only one is worth keeping — are mechanically identifiable, but finding them means opening every photo.

Photo Triage is a desktop application that scans a folder of photos, scores each one for defects, and splits them into a staging folder of keepers and a review folder of rejects. Every reject is labeled with the reason it was rejected and the score behind it, and every decision can be overridden before anything is written to disk.

## Goals

- Analyze a folder (recursively) of JPEG, PNG, HEIC/HEIF, and camera RAW files.
- Detect four defect classes: blur, closed eyes, bad exposure, and near-duplicate burst frames.
- Present every decision with a human-readable reason and a numeric score.
- Let the user adjust strictness and override individual verdicts before any file operation.
- Copy — never move — into a staging folder and a review folder, mirroring source subfolder structure.
- Run on macOS and Windows as a double-click desktop application with no runtime prerequisites.

## Non-goals

Explicitly out of scope for this version:

- Video files. Non-image files are ignored and reported as skipped.
- Any modification of the source folder. It is read-only, always.
- Photo editing, cropping, or export processing.
- Aesthetic or composition judgment ("is this a *good* photo"). Only mechanical defects.
- Face recognition or identity. Faces are detected and measured, never identified or stored.
- Cloud storage, multi-user access, or network features. The application is fully offline.
- Auto-update. Deferred; the public repository makes it straightforward to add later.

## Users and scale

A handful of known users on their own machines. Typical run is a few hundred to ~2,000 photos of mixed format, with subfolders. Target throughput is 0.3–0.8 seconds per photo on a modern laptop, giving roughly 10 minutes for 1,000 photos.

## Technology

**Electron** with an all-JavaScript analysis stack, built by **electron-builder** into a `.dmg` and an `.exe`.

| Concern | Choice |
|---|---|
| Shell / packaging | Electron, electron-builder |
| UI | React + Vite + TypeScript |
| Image decode & resize | `sharp` (libvips) — JPEG, PNG, TIFF, WebP, AVIF |
| HEIC/HEIF decode | `libheif-js` (WASM) — see R1; `sharp` cannot do this |
| RAW preview + metadata | `exiftool-vendored` (bundles platform binaries, uses `-stay_open` batch mode) |
| Face landmarks & eye state | MediaPipe Tasks Vision `FaceLandmarker`, WASM + WebGL, bundled offline |
| Blur / exposure / hashing | Custom TypeScript over raw pixel buffers |
| Score cache | NDJSON file — deliberately not SQLite, to avoid a second native dependency |
| Tests | Vitest |

Versions verified against the registry on 2026-08-03: `sharp` 0.35.3, `exiftool-vendored` 37.1.0 (ships ExifTool 13.59), `@mediapipe/tasks-vision` 1.0.1, `electron` 43.2.0, `electron-builder` 26.15.3, `vitest` 4.1.10.

### Why this stack

One language and one toolchain across the whole application. `electron-builder` produces both installers from a single configuration, and the only native dependency is `sharp`, which ships prebuilt binaries for macOS arm64/x64 and Windows x64.

The alternative considered was an Electron UI over a bundled Python engine (OpenCV, MediaPipe, rawpy). Python offers a stronger computer-vision ecosystem and genuine RAW decoding, but the sidecar must be built and signed separately on each operating system with no cross-compilation, and the installer grows past 250MB. That packaging cost is paid on every release. The accuracy difference does not justify it for this defect set.

A Tauri/Rust implementation was also considered and rejected: wiring face-landmark models through ONNX in Rust is substantially more work for the same result.

**This decision is contained.** `core/` is a plain TypeScript library with no Electron imports and no I/O beyond what is injected. If the JavaScript eye detection proves too weak in practice, the engine can be replaced without touching the UI.

## Architecture

```
core/                    pure TypeScript, no Electron, fully unit-testable
  scan.ts                walk directory tree -> file list
  metadata.ts            exiftool wrapper -> capture time, orientation, camera, preview
  decode.ts              any supported format -> normalized RGBA working image
  scores/
    blur.ts              Laplacian variance + Tenengrad, tiled and face-weighted
    exposure.ts          histogram statistics
    phash.ts             64-bit perceptual hash + Hamming distance
    faces.ts             FaceDetector interface + result types (no implementation)
  cluster.ts             burst grouping and best-of-group selection
  verdict.ts             scores + thresholds -> verdict + reasons  (PURE)
  apply.ts               copy plan -> execute, manifest, undo
  cache.ts               content-hash keyed score store

main/                    Electron main process
  ipc.ts                 typed channels to the renderer
  orchestrator.ts        run lifecycle, worker pool, cancellation
  dialogs.ts             native folder pickers, recent paths

worker/                  hidden BrowserWindow
  face-worker.ts         MediaPipe FaceLandmarker, queued inference

renderer/                UI
  screens/Setup.tsx
  screens/Progress.tsx
  screens/Review.tsx
  components/            thumbnail grid, reason chips, threshold sliders, zoom view
```

`core/` never imports Electron and never reaches the UI. Every scoring function takes pixels and configuration and returns numbers, so it can be tested against fixture images with no application running.

### The critical structural decision

**Scoring and verdict are separate stages.** Scoring is expensive and happens exactly once per photo. `verdict.ts` is pure arithmetic over cached scores.

This means the strictness sliders in the review screen re-sort all 2,000 photos in milliseconds, with no re-analysis. The user drags the blur threshold and watches photos move between piles in real time. This is what makes the tool trustworthy: the boundary is visible and adjustable rather than hidden inside a black box.

## Pipeline

```
scan -> metadata/preview extract -> decode to working image
     -> score (blur, exposure, faces+eyes, perceptual hash)
     -> cluster bursts -> verdict -> [user review] -> apply
```

**1. Scan.** Walk the source tree, filter by extension, record relative paths. Non-image files are counted and ignored.

**2. Metadata and preview.** One long-lived `exiftool` process in batch mode reads capture time, EXIF orientation, and camera model for every file. For RAW files it also extracts the embedded JPEG preview — analysis runs on the preview, not a full RAW decode, which is both far faster and sufficient for defect detection.

**3. Decode.** `sharp` produces a working image at 1600px on the long edge, auto-rotated per EXIF orientation, cached to `userData/runs/<runId>/`. Detection runs on a 1024px downscale; face crops for the zoom view are taken from the 1600px cache.

**4. Score.** Each check writes a numeric score, independent of any threshold:

- **Blur** — variance-of-Laplacian and a Tenengrad gradient measure on the grayscale working image, normalized by local contrast (a low-contrast scene produces a low Laplacian variance even when perfectly sharp; without normalization, fog and snow read as blur). Computed over an 8×8 tile grid, taking the 90th-percentile tile as the "sharpest region," and separately over each detected face region. Scoring the sharpest region rather than the whole frame is what prevents intentional shallow depth of field from being discarded — this is the failure mode that makes naive blur detectors unusable.
- **Exposure** — histogram clipping percentages at both ends, mean luminance, and contrast spread.
- **Faces and eyes** — MediaPipe `FaceLandmarker` with `outputFaceBlendshapes` and `numFaces: 10`. The `eyeBlinkLeft` / `eyeBlinkRight` blendshapes give per-eye closure directly, cross-checked against an eye-aspect-ratio computed from the eyelid landmarks. A face is ignored as a background stranger when its bounding box width is under 4% of the image's long edge. A photo's eye score is the minimum across all considered faces — one person blinking in a group shot is exactly the case this exists to catch. Nothing about a face is persisted beyond the numeric scores and a bounding box.
- **Perceptual hash** — 32×32 DCT reduced to a 64-bit hash for duplicate detection.

**Score direction convention.** Every score is normalized so that **higher is better** — a high blur score means sharp, a high exposure score means well exposed, a high eye score means open. A check fails when its score falls *below* its threshold. This convention holds throughout the codebase, the reason chips, and the CSV report, so a reader never has to remember which way a particular number runs.

**5. Cluster.** Photos are grouped into bursts when their hashes are within a Hamming distance of 10 *and* their capture times fall within a 10-second window (both configurable). Within a group, the keeper is the member with the highest **combined quality score**: the weighted mean of the sharpest-region blur score (weight 3), the minimum eye score across detected faces (weight 3), the face sharpness score (weight 2), and the exposure score (weight 1). Weights favor the two defects a viewer notices first. When a group has no faces, the eye and face-sharpness terms drop out and the remaining weights renormalize. Ties are broken by the earlier capture time. The rest of the group is marked as duplicates of the keeper.

**6. Verdict.** Pure function over scores and the active threshold profile. A photo is rejected if any enabled check fails, and carries the full list of failed checks as reasons.

One special rule — **face-aware promotion**: if every detected face has open eyes and passes the face-sharpness threshold, a global blur failure is downgraded to a warning and the photo stays in the keeper pile. This is the shallow depth-of-field correction, and it applies only when faces are present.

**7. Review.** See below. Nothing has touched the destination folders up to this point.

**8. Apply.** Execute the copy plan, write the manifest and reports.

## Screens

**Setup.** Native folder pickers for source, staging, and review destinations, remembered between runs. A preset selector, and a recurse-subfolders toggle (on by default).

Three presets ship:

| Preset | Behavior |
|---|---|
| Event | All four checks enabled at balanced thresholds. The default. |
| Portrait | Strict on eyes and face sharpness, lenient on global blur. |
| Landscape | Eye checks disabled entirely; blur and exposure strict. |

**Progress.** Live count, current filename, a running tally per reason, and a cancel button. Cancellation is checked between files and is always safe: completed work stays in the cache.

**Review.** A virtualized thumbnail grid split into Good and Rejected. Every reject carries a chip stating why, with the number behind it — `eyes closed · face 2 of 4 · 0.91`, `blur 34 (threshold 60)`, `burst duplicate — 3 similar, this one 2nd sharpest`. Clicking a photo opens a large view with a 100% crop of the relevant face, so a blink call can actually be verified rather than trusted. Burst groups collapse into a single expandable stack.

Threshold sliders sit alongside the grid and re-filter instantly. Arrow keys navigate, `G` and `R` flip a verdict, space zooms.

An Apply button shows the final counts. **Nothing is written to disk until it is pressed.**

## Output

```
<staging>/<mirrored subpath>/<filename>
<review>/<mirrored subpath>/<filename>
<review>/_unreadable/<filename>
<staging>/_photo-triage/run-<ISO timestamp>/
    manifest.json      every copy performed, for undo
    report.csv         one row per photo: path, verdict, every score, reasons
    report.html        readable summary with thumbnails
```

Source subfolder structure is mirrored in both destinations, so an import organized by date stays organized by date.

## Safety and error handling

- **The source folder is opened read-only and never modified.** Files are copied, never moved.
- **Undo.** The manifest records every copy. Undo deletes exactly those files, verifying size and modification time first so a file the user has since edited is left alone, then removes the directories it created if they are empty. It never touches the source.
- **Free space** is checked before copying: total bytes to copy plus 5% headroom against available space on each destination volume. If it fails, nothing is copied and the shortfall is reported.
- **Filename collisions** never overwrite. If the destination file is byte-identical the copy is skipped and noted; otherwise a ` (2)` suffix is appended.
- **Unreadable or corrupt files** go to a third `_unreadable` bucket and appear in the report. They are never silently dropped.
- **No faces detected** is not a rejection reason. The eye check is simply skipped; blur and exposure still apply.
- **exiftool failure on a specific file** flags that file as unsupported and the run continues.
- **Cancellation** mid-run leaves the destinations untouched and the cache intact.

## Score cache

Files are keyed by a fast partial content hash — file size, modification time, and a SHA-256 of the first and last 64KB. Scores are appended as NDJSON to `userData/score-cache.ndjson` and loaded into memory at startup. Re-running a folder skips analysis for unchanged files and returns in seconds.

NDJSON rather than SQLite is a deliberate choice: at this scale a flat file is fast enough, and it avoids adding a second native dependency to the packaging story.

## Testing

A fixture set of small labeled images committed to the repository: sharp and blurry pairs of the same scene, open and closed eyes, blown and crushed exposure, a burst sequence, one deliberately corrupt file, and one RAW file.

- **Unit tests** assert each scoring function against fixtures with known expected ranges. These are pure functions over pixels — deterministic, no I/O.
- **Verdict tests** exhaustively cover threshold behavior, the face-aware promotion rule, and preset differences. Because `verdict.ts` is pure, this needs no images at all.
- **Apply tests** run against a temporary directory and verify the output tree, collision handling, manifest correctness, and undo.
- **An integration test** runs the full pipeline over the fixture folder and asserts the resulting split.

## Distribution

GitHub Actions on a matrix of `macos-latest` and `windows-latest`, each building its own target, attaching the `.dmg` (arm64 and x64) and `.exe` to a GitHub Release on tag push. Expect 120–180MB per installer.

Version 1 ships **unsigned**. On macOS the first launch requires approving the app in System Settings → Privacy & Security; on Windows SmartScreen requires *More info* → *Run anyway*. Both are documented in the README with screenshots.

The release workflow includes the macOS notarization and Windows signing steps from the start, conditioned on certificate secrets being present, so they are inert until secrets are added. Enabling signing later is a configuration change, not a rework.

## Risks

**R1 — HEIC decode — RESOLVED 2026-08-03, spike performed.** `sharp` 0.35.3 **cannot decode HEIC pixels.** Its prebuilt binary bundles libheif 1.23.1 with the AV1 decoder (so AVIF works) but *without* libde265, so HEVC-coded HEIC — which is what every iPhone produces — fails. It reads HEIC metadata happily and reports `compression: 'hevc'`, then throws an unhelpful `bad seek to 1024` on pixel access. The misleading error matters: an implementer would waste hours reading it as file corruption rather than a missing codec.

Resolution: HEIC and HEIF route to **`libheif-js`** (`libheif-js/wasm-bundle`), verified decoding a real HEVC-coded HEIC to correct RGBA. This is a pure-WASM package with no native dependency and no platform-specific build, so it costs nothing in packaging. It is slower than libvips, which is acceptable because HEIC is one format among several and analysis runs on a downscale.

Note for awareness rather than action: HEVC decoding carries patent considerations. Bundling a WASM HEVC decoder in a freely distributed application is common practice, but it is worth knowing that it exists.

**R2 — RAW embedded preview quality varies by camera.** Some bodies embed a full-resolution JPEG, others a small one, a few none at all. Mitigation: accept any preview at or above 1024px on the long edge; below that, fall back to the largest available and record reduced confidence in the report; with no preview at all, mark the file unsupported.

**R3 — MediaPipe accuracy on small or profile faces.** Eye state on a face turned away from the camera is unreliable. Mitigation: the 4% minimum face size, and a confidence value carried into the reason chip so the user sees when a call is marginal.

**R4 — Packaging native and binary assets.** `sharp` and the bundled exiftool binaries must be excluded from the asar archive via `asarUnpack`. Partially de-risked by the same spike: `@mediapipe/tasks-vision` ships its WASM files inside the package (`node_modules/@mediapipe/tasks-vision/wasm/`), so `FilesetResolver` can be pointed at a local directory and never touches a CDN. The `face_landmarker.task` model file is *not* in the package and must be vendored into the repository under `assets/models/` rather than fetched at runtime. Verified by a smoke test that runs the packaged application, not just the development build.

**R5 — Threshold defaults.** Shipped defaults are a starting point and will be wrong for some libraries. Mitigated structurally: the live threshold sliders mean the user can correct them per run without waiting for a re-analysis.

## Build phases

1. **Core library and a CLI harness.** Scan, metadata, decode, all scoring, cluster, verdict, apply — with the fixture test suite. No Electron. Resolves R1 and R2 first.
2. **Electron shell.** Setup and Progress screens, orchestrator, worker pool, cancellation, the face worker.
3. **Review screen.** Grid, reason chips, zoom and face crops, live threshold sliders, overrides, burst stacks, keyboard navigation.
4. **Reports, undo, cache, presets.**
5. **CI, installers, README, release.**

## Future

Deliberately deferred, in rough priority order: XMP sidecar output so Lightroom and Capture One read the verdicts as ratings without any copying; auto-update via `electron-updater`; code signing and notarization; video passthrough.
