import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import {
  createShellCheck,
  type ShellCheck,
  type ShellCheckOptions,
  type WorkerPort,
} from "../src/index.js";

export const repoRoot: string = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const fixtureRoot: string = path.join(repoRoot, "test", "fixtures");
export const wasmPath: string = path.join(repoRoot, "dist", "shellcheck.wasm");
export const nativePath: string =
  process.env["SHELLCHECK_NATIVE"] ?? path.join(repoRoot, ".cache", "native", "shellcheck");
const distWorkerPath = path.join(repoRoot, "dist", "worker.js");

export const hasWasm: boolean = existsSync(wasmPath);
export const hasNative: boolean = existsSync(nativePath);
export const hasDist: boolean = existsSync(distWorkerPath);

export const wasmHint = `dist/shellcheck.wasm is missing; run \`npm run build:wasm\` (Docker) or download it from a GitHub Release (see AGENTS.md)`;
export const nativeHint = `${nativePath} is missing; run \`npm run fetch:native\` or set SHELLCHECK_NATIVE`;
export const distHint = "dist/worker.js is missing; run `npm run build` first";

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

/** True when tests that start a Worker must skip: they need the artifact and dist/worker.js. */
export function skipWorkerTests(): boolean {
  return skipHint(!hasWasm, wasmHint) || skipHint(!hasDist, distHint);
}

/**
 * Workers load dist/ while the tests load src/; a dist older than src would test the last
 * build's worker against the current caller.
 */
function assertDistIsFresh(): void {
  const built = statSync(distWorkerPath).mtimeMs;
  const sourceDir = path.join(repoRoot, "src");
  for (const name of readdirSync(sourceDir)) {
    if (name.endsWith(".ts") && statSync(path.join(sourceDir, name)).mtimeMs > built) {
      throw new Error(`src/${name} is newer than dist/; run \`npm run build\``);
    }
  }
}

let modulePromise: Promise<WebAssembly.Module> | undefined;

/** Compiles dist/shellcheck.wasm once per test file; lints always get a fresh Instance. */
export function loadTestModule(): Promise<WebAssembly.Module> {
  modulePromise ??= WebAssembly.compile(readFileSync(wasmPath));
  return modulePromise;
}

/** A test-only Worker entry under test/support; `node-worker.mjs` is the plain one. */
export function supportWorkerUrl(name: string): URL {
  return pathToFileURL(path.join(repoRoot, "test", "support", name));
}

/** The adapter a Node Host writes around `node:worker_threads`. */
export function nodeWorkerPort(url: URL = supportWorkerUrl("node-worker.mjs")): WorkerPort {
  const worker = new Worker(url);
  return {
    postMessage: (message) => worker.postMessage(message),
    onMessage: (listener) => worker.on("message", listener),
    onError: (listener) => worker.on("error", listener),
    onExit: (listener) => worker.on("exit", listener),
    terminate: () => worker.terminate(),
  };
}

export interface TestShellCheck extends ShellCheck {
  /** How many Workers have been started so far. */
  readonly spawned: number;
}

/** A ShellCheck on the plain test worker unless overridden; dispose it after the test. */
export function createTestShellCheck(options: Partial<ShellCheckOptions> = {}): TestShellCheck {
  assertDistIsFresh();
  const createWorker = options.createWorker ?? (() => nodeWorkerPort());
  let spawned = 0;
  const shellcheck = createShellCheck({
    module: options.module ?? loadTestModule(),
    createWorker: () => {
      spawned += 1;
      return createWorker();
    },
  });
  return {
    lint: (request, lintOptions) => shellcheck.lint(request, lintOptions),
    dispose: () => shellcheck.dispose(),
    get spawned() {
      return spawned;
    },
  };
}

export interface Json1Comment {
  file: string;
  line: number;
  code: number;
  message: string;
}

export function json1Comments(stdout: string): Json1Comment[] {
  const parsed = JSON.parse(stdout) as { comments: Json1Comment[] };
  return parsed.comments;
}

export function codesOf(stdout: string): number[] {
  return json1Comments(stdout).map((comment) => comment.code);
}
