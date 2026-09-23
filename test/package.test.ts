import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SHELLCHECK_VERSION } from "../src/index.js";
import {
  buildInfoHint,
  buildInfoPath,
  hasBuildInfo,
  hasWasm,
  repoRoot,
  skipHint,
  wasmHint,
  wasmPath,
} from "./helpers.js";

const packageName = "@vscode-shellcheck/shellcheck-wasm";
const distIndex = path.join(repoRoot, "dist", "index.js");
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

describe("package", () => {
  describe.skipIf(skipHint(!hasWasm, wasmHint))("npm pack", () => {
    it("ships the runtime entry points and the artifact", () => {
      const pack = npmPackDryRun();
      expect(pack.name).toBe(packageName);
      const files = pack.files.map((file) => file.path);
      expect(files).toEqual(
        expect.arrayContaining([
          "dist/shellcheck.wasm",
          "dist/index.js",
          "dist/index.d.ts",
          "dist/node.js",
          "dist/node.d.ts",
          "dist/generated/build-info.js",
          "package.json",
          "README.md",
        ]),
      );
      expect(files.filter((file) => file.endsWith(".test.js") || file.startsWith("test/"))).toEqual(
        [],
      );
      expect(files.filter((file) => file.startsWith("src/"))).toEqual([]);
    });

    it.skipIf(skipHint(!hasLicense, "LICENSE is missing; it is added in the docs workstream"))(
      "ships the license",
      () => {
        expect(npmPackDryRun().files.map((file) => file.path)).toContain("LICENSE");
      },
    );

    it("does not ship build-info.json, which is compiled in", () => {
      expect(npmPackDryRun().files.map((file) => file.path)).not.toContain("dist/build-info.json");
    });
  });

  describe.skipIf(skipHint(!hasDist, distHint))("built output", () => {
    it("exposes the documented API from dist/index.js", async () => {
      const index = (await import(distIndex)) as typeof import("../src/index.js");
      expect(typeof index.run).toBe("function");
      expect(index.SHELLCHECK_VERSION).toBe(SHELLCHECK_VERSION);
      expect(index.wasmUrl).toBeInstanceOf(URL);
      expect(index.wasmUrl.pathname.endsWith("/dist/shellcheck.wasm")).toBe(true);
    });

    it("exposes the documented API from dist/node.js", async () => {
      const node = (await import(
        path.join(repoRoot, "dist", "node.js")
      )) as typeof import("../src/node.js");
      expect(typeof node.run).toBe("function");
      expect(typeof node.loadModule).toBe("function");
      expect(typeof node.createReadOnlyPreopen).toBe("function");
      expect(node.wasmPath).toBe(path.join(repoRoot, "dist", "shellcheck.wasm"));
      expect(node.BUILD_INFO.shellcheckVersion).toBe(SHELLCHECK_VERSION);
    });

    it.skipIf(skipHint(!hasBuildInfo, buildInfoHint) || skipHint(!hasWasm, wasmHint))(
      "compiles in the build info of the artifact",
      () => {
        const output = nodeEval(
          `import { BUILD_INFO } from ${JSON.stringify(packageName)};
         console.log(JSON.stringify(BUILD_INFO));`,
        );
        const info = JSON.parse(output) as { sha256: string; size: number };
        expect(info).toEqual(JSON.parse(readFileSync(buildInfoPath, "utf8")));
        const wasm = readFileSync(wasmPath);
        expect(info.sha256).toBe(createHash("sha256").update(wasm).digest("hex"));
        expect(info.size).toBe(wasm.byteLength);
      },
    );

    it("resolves the subpath exports by package name", () => {
      const resolved = nodeEval(
        `console.log(JSON.stringify([
          import.meta.resolve(${JSON.stringify(packageName)}),
          import.meta.resolve(${JSON.stringify(`${packageName}/node`)}),
          import.meta.resolve(${JSON.stringify(`${packageName}/shellcheck.wasm`)}),
          import.meta.resolve(${JSON.stringify(`${packageName}/package.json`)}),
        ]))`,
      );
      const [index, node, wasm, pkg] = JSON.parse(resolved) as string[];
      expect(index).toBe(`file://${path.join(repoRoot, "dist", "index.js")}`);
      expect(node).toBe(`file://${path.join(repoRoot, "dist", "node.js")}`);
      expect(wasm).toBe(`file://${path.join(repoRoot, "dist", "shellcheck.wasm")}`);
      expect(pkg).toBe(`file://${path.join(repoRoot, "package.json")}`);
    });

    it("no longer exports build-info.json or ./build-info", () => {
      for (const subpath of ["/build-info.json", "/build-info"]) {
        const code = nodeEval(
          `try { import.meta.resolve(${JSON.stringify(packageName + subpath)}); console.log("resolved"); }
           catch (error) { console.log(error.code); }`,
        );
        expect(code, subpath).toBe("ERR_PACKAGE_PATH_NOT_EXPORTED");
      }
    });

    it.skipIf(skipHint(!hasWasm, wasmHint))(
      "runs end to end through the published entry point",
      () => {
        const output = nodeEval(
          `import { loadModule, run, SHELLCHECK_VERSION } from ${JSON.stringify(`${packageName}/node`)};
         const result = run(await loadModule(), { args: ["--version"] });
         const line = new TextDecoder().decode(result.stdout).split("\\n")[1];
         console.log(\`\${result.exitCode} \${SHELLCHECK_VERSION} \${line}\`);`,
        );
        expect(output).toBe(`0 ${SHELLCHECK_VERSION} version: ${SHELLCHECK_VERSION.slice(1)}`);
      },
    );
  });
});
