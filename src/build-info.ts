import { readFileSync } from "node:fs";

/** How the bundled shellcheck.wasm was built; mirrors `dist/build-info.json`. */
export interface BuildInfo {
  /** ShellCheck release tag, e.g. `v0.11.0`. */
  readonly shellcheckVersion: string;
  readonly ghcWasmMetaCommit: string;
  readonly ghcVersion: string;
  readonly cabalVersion: string;
  readonly wasmOptVersion: string;
  readonly cflags: string;
  readonly targetFeatures: readonly string[];
  readonly sha256: string;
  readonly size: number;
}

let cached: BuildInfo | undefined;

/**
 * Reads the build info shipped next to shellcheck.wasm. Kept free of runner imports so
 * Hosts can read it without pulling the runner into their bundle.
 */
export function readBuildInfo(): BuildInfo {
  cached ??= JSON.parse(
    readFileSync(new URL("./build-info.json", import.meta.url), "utf8"),
  ) as BuildInfo;
  return cached;
}
