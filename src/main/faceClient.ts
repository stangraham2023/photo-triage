import { ipcMain, type BrowserWindow } from 'electron';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import type { FaceDetector, FaceResult, WorkingImage } from '../core/types.ts';
import { resolveModelPath, resolveWasmDir } from './assets.ts';

/**
 * Face detection runs on a downscale. Full 1600px frames would push ~7MB per
 * photo across IPC for no accuracy gain; 1024px still leaves a face at the 4%
 * significance threshold about 41 pixels wide, which the landmarker handles.
 */
export const FACE_DETECT_LONG_EDGE = 1024;
export const FACE_DETECT_TIMEOUT_MS = 30_000;
const NUM_FACES = 10;

interface Pending {
  resolve: (faces: FaceResult[]) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class IpcFaceDetector implements FaceDetector {
  private readonly win: BrowserWindow;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private readyPromise: Promise<void> | null = null;

  constructor(win: BrowserWindow) {
    this.win = win;

    ipcMain.on('face:result', (_e, msg: { id: number; faces: FaceResult[]; error: string | null }) => {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error));
      else p.resolve(msg.faces);
    });
  }

  ready(): Promise<void> {
    this.readyPromise ??= (async () => {
      // The model is read here and shipped as bytes rather than as a path:
      // the worker page cannot fetch a file:// URL once the app is packaged.
      const modelBytes = await readFile(resolveModelPath());

      await new Promise<void>((resolve, reject) => {
        ipcMain.once('face:ready', (_e, error: string | null) => {
          if (error) reject(new Error(`Face detector failed to start: ${error}`));
          else resolve();
        });
        this.win.webContents.send('face:init', {
          modelBytes: new Uint8Array(modelBytes),
          wasmDir: resolveWasmDir(),
          numFaces: NUM_FACES,
        });
      });
    })();
    return this.readyPromise;
  }

  async detect(img: WorkingImage): Promise<FaceResult[]> {
    await this.ready();

    const scale = FACE_DETECT_LONG_EDGE / Math.max(img.width, img.height);
    let payload = img;
    if (scale < 1) {
      const buf = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength);
      const { data, info } = await sharp(buf, {
        raw: { width: img.width, height: img.height, channels: 4 },
      })
        .resize({ width: Math.round(img.width * scale), height: Math.round(img.height * scale) })
        .raw()
        .toBuffer({ resolveWithObject: true });
      payload = { width: info.width, height: info.height, data: new Uint8ClampedArray(data) };
    }

    const id = this.nextId++;
    return new Promise<FaceResult[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Face detection timed out after ${FACE_DETECT_TIMEOUT_MS}ms`));
      }, FACE_DETECT_TIMEOUT_MS);

      this.pending.set(id, { resolve, reject, timer });
      this.win.webContents.send('face:detect', {
        id,
        width: payload.width,
        height: payload.height,
        data: payload.data,
      });
    });
  }
}
