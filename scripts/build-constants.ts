import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ArtifactInfo, BuildInfo } from "../src/build-info.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const versionFile = resolve(repoRoot, "buildtools/wasm/version.txt");
const infoFile = resolve(repoRoot, "dist/build-info.json");
const wasmFile = resolve(repoRoot, "dist/shellcheck.wasm");

/** Field of `dist/build-info.json`, as the wasm build writes it, → expected `typeof`. */
const FIELDS = {
  shellcheckVersion: "string",
  ghcWasmMetaCommit: "string",
  ghcVersion: "string",
  cabalVersion: "string",
  wasmOptVersion: "string",
  cflags: "string",
  targetFeatures: "object",
  sha256: "string",
  size: "number",
} as const;

/**
 * The `define` map `src/build-info.ts` reads, for esbuild and for vitest, which runs `src/`
 * unbuilt. Throws unless `version.txt`, `dist/build-info.json` and `dist/shellcheck.wasm`
 * describe the same build.
 */
export function buildConstants(): Record<string, string> {
  const version = readFileSync(versionFile, "utf8").trim();
  if (!/^v\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(
      `${versionFile} must contain a tag like v0.11.0, got ${JSON.stringify(version)}`,
    );
  }

  let info: Record<string, unknown>;
  let wasm: Buffer;
  try {
    info = JSON.parse(readFileSync(infoFile, "utf8"));
    wasm = readFileSync(wasmFile);
  } catch (error) {
    throw new Error(
      `${(error as Error).message}\nPut the artifact and its build-info.json in dist/: \`npm run build:wasm\` (Docker) or download both from a GitHub Release.`,
      { cause: error },
    );
  }

  const keys = Object.keys(info).toSorted();
  if (JSON.stringify(keys) !== JSON.stringify(Object.keys(FIELDS).toSorted())) {
    throw new Error(
      `${infoFile} has fields ${keys.join(", ")}; update this script and src/build-info.ts`,
    );
  }
  for (const [field, type] of Object.entries(FIELDS)) {
    if (typeof info[field] !== type) throw new Error(`${field} in ${infoFile} is not a ${type}`);
  }
  if (
    !Array.isArray(info.targetFeatures) ||
    info.targetFeatures.some((f) => typeof f !== "string")
  ) {
    throw new Error(`targetFeatures in ${infoFile} is not a list of strings`);
  }

  // A build-info.json from a different build than the artifact would describe the wrong module.
  const sha256 = createHash("sha256").update(wasm).digest("hex");
  if (info.sha256 !== sha256 || info.size !== wasm.byteLength) {
    throw new Error(
      `${infoFile} describes a different shellcheck.wasm (sha256 ${info.sha256}, actual ${sha256})`,
    );
  }
  if (info.shellcheckVersion !== version) {
    throw new Error(
      `${infoFile} is for ShellCheck ${info.shellcheckVersion}, version.txt pins ${version}`,
    );
  }

  // Checked field by field above. The file keeps the flat shape Releases have always had.
  const flat = info as unknown as Omit<BuildInfo, "artifacts"> & ArtifactInfo;
  const buildInfo: BuildInfo = {
    shellcheckVersion: flat.shellcheckVersion,
    ghcWasmMetaCommit: flat.ghcWasmMetaCommit,
    ghcVersion: flat.ghcVersion,
    cabalVersion: flat.cabalVersion,
    wasmOptVersion: flat.wasmOptVersion,
    artifacts: {
      "shellcheck.wasm": {
        cflags: flat.cflags,
        targetFeatures: flat.targetFeatures,
        sha256: flat.sha256,
        size: flat.size,
      },
    },
  };
  return {
    INJECTED_SHELLCHECK_VERSION: JSON.stringify(version),
    // A string, not an object: esbuild hoists an object define above the SPDX header.
    INJECTED_BUILD_INFO: JSON.stringify(JSON.stringify(buildInfo)),
  };
}
