import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const versionFile = resolve(repoRoot, "buildtools/wasm/version.txt");
const outFile = resolve(repoRoot, "src/generated/version.ts");

const version = readFileSync(versionFile, "utf8").trim();
if (!/^v\d+\.\d+\.\d+$/.test(version)) {
  console.error(
    `gen-version: ${versionFile} must contain a tag like v0.11.0, got ${JSON.stringify(version)}`,
  );
  process.exit(1);
}

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, `export const SHELLCHECK_VERSION = ${JSON.stringify(version)} as const;\n`);
