import { build } from "esbuild";

await build({
  entryPoints: ["src/browser-worker.ts"],
  outfile: "dist/browser/worker.js",
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  banner: { js: "/*! SPDX-License-Identifier: GPL-3.0-or-later */" },
  legalComments: "inline",
});
