import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SHELLCHECK_VERSION } from "../src/index.js";
import { hasWasm, repoRoot, skipHint, wasmHint, wasmPath } from "./helpers.js";

const packageName = "@vscode-shellcheck/shellcheck-wasm";
const distDir = path.join(repoRoot, "dist");
const distIndex = path.join(distDir, "index.js");
const hasDist = existsSync(distIndex);
const distHint = "dist/index.js is missing; run `npm run build` first";
const hasLicense = existsSync(path.join(repoRoot, "LICENSE"));

interface PackEntry {
  path: string;
}
interface PackResult {
  name: string;
  files: PackEntry[];
}

function npmPackDryRun(): PackResult {
  const result = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
  expect(result.status, result.stderr).toBe(0);
  const parsed = JSON.parse(result.stdout) as PackResult[];
  return parsed[0]!;
}

/** Resolves and imports through the package's own `exports` map, as a consumer would. */
function nodeEval(source: string): string {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

function distScripts(dir = distDir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return distScripts(full);
    return entry.name.endsWith(".js") ? [full] : [];
  });
}

/** Every module specifier a compiled file loads: static, side-effect, dynamic and require. */
function specifiersOf(file: string): string[] {
  const source = readFileSync(file, "utf8");
  const patterns = [
    /^\s*(?:import|export)\s[^;]*?\sfrom\s*["']([^"']+)["']/gm,
    /^\s*import\s*["']([^"']+)["']/gm,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  return patterns.flatMap((pattern) => [...source.matchAll(pattern)].map((match) => match[1]!));
}

/** Files reachable from `entry` through relative imports, and the bare specifiers they use. */
function importGraph(entry: string): { files: string[]; packages: string[] } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const visit = (file: string): void => {
    if (files.has(file)) return;
    files.add(file);
    for (const specifier of specifiersOf(file)) {
      if (specifier.startsWith(".")) visit(path.resolve(path.dirname(file), specifier));
      else packages.add(specifier);
    }
  };
  visit(entry);
  return { files: [...files], packages: [...packages] };
}

