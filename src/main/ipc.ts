import { ipcMain, dialog, type BrowserWindow } from 'electron';
import { CHANNELS, type RunConfig } from '../shared/contract.ts';
import { runTriage, type RunResult } from './orchestrator.ts';
import { MetadataReader } from '../core/metadata.ts';
import { IpcFaceDetector } from './faceClient.ts';

export function registerIpc(getWindows: () => { main: BrowserWindow; face: BrowserWindow }) {
  let controller: AbortController | null = null;
  let detector: IpcFaceDetector | null = null;

  ipcMain.handle(CHANNELS.pickFolder, async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(getWindows().main, {
      properties: ['openDirectory', 'createDirectory'],
    });
    return canceled ? null : filePaths[0] ?? null;
  });

  ipcMain.on(CHANNELS.cancelRun, () => controller?.abort());

  ipcMain.handle(CHANNELS.startRun, async (_e, cfg: RunConfig): Promise<RunResult> => {
    const { main, face } = getWindows();
    controller = new AbortController();
    const reader = new MetadataReader();

    // One detector for the lifetime of the app: creating a second would
    // register a duplicate face:result listener and re-initialise MediaPipe.
    detector ??= new IpcFaceDetector(face);

    try {
      return await runTriage({
        ...cfg,
        detector,
        reader,
        signal: controller.signal,
        onProgress: (p) => {
          if (!main.isDestroyed()) main.webContents.send(CHANNELS.progress, p);
        },
      });
    } finally {
      // exiftool keeps a child process alive; failing to close it wedges quit.
      await reader.close();
      controller = null;
    }
  });
}
