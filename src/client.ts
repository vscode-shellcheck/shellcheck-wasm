import type { FileType, ShellCheckFileSystem } from "./file-system.js";
import {
  CHUNK_BYTES,
  ERRNO_IO,
  ERRNO_SUCCESS,
  HEADER_BYTES,
  LENGTH,
  READY,
  STATE,
  STATUS,
  TOTAL,
  errnoOf,
  type FileSystemOp,
  type FromWorker,
  type LintMessage,
  type ToWorker,
} from "./protocol.js";

/**
 * A Worker running `startWorker` from `@vscode-shellcheck/shellcheck-wasm/worker`, seen
 * from the thread that created it. `onMessage` receives the posted value itself (unwrap
 * `MessageEvent.data` for a web Worker).
 */
export interface WorkerPort {
  postMessage(message: unknown): void;
  onMessage(listener: (message: unknown) => void): void;
  onError(listener: (error: unknown) => void): void;
  /** Omit where the platform has no exit event, such as a web Worker. */
  onExit?(listener: (exitCode: number) => void): void;
  terminate(): void | Promise<unknown>;
}

export interface ShellCheckOptions {
  /** The compiled `shellcheck.wasm`; sent to each Worker once, when it starts. */
  module: WebAssembly.Module | PromiseLike<WebAssembly.Module>;
  /** Starts a Worker. Called lazily for the first lint and again after a Worker is lost. */
  createWorker(): WorkerPort;
}

export interface LintRequest {
  /** ShellCheck arguments, without argv[0]. Example: `["-f", "json1", "-s", "bash", "-"]`. */
  args: readonly string[];
  /** Script or other data for stdin. Default: empty. */
  stdin?: string | Uint8Array;
  /**
   * Environment for the guest. `PWD` is the guest working directory: the GHC RTS chdir()s
   * there at startup, so it must name a directory in `fs` or be left unset. Pointing it
   * elsewhere makes the RTS print `hs_init_ghc: chdir(...) failed` and the lint ends with
   * no stdout.
   */
  env?: Readonly<Record<string, string>>;
  /** Mounted read-only at guest `/`. Without it ShellCheck sees no files at all. */
  fs?: ShellCheckFileSystem;
}

export interface LintResult {
  stdout: string;
  stderr: string;
  /** ShellCheck's own: `0` no findings, `1` findings, `2` or higher for invalid input. */
  exitCode: number;
}

export interface LintOptions {
  /**
   * Aborting a queued lint drops it; aborting the running one terminates its Worker, and
   * the next lint starts a new one. Either way the promise rejects with `signal.reason`.
   */
  signal?: AbortSignal;
}

export interface ShellCheck {
  /** Queues a lint; lints run one at a time in call order. */
  lint(request: LintRequest, options?: LintOptions): Promise<LintResult>;
  /** Rejects pending lints and terminates the Worker. Further lints reject. */
  dispose(): Promise<void>;
}

interface Job {
  readonly request: LintRequest;
  readonly resolve: (result: LintResult) => void;
  readonly reject: (error: unknown) => void;
  session?: Session;
}

const encoder = new TextEncoder();
const FILE_TYPES: ReadonlySet<unknown> = new Set<FileType>(["file", "directory", "other"]);

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`expected a finite number, got ${String(value)}`);
  }
  return Math.max(0, Math.trunc(value));
}

function fileType(value: unknown): FileType {
  if (!FILE_TYPES.has(value)) throw new TypeError(`unknown file type ${String(value)}`);
  return value as FileType;
}

