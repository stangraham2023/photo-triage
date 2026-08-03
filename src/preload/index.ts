import { contextBridge } from 'electron';

// Expanded in Task 6. contextIsolation is on, so the renderer only ever sees
// what is explicitly bridged here — never Node itself.
contextBridge.exposeInMainWorld('api', {
  version: process.versions.electron,
});
