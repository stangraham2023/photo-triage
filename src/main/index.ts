import { app, BrowserWindow, protocol, net } from 'electron';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IpcFaceDetector } from './faceClient.ts';
import { registerIpc, thumbRoot } from './ipc.ts';
import { analyzeRun, applyDecisions } from './orchestrator.ts';
import { MetadataReader } from '../core/metadata.ts';
import { decideAll } from '../core/verdict.ts';
import { PRESETS } from '../core/presets.ts';
import { summarize } from '../core/report.ts';
import { mkdtemp, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

// Thumbnails are served over a dedicated scheme rather than file:// URLs, so
// the renderer never gets general filesystem read access.
protocol.registerSchemesAsPrivileged([
  { scheme: 'triage-thumb', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

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
  protocol.handle('triage-thumb', (request) => {
    const url = new URL(request.url);
    const root = thumbRoot();
    const file = join(root, url.hostname, url.pathname.replace(/^\//, ''));
    // Refuse anything that resolves outside the cache directory.
    if (!file.startsWith(root)) return new Response('forbidden', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });

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
      const base = await mkdtemp(join(tmpdir(), 'smoke-run-'));
      const staging = join(base, 'staging');
      const review = join(base, 'review');
      const reader = new MetadataReader();
      try {
        const a = await analyzeRun({
          source, preset: 'event', recurse: true,
          detector, reader, thumbRoot: thumbRoot(),
        });

        // The review gate, checked by machine rather than by reading the code:
        // analysis must not have created either destination.
        let leaked = false;
        for (const dir of [staging, review]) {
          try { await access(dir); leaked = true; } catch { /* expected */ }
        }
        if (leaked) throw new Error('analyzeRun wrote to a destination folder');

        const decisions = decideAll(a.records, PRESETS.event, a.groups);
        for (const f of a.unreadable) {
          decisions.push({ id: f.relPath, verdict: 'unreadable', reasons: [], groupId: null, isGroupKeeper: true });
        }
        const applied = await applyDecisions({
          runId: a.runId,
          files: [...a.records.map((r) => r.file), ...a.unreadable],
          records: a.records,
          decisions, staging, review,
        });
        const s = summarize(decisions);
        ran = `total=${s.total},good=${s.good},unreadable=${s.unreadable},copied=${applied.copied},gate=ok`;
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
