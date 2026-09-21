import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot: string = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const fixtureRoot: string = path.join(repoRoot, "test", "fixtures");
export const wasmPath: string = path.join(repoRoot, "dist", "shellcheck.wasm");
export const buildInfoPath: string = path.join(repoRoot, "dist", "build-info.json");
export const nativePath: string =
  process.env["SHELLCHECK_NATIVE"] ?? path.join(repoRoot, ".cache", "native", "shellcheck");

export const hasWasm: boolean = existsSync(wasmPath);
export const hasNative: boolean = existsSync(nativePath);
export const hasBuildInfo: boolean = existsSync(buildInfoPath);

export const wasmHint = `dist/shellcheck.wasm is missing; run \`npm run build:wasm\` or \`npm run fetch:wasm\` (see AGENTS.md for the dev stand-in)`;
export const nativeHint = `${nativePath} is missing; run \`npm run fetch:native\` or set SHELLCHECK_NATIVE`;
export const buildInfoHint = `dist/build-info.json is missing; it is produced by \`npm run build:wasm\` (Docker) or \`npm run fetch:wasm\``;

const printedHints = new Set<string>();

/**
 * Returns `condition`; prints `hint` once per test file when it is true. Under CI a
 * missing prerequisite is a pipeline bug, so it fails instead of silently skipping.
 */
export function skipHint(condition: boolean, hint: string): boolean {
  if (condition && process.env["CI"]) {
    throw new Error(`missing test prerequisite: ${hint}`);
  }
  if (condition && !printedHints.has(hint)) {
    printedHints.add(hint);
    process.stderr.write(`[skip] ${hint}\n`);
  }
  return condition;
}

let modulePromise: Promise<WebAssembly.Module> | undefined;

/** Compiles dist/shellcheck.wasm once per worker; runs always get a fresh Instance. */
export function loadTestModule(): Promise<WebAssembly.Module> {
  modulePromise ??= WebAssembly.compile(readFileSync(wasmPath));
  return modulePromise;
}

const decoder = new TextDecoder();

export function text(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

export interface Json1Comment {
  file: string;
  line: number;
  code: number;
  message: string;
}

export function json1Comments(stdout: Uint8Array): Json1Comment[] {
  const parsed = JSON.parse(text(stdout)) as { comments: Json1Comment[] };
  return parsed.comments;
}

export function codesOf(stdout: Uint8Array): number[] {
  return json1Comments(stdout).map((comment) => comment.code);
}
