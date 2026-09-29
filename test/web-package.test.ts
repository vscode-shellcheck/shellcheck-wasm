// Build guarantees covered here:
// - A re-export can pull a guest-side module into ./client, so every relative import is walked.
// - A CommonJS-hostile import.meta can survive bundling, so the complete client graph is scanned.
// - A bare WASI shim dependency can enter through a transitive import, so package specifiers and
//   source text are checked for the guest-side module names.
// - esbuild can emit ESM for the browser worker, so top-level import/export statements are banned.
// - minification/legal-comment settings can drop the worker's GPL banner, so its exact prefix is
//   asserted.
// - An accidental runtime re-export can expand the host API, so the client runtime keys are exact.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const distDir = path.join(repoRoot, "dist");
const clientEntry = path.join(distDir, "client-entry.js");
const browserWorker = path.join(distDir, "browser", "worker.js");
const hasBuiltWebEntries = existsSync(clientEntry) && existsSync(browserWorker);

const forbiddenClientText = [
  "import.meta",
  "worker.js",
  "runner.js",
  "preopen.js",
  "fds.js",
  "bridge.js",
  "@bjorn3/browser_wasi_shim",
];

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

function clientImportGraph(entry: string): string[] {
  const files = new Set<string>();
  const visit = (file: string): void => {
    if (files.has(file)) return;
    files.add(file);
    for (const specifier of specifiersOf(file)) {
      if (specifier.startsWith(".")) visit(path.resolve(path.dirname(file), specifier));
    }
  };
  visit(entry);
  return [...files];
}

describe.skipIf(!hasBuiltWebEntries)("web package entries", () => {
  it("keeps the client entry and every relative dependency host-side", () => {
    const offenders = clientImportGraph(clientEntry).flatMap((file) => {
      const source = readFileSync(file, "utf8");
      return forbiddenClientText
        .filter((text) => source.includes(text))
        .map((text) => `${path.relative(repoRoot, file)}: ${text}`);
    });
    expect(offenders).toEqual([]);
  });

  it("exports exactly the host-side runtime API", async () => {
    const module = await import(clientEntry);
    expect(Object.keys(module).toSorted()).toEqual([
      "BUILD_INFO",
      "SHELLCHECK_VERSION",
      "createShellCheck",
    ]);
  });

  it("ships the browser worker as a GPL classic script", () => {
    const source = readFileSync(browserWorker, "utf8");
    expect(source.startsWith("/*! SPDX-License-Identifier: GPL-3.0-or-later */")).toBe(true);
    expect(source).not.toContain("import.meta");
    expect(source).not.toMatch(/^\s*(?:import|export)\b/m);
  });
});
