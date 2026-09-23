import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const infoFile = resolve(repoRoot, "dist/build-info.json");
const wasmFile = resolve(repoRoot, "dist/shellcheck.wasm");
const versionFile = resolve(repoRoot, "buildtools/wasm/version.txt");
const outFile = resolve(repoRoot, "src/generated/build-info.ts");

/** Field name → expected `typeof`, in the order `src/build-info.ts` declares them. */
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
};

function fail(message) {
  console.error(`gen-build-info: ${message}`);
  process.exit(1);
}

let info;
let wasm;
try {
  info = JSON.parse(readFileSync(infoFile, "utf8"));
  wasm = readFileSync(wasmFile);
} catch (error) {
  fail(
    `${error.message}\nPut the artifact and its build-info.json in dist/: \`npm run build:wasm\` (Docker) or download both from a GitHub Release.`,
  );
}

const keys = Object.keys(info).toSorted();
if (JSON.stringify(keys) !== JSON.stringify(Object.keys(FIELDS).toSorted())) {
  fail(`${infoFile} has fields ${keys.join(", ")}; update src/build-info.ts and this script`);
}
for (const [field, type] of Object.entries(FIELDS)) {
  if (typeof info[field] !== type) fail(`${field} in ${infoFile} is not a ${type}`);
}
if (!Array.isArray(info.targetFeatures) || info.targetFeatures.some((f) => typeof f !== "string")) {
  fail(`targetFeatures in ${infoFile} is not a list of strings`);
}

// A build-info.json from a different build than the artifact would describe the wrong module.
const sha256 = createHash("sha256").update(wasm).digest("hex");
if (info.sha256 !== sha256 || info.size !== wasm.byteLength) {
  fail(
    `${infoFile} describes a different shellcheck.wasm (sha256 ${info.sha256}, actual ${sha256})`,
  );
}
const version = readFileSync(versionFile, "utf8").trim();
if (info.shellcheckVersion !== version) {
  fail(`${infoFile} is for ShellCheck ${info.shellcheckVersion}, version.txt pins ${version}`);
}

const ordered = Object.fromEntries(Object.keys(FIELDS).map((field) => [field, info[field]]));
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(
  outFile,
  `import type { BuildInfo } from "../build-info.js";

export const BUILD_INFO: BuildInfo = ${JSON.stringify(ordered, null, 2)};
`,
);
