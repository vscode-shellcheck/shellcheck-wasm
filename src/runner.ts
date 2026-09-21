import { WASI, type Fd } from "@bjorn3/browser_wasi_shim";
import { MemoryInput, MemoryOutput } from "./fds.js";

export interface RunOptions {
  /** ShellCheck arguments, without argv[0]. Example: `["-f", "json1", "-s", "bash", "-"]`. */
  args: readonly string[];
  /** Script or other data for stdin. Default: empty. */
  stdin?: string | Uint8Array;
  /**
   * Environment for the guest. `PWD` is the guest working directory: the GHC RTS
   * chdir()s there at startup, so it must be a path inside one of `preopens` or be
   * left unset. Pointing it elsewhere makes the RTS print
   * `hs_init_ghc: chdir(...) failed` and the run ends with no stdout.
   */
  env?: Readonly<Record<string, string>>;
  /** Preopened directories, assigned fd 3, 4, … in order. See `createReadOnlyPreopen` in `./node`. */
  preopens?: readonly Fd[];
}

export interface RunResult {
  stdout: Uint8Array;
  stderr: Uint8Array;
  exitCode: number;
}

interface CommandExports {
  memory: WebAssembly.Memory;
  _start: () => unknown;
}

const encoder = new TextEncoder();

function toBytes(stdin: string | Uint8Array | undefined): Uint8Array {
  if (stdin === undefined) return new Uint8Array();
  return typeof stdin === "string" ? encoder.encode(stdin) : stdin;
}

function commandExports(instance: WebAssembly.Instance): CommandExports {
  const { memory, _start } = instance.exports;
  if (!(memory instanceof WebAssembly.Memory) || typeof _start !== "function") {
    throw new TypeError(
      "shellcheck.wasm is not a WASI command module (needs `memory` and `_start` exports)",
    );
  }
  return { memory, _start: _start as () => unknown };
}

/**
 * Runs ShellCheck once on a fresh `WebAssembly.Instance` of `module` and returns what
 * it wrote. Synchronous: the guest runs to completion on the calling thread. A non-zero
 * exit code is ShellCheck's normal way of reporting findings, not an error; anything the
 * guest traps on propagates as an exception.
 */
export function run(module: WebAssembly.Module, options: RunOptions): RunResult {
  const stdout = new MemoryOutput();
  const stderr = new MemoryOutput();
  const fds: Fd[] = [
    new MemoryInput(toBytes(options.stdin)),
    stdout,
    stderr,
    ...(options.preopens ?? []),
  ];
  const env = Object.entries(options.env ?? {}).map(([key, value]) => `${key}=${value}`);

  // ShellCheck reads its own name from argv[0] (usage text, error prefixes).
  const wasi = new WASI(["shellcheck", ...options.args], env, fds, { debug: false });
  const instance = new WebAssembly.Instance(module, { wasi_snapshot_preview1: wasi.wasiImport });
  const exitCode = wasi.start({ exports: commandExports(instance) });

  return { stdout: stdout.bytes(), stderr: stderr.bytes(), exitCode };
}
