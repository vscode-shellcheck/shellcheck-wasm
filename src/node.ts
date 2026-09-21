import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { wasmUrl } from "./index.js";

export { run, SHELLCHECK_VERSION, wasmUrl } from "./index.js";
export type { RunOptions, RunResult } from "./index.js";
export { createReadOnlyPreopen } from "./host-preopen.js";
export type { ReadOnlyPreopen } from "./host-preopen.js";
export { readBuildInfo } from "./build-info.js";
export type { BuildInfo } from "./build-info.js";

/** Filesystem path of the bundled shellcheck.wasm. */
export const wasmPath: string = fileURLToPath(wasmUrl);

/** Reads and compiles the bundled artifact. Hosts should call this once and reuse the Module. */
export async function loadModule(): Promise<WebAssembly.Module> {
  return WebAssembly.compile(await readFile(wasmPath));
}
