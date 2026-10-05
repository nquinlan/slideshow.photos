export type OutputFormat = 'webp' | 'jpeg';

export interface ProcessOptions {
  /** Long-edge cap for the display derivative, in px. */
  cap: number;
  /** Encoder quality 0..1. */
  quality: number;
  /** Force an encoder; otherwise WebP when supported, else JPEG. */
  format?: OutputFormat;
  /** Skip hashing (benchmarks only). */
  skipHash?: boolean;
}

export interface ProcessRequest {
  jobId: number;
  blob: Blob;
  options: ProcessOptions;
}

export interface ProcessResult {
  display: Blob;
  thumb: Blob;
  width: number;
  height: number;
  thumbWidth: number;
  thumbHeight: number;
  /** Hex SHA-256 of the *source* bytes, for dedupe. */
  contentHash: string;
  format: OutputFormat;
  /** Source dimensions after orientation. */
  sourceWidth: number;
  sourceHeight: number;
  /** EXIF DateTimeOriginal (ms since epoch) when present. */
  takenAt?: number;
  /** Diagnostics for the benchmark. */
  timings: { decode: number; encode: number; total: number };
  decoder: 'native' | 'native-resize' | 'heic-wasm';
}

export type WorkerResponse =
  | { jobId: number; ok: true; result: ProcessResult }
  | { jobId: number; ok: false; error: string; code?: 'unsupported' | 'decode' | 'encode' };