describe("package", () => {
  describe.skipIf(skipHint(!hasWasm, wasmHint))("npm pack", () => {
    it("ships the entry points and the artifact, but not build-info.json", () => {
      const pack = npmPackDryRun();
      expect(pack.name).toBe(packageName);
      const files = pack.files.map((file) => file.path);
      expect(files).toEqual(
        expect.arrayContaining([
          "dist/shellcheck.wasm",
          "dist/index.js",
          "dist/index.d.ts",
          "dist/worker.js",
          "dist/worker.d.ts",
          "dist/generated/build-info.js",
          "package.json",
          "README.md",
        ]),
      );
      expect(files).not.toContain("dist/build-info.json");
      expect(files).not.toContain("dist/node.js");
      expect(files.filter((file) => file.endsWith(".test.js") || file.startsWith("test/"))).toEqual(
        [],
      );
      expect(files.filter((file) => file.startsWith("src/"))).toEqual([]);
    });

    it.skipIf(skipHint(!hasLicense, "LICENSE is missing"))("ships the license", () => {
      expect(npmPackDryRun().files.map((file) => file.path)).toContain("LICENSE");
    });
  });

  it("exports only the documented subpaths", () => {
    const manifest = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
      exports: Record<string, unknown>;
    };
    expect(Object.keys(manifest.exports)).toEqual([
      ".",
      "./worker",
      "./shellcheck.wasm",
      "./package.json",
    ]);
  });

  describe.skipIf(skipHint(!hasDist, distHint))("built output", () => {
    it("loads no Node built-in from any shipped module", () => {
      const builtins = new Set(builtinModules);
      const offenders = distScripts().flatMap((file) =>
        specifiersOf(file)
          .filter((specifier) => specifier.startsWith("node:") || builtins.has(specifier))
          .map((specifier) => `${path.relative(repoRoot, file)}: ${specifier}`),
      );
      expect(offenders).toEqual([]);
      expect(specifiersOf(path.join(distDir, "worker.js"))).toContain("./bridge.js");
    });

    it("keeps the WASI shim out of the caller's entry", () => {
      const index = importGraph(distIndex);
      expect(index.files.length).toBeGreaterThan(1);
      expect(index.packages).toEqual([]);
      expect(importGraph(path.join(distDir, "worker.js")).packages).toEqual([
        "@bjorn3/browser_wasi_shim",
      ]);
    });

    it("exposes the documented API from dist/index.js and dist/worker.js", async () => {
      const index = (await import(distIndex)) as typeof import("../src/index.js");
      expect(typeof index.createShellCheck).toBe("function");
      expect(index.SHELLCHECK_VERSION).toBe(SHELLCHECK_VERSION);
      expect(index.BUILD_INFO.shellcheckVersion).toBe(SHELLCHECK_VERSION);
      expect(index.wasmUrl).toBeInstanceOf(URL);
      expect(index.wasmUrl.pathname.endsWith("/dist/shellcheck.wasm")).toBe(true);
      const worker = (await import(
        path.join(distDir, "worker.js")
      )) as typeof import("../src/worker.js");
      expect(typeof worker.startWorker).toBe("function");
    });

    it.skipIf(skipHint(!hasWasm, wasmHint))(
      "compiles in the build info of the artifact",
      async () => {
        const { BUILD_INFO } = (await import(distIndex)) as typeof import("../src/index.js");
        const wasm = readFileSync(wasmPath);
        expect(BUILD_INFO.sha256).toBe(createHash("sha256").update(wasm).digest("hex"));
        expect(BUILD_INFO.size).toBe(wasm.byteLength);
        expect(BUILD_INFO.targetFeatures).toContain("+tail-call");
      },
    );

    it("resolves the subpath exports by package name, and nothing else", () => {
      const resolved = nodeEval(
        `const resolve = (s) => { try { return import.meta.resolve(s); } catch (e) { return e.code; } };
        console.log(JSON.stringify(${JSON.stringify(
          [
            "",
            "/worker",
            "/shellcheck.wasm",
            "/package.json",
            "/node",
            "/build-info",
            "/build-info.json",
          ].map((subpath) => packageName + subpath),
        )}.map(resolve)));`,
      );
      expect(JSON.parse(resolved)).toEqual([
        `file://${path.join(distDir, "index.js")}`,
        `file://${path.join(distDir, "worker.js")}`,
        `file://${path.join(distDir, "shellcheck.wasm")}`,
        `file://${path.join(repoRoot, "package.json")}`,
        "ERR_PACKAGE_PATH_NOT_EXPORTED",
        "ERR_PACKAGE_PATH_NOT_EXPORTED",
        "ERR_PACKAGE_PATH_NOT_EXPORTED",
      ]);
    });

    it.skipIf(skipHint(!hasWasm, wasmHint))(
      "lints end to end through the published entry points",
      () => {
        const workerEntry = `import { parentPort } from "node:worker_threads";
          import { startWorker } from "${packageName}/worker";
          startWorker({
            postMessage: (message) => parentPort.postMessage(message),
            onMessage: (listener) => parentPort.on("message", listener),
          });`;
        const output = nodeEval(
          `import { readFile } from "node:fs/promises";
          import { Worker } from "node:worker_threads";
          import { createShellCheck, SHELLCHECK_VERSION, wasmUrl } from ${JSON.stringify(packageName)};
          const shellcheck = createShellCheck({
            module: WebAssembly.compile(await readFile(wasmUrl)),
            createWorker() {
              const worker = new Worker(${JSON.stringify(workerEntry)}, { eval: true });
              return {
                postMessage: (message) => worker.postMessage(message),
                onMessage: (listener) => worker.on("message", listener),
                onError: (listener) => worker.on("error", listener),
                onExit: (listener) => worker.on("exit", listener),
                terminate: () => worker.terminate(),
              };
            },
          });
          const result = await shellcheck.lint({ args: ["--version"] });
          await shellcheck.dispose();
          console.log(\`\${result.exitCode} \${SHELLCHECK_VERSION} \${result.stdout.split("\\n")[1]}\`);`,
        );
        expect(output).toBe(`0 ${SHELLCHECK_VERSION} version: ${SHELLCHECK_VERSION.slice(1)}`);
      },
    );
  });
});
