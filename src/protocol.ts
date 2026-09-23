/**
 * Messages and shared-memory layout between `createShellCheck` and `startWorker`. Both sides
 * ship in the same package version, so the protocol carries no version of its own.
 *
 * The bridge: while the guest is inside a WASI call, the worker posts an `fs` request and
 * blocks in `Atomics.wait` on `STATE`. The caller runs the async file system, writes status,
 * total size and the first chunk, then flips `STATE` to `READY`. Payloads larger than the
 * data region take one `fs-next` round trip per further chunk.
 */

/** Int32 slots of the control header. */
export const STATE = 0;
export const STATUS = 1;
export const TOTAL = 2;
export const LENGTH = 3;

export const HEADER_BYTES = 16;
export const CHUNK_BYTES = 1 << 20;

export const PENDING = 0;
export const READY = 1;

/** WASI preview1 errnos. Spelled out so the caller-side entry does not load the WASI shim. */
export const ERRNO_SUCCESS = 0;
export const ERRNO_ACCES = 2;
export const ERRNO_IO = 29;
export const ERRNO_ISDIR = 31;
export const ERRNO_NOENT = 44;
export const ERRNO_NOTDIR = 54;

export type FileSystemOp = "stat" | "readFile" | "readDirectory";

export interface InitMessage {
  type: "init";
  module: WebAssembly.Module;
  shared: SharedArrayBuffer;
}

export interface LintMessage {
  type: "lint";
  args: string[];
  stdin: string | Uint8Array;
  env: Record<string, string>;
  mounted: boolean;
}

export type ToWorker = InitMessage | LintMessage;

export type FromWorker =
  | { type: "fs"; op: FileSystemOp; path: string }
  | { type: "fs-next" }
  | { type: "done"; stdout: string; stderr: string; exitCode: number }
  | { type: "failed"; name: string; message: string };

export function errnoOf(error: unknown): number {
  switch ((error as { code?: unknown } | null | undefined)?.code) {
    case "FileNotFound":
      return ERRNO_NOENT;
    case "FileNotADirectory":
      return ERRNO_NOTDIR;
    case "FileIsADirectory":
      return ERRNO_ISDIR;
    case "NoPermissions":
      return ERRNO_ACCES;
    default:
      return ERRNO_IO;
  }
}
