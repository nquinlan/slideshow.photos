/// <reference lib="webworker" />
import { PipelineError, processImage } from './processor';
import type { ProcessRequest, WorkerResponse } from './types';

declare const self: DedicatedWorkerGlobalScope;

self.onmessage = async (e: MessageEvent<ProcessRequest>) => {
  const { jobId, blob, options } = e.data;
  let msg: WorkerResponse;
  try {
    if (typeof OffscreenCanvas === 'undefined') {
      throw new PipelineError('OffscreenCanvas unavailable in worker', 'unsupported');
    }
    const result = await processImage(blob, options);
    msg = { jobId, ok: true, result };
  } catch (err) {
    msg = {
      jobId,
      ok: false,
      error: (err as Error).message ?? String(err),
      code: err instanceof PipelineError ? err.code : 'decode',
    };
  }
  self.postMessage(msg);
};
