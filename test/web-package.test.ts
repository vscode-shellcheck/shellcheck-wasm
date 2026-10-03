// What would break a web Host that bundles `./client` and starts `./browser/worker.js`:
// - a module behind `./client` pulls in the guest side, or any other non-MIT file;
// - `import.meta` in the client graph, which throws once bundled to CommonJS;
// - a runtime export added to `./client` that drags more code with it;
// - the worker built as an ES module, which a classic `new Worker(url)` cannot run;
// - the worker's GPL banner dropped.

import { readFileSync } from "node:fs";
import path from "node:path";
import { Script } from "node:vm";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import { distHint, hasDist, repoRoot, skipHint } from "./helpers.js";

const clientEntry = path.join(repoRoot, "dist", "client-entry.js");
const browserWorker = path.join(repoRoot, "dist", "browser", "worker.js");

describe.skipIf(skipHint(!hasDist, distHint))("web entries", () => {
  it("bundles ./client for a CommonJS browser Host from MIT modules only", async () => {
    const { metafile, outputFiles } = await build({
      entryPoints: [clientEntry],
      absWorkingDir: repoRoot,
      bundle: true,
      format: "cjs",
      platform: "browser",
      write: false,
      metafile: true,
      logLevel: "silent",
    });
    const nonMit = Object.keys(metafile.inputs).filter(
      (input) =>
        !readFileSync(path.join(repoRoot, input), "utf8").startsWith(
          "/*! SPDX-License-Identifier: MIT */\n",
        ),
    );
    expect(nonMit).toEqual([]);
    expect(outputFiles[0]!.text).not.toContain("import.meta");
  });

  it("exports exactly the Host-side runtime API from ./client", async () => {
    const module = (await import(clientEntry)) as Record<string, unknown>;
    expect(Object.keys(module).toSorted()).toEqual([
      "BUILD_INFO",
      "SHELLCHECK_VERSION",
      "createShellCheck",
      "isArtifactSupported",
    ]);
  });

  it("ships the browser worker as a GPL classic script", () => {
    const source = readFileSync(browserWorker, "utf8");
    expect(source.startsWith("/*! SPDX-License-Identifier: GPL-3.0-or-later */")).toBe(true);
    // Parsed as a classic script: any import, export or import.meta is a SyntaxError.
    expect(() => new Script(source)).not.toThrow();
  });
});
