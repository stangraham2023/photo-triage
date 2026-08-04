import { ipcMain, dialog, app, type BrowserWindow } from 'electron';
import { join } from 'node:path';
import { CHANNELS, type AnalysisPayload, type ApplyPayload, type RunConfig } from '../shared/contract.ts';
import { analyzeRun, applyDecisions, type ApplyResult } from './orchestrator.ts';
import { MetadataReader } from '../core/metadata.ts';
import { IpcFaceDetector } from './faceClient.ts';
import { thumbUrl } from './thumbnails.ts';
import type { PhotoRecord, ScannedFile } from '../core/types.ts';

export function thumbRoot(): string {
  return join(app.getPath('userData'), 'thumbs');
}

export function registerIpc(getWindows: () => { main: BrowserWindow; face: BrowserWindow }) {
  let controller: AbortController | null = null;
  let detector: IpcFaceDetector | null = null;

  // Analysis results are held here between the two calls so the renderer never
  // has to send megabytes of records back just to apply them, and so a
  // malformed reply cannot redirect a copy to an arbitrary path.
  let lastRun: {
    runId: string;
    records: PhotoRecord[];
    files: ScannedFile[];
    staging: string;
    review: string;
  } | null = null;

  ipcMain.handle(CHANNELS.pickFolder, async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(getWindows().main, {
      properties: ['openDirectory', 'createDirectory'],
    });
    return canceled ? null : filePaths[0] ?? null;
  });

  ipcMain.on(CHANNELS.cancelRun, () => controller?.abort());

  ipcMain.handle(CHANNELS.startAnalysis, async (_e, cfg: RunConfig): Promise<AnalysisPayload> => {
    const { main, face } = getWindows();
    controller = new AbortController();
    const reader = new MetadataReader();

    // One detector for the lifetime of the app: a second would register a
    // duplicate face:result listener and re-initialise MediaPipe.
    detector ??= new IpcFaceDetector(face);

    try {
      const result = await analyzeRun({
        source: cfg.source,
        preset: cfg.preset,
        recurse: cfg.recurse,
        detector,
        reader,
        thumbRoot: thumbRoot(),
        signal: controller.signal,
        onProgress: (p) => {
          if (!main.isDestroyed()) main.webContents.send(CHANNELS.progress, p);
        },
      });

      lastRun = {
        runId: result.runId,
        records: result.records,
        files: [...result.records.map((r) => r.file), ...result.unreadable],
        staging: cfg.staging,
        review: cfg.review,
      };

      return {
        runId: result.runId,
        thumbUrls: Object.fromEntries(
          result.records.map((r) => [r.file.relPath, thumbUrl(result.runId, r.file.relPath)]),
        ),
        records: result.records,
        unreadable: result.unreadable,
        groups: result.groups,
        cancelled: result.cancelled,
      };
    } finally {
      // exiftool keeps a child process alive; failing to close it wedges quit.
      await reader.close();
      controller = null;
    }
  });

  ipcMain.handle(CHANNELS.applyDecisions, async (_e, payload: ApplyPayload): Promise<ApplyResult> => {
    if (!lastRun || lastRun.runId !== payload.runId) {
      throw new Error('No analysis to apply. Run an analysis first.');
    }
    const { main } = getWindows();
    return applyDecisions({
      runId: lastRun.runId,
      files: lastRun.files,
      records: lastRun.records,
      decisions: payload.decisions,
      staging: lastRun.staging,
      review: lastRun.review,
      onProgress: (p) => {
        if (!main.isDestroyed()) main.webContents.send(CHANNELS.progress, p);
      },
    });
  });
}
