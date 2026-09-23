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
