export { run } from "./runner.js";
export type { RunOptions, RunResult } from "./runner.js";
export { SHELLCHECK_VERSION } from "./generated/version.js";
export { BUILD_INFO } from "./generated/build-info.js";
export type { BuildInfo } from "./build-info.js";

/** URL of the bundled shellcheck.wasm, resolved relative to this module. */
export const wasmUrl: URL = new URL("./shellcheck.wasm", import.meta.url);
