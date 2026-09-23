import type { FileStat, FileType } from "./file-system.js";
import {
  CHUNK_BYTES,
  ERRNO_SUCCESS,
  HEADER_BYTES,
  LENGTH,
  PENDING,
  STATE,
  STATUS,
  TOTAL,
  type FileSystemOp,
  type FromWorker,
} from "./protocol.js";

export type DirectoryEntry = readonly [name: string, type: FileType];

/** The Host's file system as the guest needs it: blocking, with a WASI errno for failures. */
export interface SyncFileSystem {
  stat(path: string): FileStat | number;
  readFile(path: string): Uint8Array | number;
  readDirectory(path: string): readonly DirectoryEntry[] | number;
}

const decoder = new TextDecoder();

/**
 * How long the Worker polls for an answer before sleeping in `Atomics.wait`. Answers
 * usually take well under a millisecond, and a thread that sleeps for each of them runs
 * the guest measurably slower after waking (about 4% of a 100 ms lint in `npm run bench`).
 */
const SPIN_MS = 1;

function decodeJson<T>(bytes: Uint8Array): T {
  return JSON.parse(decoder.decode(bytes)) as T;
}

/**
 * Worker side of the bridge, for one lint. Results, failures included, are cached for the
 * whole lint: ShellCheck probes the same rc paths repeatedly, and every miss costs a round
 * trip to the caller's thread. A fresh lint gets a fresh bridge, so edits between lints show.
 */
export class Bridge implements SyncFileSystem {
  private readonly control: Int32Array;
  private readonly data: Uint8Array;
  private readonly cache = new Map<string, unknown>();

  constructor(
    shared: SharedArrayBuffer,
    private readonly post: (message: FromWorker) => void,
  ) {
    this.control = new Int32Array(shared, 0, HEADER_BYTES / Int32Array.BYTES_PER_ELEMENT);
    this.data = new Uint8Array(shared, HEADER_BYTES, CHUNK_BYTES);
  }

  stat(path: string): FileStat | number {
    return this.cached("stat", path, decodeJson<FileStat>);
  }

  readFile(path: string): Uint8Array | number {
    return this.cached("readFile", path, (bytes) => bytes);
  }

  readDirectory(path: string): readonly DirectoryEntry[] | number {
    return this.cached("readDirectory", path, decodeJson<DirectoryEntry[]>);
  }

  private cached<T>(op: FileSystemOp, path: string, decode: (bytes: Uint8Array) => T): T | number {
    const key = `${op}\0${path}`;
    if (this.cache.has(key)) return this.cache.get(key) as T | number;
    const bytes = this.request({ type: "fs", op, path });
    const value = typeof bytes === "number" ? bytes : decode(bytes);
    this.cache.set(key, value);
    return value;
  }

  private request(message: FromWorker): Uint8Array | number {
    this.exchange(message);
    const status = this.control[STATUS]!;
    if (status !== ERRNO_SUCCESS) return status;
    const out = new Uint8Array(this.control[TOTAL]!);
    let received = this.take(out, 0);
    while (received < out.byteLength) {
      this.exchange({ type: "fs-next" });
      received += this.take(out, received);
    }
    return out;
  }

  private exchange(message: FromWorker): void {
    // Reset before posting: the caller may answer before this thread reaches wait().
    Atomics.store(this.control, STATE, PENDING);
    this.post(message);
    const spinUntil = performance.now() + SPIN_MS;
    while (Atomics.load(this.control, STATE) === PENDING && performance.now() < spinUntil) {
      // Busy-wait; see SPIN_MS.
    }
    while (Atomics.load(this.control, STATE) === PENDING) {
      Atomics.wait(this.control, STATE, PENDING);
    }
  }

  private take(out: Uint8Array, offset: number): number {
    const length = this.control[LENGTH]!;
    out.set(this.data.subarray(0, length), offset);
    return length;
  }
}