/** Runs one file-system call and encodes the answer as the bridge payload. */
async function call(fs: ShellCheckFileSystem, op: FileSystemOp, path: string): Promise<Uint8Array> {
  switch (op) {
    case "stat": {
      const { type, size, mtime } = await fs.stat(path);
      const stat = { type: fileType(type), size: integer(size), mtime: integer(mtime) };
      return encoder.encode(JSON.stringify(stat));
    }
    case "readFile": {
      const data = await fs.readFile(path);
      if (!(data instanceof Uint8Array)) throw new TypeError("readFile must return a Uint8Array");
      return data;
    }
    case "readDirectory": {
      const entries = Array.from(await fs.readDirectory(path), ([name, type]) => {
        if (typeof name !== "string") throw new TypeError("entry names must be strings");
        return [name, fileType(type)];
      });
      return encoder.encode(JSON.stringify(entries));
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One Worker and its bridge memory, which lives exactly as long as the Worker. */
class Session {
  closed = false;
  private readonly control: Int32Array;
  private readonly data: Uint8Array;
  private active: Job | undefined;
  private payload: Uint8Array | undefined;
  private sent = 0;

  constructor(
    private readonly port: WorkerPort,
    module: WebAssembly.Module,
  ) {
    const shared = new SharedArrayBuffer(HEADER_BYTES + CHUNK_BYTES);
    this.control = new Int32Array(shared, 0, HEADER_BYTES / Int32Array.BYTES_PER_ELEMENT);
    this.data = new Uint8Array(shared, HEADER_BYTES, CHUNK_BYTES);
    port.onMessage((message) => this.receive(message as FromWorker));
    port.onError((error) => {
      this.fail(new Error(`ShellCheck worker failed: ${describe(error)}`, { cause: error }));
    });
    port.onExit?.((exitCode) => {
      this.fail(new Error(`ShellCheck worker exited unexpectedly with code ${exitCode}`));
    });
    this.post({ type: "init", module, shared });
  }

  lint(job: Job): void {
    if (this.closed) throw new Error("ShellCheck worker is gone");
    const { args, stdin = "", env = {}, fs } = job.request;
    const message: LintMessage = {
      type: "lint",
      args: [...args],
      stdin,
      env: { ...env },
      mounted: fs !== undefined,
    };
    this.post(message);
    this.active = job;
    job.session = this;
  }

  terminate(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    this.active = undefined;
    return Promise.resolve(this.port.terminate()).then(
      () => undefined,
      () => undefined,
    );
  }

  private post(message: ToWorker): void {
    this.port.postMessage(message);
  }

  private fail(error: Error): void {
    if (this.closed) return;
    const job = this.active;
    void this.terminate();
    job?.reject(error);
  }

  private receive(message: FromWorker): void {
    if (this.closed) return;
    switch (message.type) {
      case "fs":
        void this.serve(message.op, message.path);
        return;
      case "fs-next":
        this.answer();
        return;
      case "done":
      case "failed": {
        const job = this.active;
        this.active = undefined;
        if (message.type === "done") {
          const { stdout, stderr, exitCode } = message;
          job?.resolve({ stdout, stderr, exitCode });
        } else {
          job?.reject(new Error(`ShellCheck failed: ${message.name}: ${message.message}`));
        }
        return;
      }
    }
  }

  private async serve(op: FileSystemOp, path: string): Promise<void> {
    const job = this.active;
    let status = ERRNO_SUCCESS;
    let payload: Uint8Array = new Uint8Array();
    try {
      const fs = job?.request.fs;
      if (fs === undefined) throw new Error("no file system for this lint");
      payload = await call(fs, op, path);
    } catch (error) {
      status = errnoOf(error);
    }
    // The lint may have been aborted, and its Worker terminated, while fs was busy.
    if (this.closed || this.active !== job) return;
    this.control[STATUS] = status;
    this.control[TOTAL] = payload.byteLength;
    this.payload = payload;
    this.sent = 0;
    this.answer();
  }

  /** Writes the next chunk of the current payload and wakes the Worker. */
  private answer(): void {
    const payload = this.payload;
    if (payload === undefined) {
      this.control[STATUS] = ERRNO_IO;
      this.control[LENGTH] = 0;
    } else {
      const chunk = payload.subarray(this.sent, this.sent + CHUNK_BYTES);
      this.data.set(chunk);
      this.control[LENGTH] = chunk.byteLength;
      this.sent += chunk.byteLength;
      if (this.sent >= payload.byteLength) this.payload = undefined;
    }
    Atomics.store(this.control, STATE, READY);
    Atomics.notify(this.control, STATE);
  }
}

class Scheduler implements ShellCheck {
  private readonly queue: Job[] = [];
  private running: Job | undefined;
  private session: Session | undefined;
  private spawning: Promise<Session> | undefined;
  private disposed = false;

  constructor(private readonly options: ShellCheckOptions) {}

  lint(request: LintRequest, { signal }: LintOptions = {}): Promise<LintResult> {
    if (this.disposed) return Promise.reject(new Error("ShellCheck instance is disposed"));
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    return new Promise<LintResult>((resolve, reject) => {
      let settled = false;
      const settle = (): boolean => {
        if (settled) return false;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        if (this.running === job) {
          this.running = undefined;
          void this.pump();
        }
        return true;
      };
      const job: Job = {
        request,
        resolve: (result) => settle() && resolve(result),
        reject: (error) => settle() && reject(error),
      };
      const onAbort = (): void => {
        const queued = this.queue.indexOf(job);
        if (queued !== -1) this.queue.splice(queued, 1);
        if (this.running === job) void job.session?.terminate();
        job.reject(abortReason(signal!));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.queue.push(job);
      void this.pump();
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const error = new Error("ShellCheck instance is disposed");
    for (const job of [...this.queue.splice(0), this.running]) job?.reject(error);
    const session = this.session ?? (await this.spawning?.catch(() => undefined));
    this.session = undefined;
    await session?.terminate();
  }

  private async pump(): Promise<void> {
    if (this.running !== undefined || this.disposed) return;
    const job = this.queue.shift();
    if (job === undefined) return;
    this.running = job;
    try {
      const session = await this.ensureSession();
      // Aborted or disposed while the Worker was starting.
      if (this.running === job) session.lint(job);
    } catch (error) {
      job.reject(error);
    }
  }

  private ensureSession(): Promise<Session> {
    if (this.session !== undefined && !this.session.closed) return Promise.resolve(this.session);
    this.spawning ??= this.spawn().finally(() => {
      this.spawning = undefined;
    });
    return this.spawning;
  }

  private async spawn(): Promise<Session> {
    const module = await this.options.module;
    if (this.disposed) throw new Error("ShellCheck instance is disposed");
    const port = this.options.createWorker();
    try {
      this.session = new Session(port, module);
    } catch (error) {
      await port.terminate();
      throw error;
    }
    return this.session;
  }
}

/**
 * Runs ShellCheck in a Worker the Host supplies, one lint at a time. The Worker starts on
 * the first lint and is replaced after it is lost or a running lint is aborted.
 * Scheduling policy beyond first-in-first-out, such as timeouts or dropping stale lints,
 * belongs to the Host, which can pass `AbortSignal.timeout(ms)` or its own signal.
 */
export function createShellCheck(options: ShellCheckOptions): ShellCheck {
  return new Scheduler(options);
}
