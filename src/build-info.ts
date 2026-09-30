/*! SPDX-License-Identifier: MIT */

/** How one artifact in `dist/` was compiled. */
export interface ArtifactInfo {
  readonly cflags: string;
  readonly targetFeatures: readonly string[];
  /** Hex sha256 of the file. */
  readonly sha256: string;
  /** Size of the file in bytes. */
  readonly size: number;
}

/**
 * The toolchain the bundled artifacts were built with, and each artifact by file name. Keyed by
 * name so that shipping a second build of ShellCheck (one without tail calls, say) only adds a
 * key.
 */
export interface BuildInfo {
  /** ShellCheck release tag, e.g. `v0.11.0`. */
  readonly shellcheckVersion: string;
  readonly ghcWasmMetaCommit: string;
  readonly ghcVersion: string;
  readonly cabalVersion: string;
  readonly wasmOptVersion: string;
  readonly artifacts: { readonly "shellcheck.wasm": ArtifactInfo };
}

// Injected by scripts/build.ts, and by vitest.config.ts for tests that load src/.
declare const INJECTED_SHELLCHECK_VERSION: string;
declare const INJECTED_BUILD_INFO: string;

/** ShellCheck release tag the bundled shellcheck.wasm was built from, e.g. `v0.11.0`. */
export const SHELLCHECK_VERSION: string = INJECTED_SHELLCHECK_VERSION;

export const BUILD_INFO: BuildInfo = JSON.parse(INJECTED_BUILD_INFO) as BuildInfo;
