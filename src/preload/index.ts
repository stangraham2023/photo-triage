import { contextBridge, ipcRenderer } from 'electron';
import { CHANNELS } from '../shared/contract.ts';

// contextIsolation is on, so the renderer only ever sees what is explicitly
// bridged here — never Node itself.
contextBridge.exposeInMainWorld('api', {
  version: process.versions.electron,
});

// The face worker window loads this same preload. Exposing the bridge to the
// visible renderer too is harmless: it only relays to the main process.
contextBridge.exposeInMainWorld('faceWorker', {
  onInit: (cb: (cfg: unknown) => void) =>
    ipcRenderer.on('face:init', (_e, cfg) => cb(cfg)),
  onDetect: (cb: (job: unknown) => void) =>
    ipcRenderer.on('face:detect', (_e, job) => cb(job)),
  sendReady: (error: string | null) => ipcRenderer.send('face:ready', error),
  sendResult: (id: number, faces: unknown, error: string | null) =>
    ipcRenderer.send('face:result', { id, faces, error }),
});

contextBridge.exposeInMainWorld('triage', {
  pickFolder: (kind: string) => ipcRenderer.invoke(CHANNELS.pickFolder, kind),
  startRun: (cfg: unknown) => ipcRenderer.invoke(CHANNELS.startRun, cfg),
  cancelRun: () => ipcRenderer.send(CHANNELS.cancelRun),
  onProgress: (cb: (p: unknown) => void) => {
    const handler = (_e: unknown, p: unknown) => cb(p);
    ipcRenderer.on(CHANNELS.progress, handler);
    return () => { ipcRenderer.removeListener(CHANNELS.progress, handler); };
  },
});
