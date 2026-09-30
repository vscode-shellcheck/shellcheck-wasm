import { readdirSync } from "node:fs";
import { build, type BuildOptions } from "esbuild";
import { buildConstants } from "./build-constants.ts";

let define: Record<string, string>;
try {
  define = buildConstants();
} catch (error) {
  console.error(`build: ${(error as Error).message}`);
  process.exit(1);
}

const common: BuildOptions = { target: "es2022", define, logLevel: "warning" };

await Promise.all([
  // One module per source file, so `.` never loads what only `./worker` needs.
  build({
    ...common,
    entryPoints: readdirSync("src")
      .filter((name) => name.endsWith(".ts") && name !== "browser-worker.ts")
      .map((name) => `src/${name}`),
    outdir: "dist",
    format: "esm",
    platform: "neutral",
    sourcemap: true,
  }),
  // A classic script a web Host starts by URL, with everything it runs inlined.
  build({
    ...common,
    entryPoints: ["src/browser-worker.ts"],
    outfile: "dist/browser/worker.js",
    bundle: true,
    format: "iife",
    platform: "browser",
    banner: { js: "/*! SPDX-License-Identifier: GPL-3.0-or-later */" },
    legalComments: "inline",
  }),
]);
