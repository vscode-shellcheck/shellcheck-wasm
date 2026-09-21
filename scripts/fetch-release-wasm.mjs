#!/usr/bin/env node
// Download shellcheck.wasm, shellcheck.wasm.sha256 and build-info.json from the latest
// GitHub Release of this repository into dist/, verifying the sha256.
//
// Env: GITHUB_REPOSITORY (default vscode-shellcheck/shellcheck-wasm), GITHUB_TOKEN (optional),
// GITHUB_API_URL (default https://api.github.com).
// Exit codes: 0 ok, 3 no release exists (callers fall back to building), 1 any other error.

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const EXIT_NO_RELEASE = 3;
const ASSETS = ["shellcheck.wasm", "shellcheck.wasm.sha256", "build-info.json"];

const repo = process.env.GITHUB_REPOSITORY || "vscode-shellcheck/shellcheck-wasm";
const apiUrl = (process.env.GITHUB_API_URL || "https://api.github.com").replace(/\/+$/, "");
const distDir = fileURLToPath(new URL("../dist/", import.meta.url));

function headers(accept) {
  const h = {
    Accept: accept,
    "User-Agent": "shellcheck-wasm/fetch-release-wasm",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (process.env.GITHUB_TOKEN) h.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return h;
}

async function fetchLatestRelease() {
  const url = `${apiUrl}/repos/${repo}/releases/latest`;
  const res = await fetch(url, { headers: headers("application/vnd.github+json") });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`GET ${url} failed: ${res.status} ${res.statusText}\n${await res.text()}`);
  }
  return res.json();
}

async function downloadAsset(asset) {
  const res = await fetch(asset.url, { headers: headers("application/octet-stream") });
  if (!res.ok) {
    throw new Error(`download of ${asset.name} failed: ${res.status} ${res.statusText}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function main() {
  const release = await fetchLatestRelease();
  if (release === null) {
    console.error(`no GitHub Release found for ${repo}`);
    return EXIT_NO_RELEASE;
  }

  const byName = new Map(release.assets.map((a) => [a.name, a]));
  const missing = ASSETS.filter((name) => !byName.has(name));
  if (missing.length > 0) {
    const available = release.assets.map((a) => a.name).join(", ") || "none";
    throw new Error(
      `release ${release.tag_name} of ${repo} lacks asset(s): ${missing.join(", ")} (available: ${available})`,
    );
  }

  const files = new Map();
  for (const name of ASSETS) {
    files.set(name, await downloadAsset(byName.get(name)));
  }

  const expected = new TextDecoder()
    .decode(files.get("shellcheck.wasm.sha256"))
    .trim()
    .split(/\s+/)[0];
  const actual = sha256(files.get("shellcheck.wasm"));
  if (!/^[0-9a-f]{64}$/.test(expected) || expected !== actual) {
    throw new Error(`sha256 mismatch for shellcheck.wasm: expected ${expected}, got ${actual}`);
  }

  await mkdir(distDir, { recursive: true });
  for (const [name, bytes] of files) {
    await writeFile(join(distDir, name), bytes);
  }
  console.log(
    `fetched ${ASSETS.join(", ")} from ${repo} release ${release.tag_name} into ${distDir}`,
  );
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    const cause = err?.cause ? `: ${err.cause.message ?? err.cause}` : "";
    console.error(`${err instanceof Error ? err.message : err}${cause}`);
    process.exit(1);
  },
);
