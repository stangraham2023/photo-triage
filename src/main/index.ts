import { app, BrowserWindow } from 'electron';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IpcFaceDetector } from './faceClient.ts';

const DIR = dirname(fileURLToPath(import.meta.url));
const SMOKE = process.env.PHOTO_TRIAGE_SMOKE === '1';

let mainWindow: BrowserWindow | null = null;

export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    show: !SMOKE,
    title: 'Photo Triage',
    webPreferences: {
      preload: join(DIR, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/renderer/index.html`);
  } else {
    void win.loadFile(join(DIR, '../renderer/renderer/index.html'));
  }
  return win;
}

export function createFaceWindow(): BrowserWindow {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: join(DIR, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/face-worker/index.html`);
  } else {
    void win.loadFile(join(DIR, '../renderer/face-worker/index.html'));
  }
  return win;
}

void app.whenReady().then(async () => {
  mainWindow = createMainWindow();
  const faceWindow = createFaceWindow();

  if (SMOKE) {
    await new Promise<void>((r) => mainWindow!.webContents.once('did-finish-load', () => r()));
    const title = await mainWindow!.webContents.executeJavaScript('document.title');
    if (typeof title !== 'string') throw new Error('renderer did not load');

    await new Promise<void>((r) => faceWindow.webContents.once('did-finish-load', () => r()));
    const detector = new IpcFaceDetector(faceWindow);
    await detector.ready();

    // A blank image has no faces. Getting an empty array back — rather than a
    // crash or a timeout — proves the whole IPC and MediaPipe path is live.
    const blank = { width: 64, height: 64, data: new Uint8ClampedArray(64 * 64 * 4).fill(128) };
    const faces = await detector.detect(blank);
    if (!Array.isArray(faces)) throw new Error('detector did not return an array');

    console.log(`SMOKE_OK faces=${faces.length}`);
    app.exit(0);
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) mainWindow = createMainWindow();
});
