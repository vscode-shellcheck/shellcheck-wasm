/*! SPDX-License-Identifier: MIT */

/** How the bundled shellcheck.wasm was built, as recorded by the wasm build. */
export interface BuildInfo {
  /** ShellCheck release tag, e.g. `v0.11.0`. */
  readonly shellcheckVersion: string;
  readonly ghcWasmMetaCommit: string;
  readonly ghcVersion: string;
  readonly cabalVersion: string;
  readonly wasmOptVersion: string;
  readonly cflags: string;
  readonly targetFeatures: readonly string[];
  /** Hex sha256 of shellcheck.wasm. */
  readonly sha256: string;
  /** Size of shellcheck.wasm in bytes. */
  readonly size: number;
}

// Injected by scripts/build.mjs, and by vitest.config.ts for tests that load src/.
declare const INJECTED_SHELLCHECK_VERSION: string;
declare const INJECTED_BUILD_INFO: string;

/** ShellCheck release tag the bundled shellcheck.wasm was built from, e.g. `v0.11.0`. */
export const SHELLCHECK_VERSION: string = INJECTED_SHELLCHECK_VERSION;

export const BUILD_INFO: BuildInfo = JSON.parse(INJECTED_BUILD_INFO) as BuildInfo;
