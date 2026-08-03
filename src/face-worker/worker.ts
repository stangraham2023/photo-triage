import { FilesetResolver, FaceLandmarker } from '@mediapipe/tasks-vision';
import { toFaceResults, type MpLikeResult } from './mapping.ts';

// This window exists solely because MediaPipe requires a DOM: it throws
// "document is not defined" under plain Node, so the detector cannot live in
// the main process. Nothing is ever displayed here.

interface InitConfig {
  modelBytes: ArrayBuffer | Uint8Array;
  wasmDir: string;
  numFaces: number;
}

interface DetectJob {
  id: number;
  width: number;
  height: number;
  data: Uint8ClampedArray | number[];
}

const api = (window as unknown as {
  faceWorker: {
    onInit(cb: (cfg: InitConfig) => void): void;
    onDetect(cb: (job: DetectJob) => void): void;
    sendReady(error: string | null): void;
    sendResult(id: number, faces: unknown, error: string | null): void;
  };
}).faceWorker;

let landmarker: FaceLandmarker | null = null;

api.onInit(async (cfg) => {
  try {
    const fileset = await FilesetResolver.forVisionTasks(cfg.wasmDir);
    landmarker = await FaceLandmarker.createFromOptions(fileset, {
      // The model arrives as bytes over IPC rather than as a path. A packaged
      // app serves this page from a custom protocol where fetching a file://
      // URL is blocked, so reading it in the main process is the only approach
      // that works both in development and once packaged.
      baseOptions: { modelAssetBuffer: new Uint8Array(cfg.modelBytes), delegate: 'CPU' },
      runningMode: 'IMAGE',
      numFaces: cfg.numFaces,
      outputFaceBlendshapes: true,
    });
    api.sendReady(null);
  } catch (err) {
    api.sendReady(err instanceof Error ? err.message : String(err));
  }
});

api.onDetect((job) => {
  if (!landmarker) {
    api.sendResult(job.id, [], 'face landmarker not initialised');
    return;
  }
  try {
    const image = new ImageData(new Uint8ClampedArray(job.data), job.width, job.height);
    const raw = landmarker.detect(image) as unknown as MpLikeResult;
    api.sendResult(job.id, toFaceResults(raw), null);
  } catch (err) {
    api.sendResult(job.id, [], err instanceof Error ? err.message : String(err));
  }
});
