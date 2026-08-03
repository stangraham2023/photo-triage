import { app, BrowserWindow } from 'electron';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IpcFaceDetector } from './faceClient.ts';
import { registerIpc } from './ipc.ts';

const DIR = dirname(fileURLToPath(import.meta.url));
const SMOKE = process.env.PHOTO_TRIAGE_SMOKE === '1';

let mainWindow: BrowserWindow | null = null;

const loadPromises = new WeakMap<BrowserWindow, Promise<void>>();

/**
 * Records a load promise at creation time, before the load can possibly finish.
 *
 * Attaching `once('did-finish-load')` later is a race: two windows are created
 * together, so by the time the first one's load is awaited the second has often
 * already fired, and the listener then waits forever. That produced a hang with
 * no output at all, and it was intermittent — which is exactly how a race
 * announces itself.
 */
function trackLoad(win: BrowserWindow): void {
  loadPromises.set(
    win,
    new Promise<void>((resolve, reject) => {
      win.webContents.once('did-finish-load', () => resolve());
      win.webContents.once('did-fail-load', (_e, code, desc) =>
        reject(new Error(`Window failed to load (${code}): ${desc}`)));
    }),
  );
}

export function whenLoaded(win: BrowserWindow): Promise<void> {
  return loadPromises.get(win) ?? Promise.resolve();
}

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
      backgroundThrottling: false,
    },
  });

  trackLoad(win);
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
      // This window is never shown. Chromium throttles hidden windows hard,
      // which would stall MediaPipe initialisation and slow every detection
      // whenever the app loses focus — not just in tests.
      backgroundThrottling: false,
    },
  });

  trackLoad(win);
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
  registerIpc(() => ({ main: mainWindow!, face: faceWindow }));

  if (SMOKE) {
    await whenLoaded(mainWindow!);
    const title = await mainWindow!.webContents.executeJavaScript('document.title');
    if (typeof title !== 'string') throw new Error('renderer did not load');

    await whenLoaded(faceWindow);
    const detector = new IpcFaceDetector(faceWindow);
    await detector.ready();

    // A blank image has no faces. Getting an empty array back — rather than a
    // crash or a timeout — proves the whole IPC and MediaPipe path is live.
    const blank = { width: 64, height: 64, data: new Uint8ClampedArray(64 * 64 * 4).fill(128) };
    const faces = await detector.detect(blank);
    if (!Array.isArray(faces)) throw new Error('detector did not return an array');

    // Drive a whole run through the real detector. Every other test of the
    // orchestrator injects a null or stub detector, so without this nothing
    // would catch a break in the wiring between the two.
    const source = process.env.PHOTO_TRIAGE_SMOKE_SOURCE;
    let ran = 'skipped';
    if (source) {
      const { runTriage } = await import('./orchestrator.ts');
      const { MetadataReader } = await import('../core/metadata.ts');
      const { mkdtemp } = await import('node:fs/promises');
      const { tmpdir } = await import('node:os');

      const base = await mkdtemp(join(tmpdir(), 'smoke-run-'));
      const reader = new MetadataReader();
      try {
        const result = await runTriage({
          source,
          staging: join(base, 'staging'),
          review: join(base, 'review'),
          preset: 'event',
          recurse: true,
          dryRun: false,
          detector,
          reader,
        });
        ran = `total=${result.summary.total},good=${result.summary.good},unreadable=${result.unreadable}`;
      } finally {
        await reader.close();
      }
    }

    console.log(`SMOKE_OK faces=${faces.length} run=${ran}`);
    app.exit(0);
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) mainWindow = createMainWindow();
});
