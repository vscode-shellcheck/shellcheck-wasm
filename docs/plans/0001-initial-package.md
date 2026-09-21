# Plan: initial `@vscode-shellcheck/shellcheck-wasm` package

Status: approved 2026-09-21. Glossary: `CONTEXT.md`. Decisions: `docs/adr/`.

## Goal

An npm package that ships ShellCheck compiled to a WASI **command module**
(`shellcheck.wasm`) plus a thin TypeScript **runner**, built reproducibly in
GitHub Actions from a pinned ShellCheck release with a current
`ghc-wasm-meta` and wasm **tail calls** enabled. First consumer:
vscode-shellcheck PR #1952, which today downloads a prebuilt wasm from
`wasilibs/go-shellcheck` and wants to replace that with this package.

## Fixed decisions (do not re-open)

| Topic | Decision |
|---|---|
| Package name | `@vscode-shellcheck/shellcheck-wasm` |
| License | `GPL-3.0-or-later`. README wording: "GPL-3.0-or-later, same as ShellCheck. ShellCheck is copyright Vidar Holen and contributors; this wrapper is a derivative work." |
| Versioning | Package semver independent of ShellCheck. ShellCheck tag lives only in `buildtools/wasm/version.txt`. |
| Module system | TypeScript, ESM-only (`"type": "module"`), `engines.node >= 22` |
| Package manager | npm (lockfile committed) |
| Lint / format | oxlint + oxfmt |
| Tests | vitest |
| Runtime dep | only `@bjorn3/browser_wasi_shim` (`^0.4.2`) |
| WASI host | `@bjorn3/browser_wasi_shim`, never `node:wasi` (segfaults with preopens on Node 22, leaks fds on Node 24) |
| Runner scope | synchronous, one run per `WebAssembly.Instance`; no Worker, watchdog, cancellation or filesystem policy |
| Artifact location | `dist/shellcheck.wasm`, not committed to git |
| Tail-call gate | build fails if final wasm `target_features` lacks `+tail-call` |
| Parity | stdout, stderr and exit code byte-identical to native ShellCheck of the same version |
| Build | Docker, two stages, in GitHub Actions with `type=gha` layer cache |
| Release | manual tag `v*` → build → test → `npm publish --provenance` (Trusted Publishing, OIDC) → GitHub Release with assets |
| Bump | daily workflow opens a PR when upstream has a newer release |

## Repository layout (target)

```
AGENTS.md                      agent-facing repo guide (primary)
CLAUDE.md                      single line: @AGENTS.md
CONTEXT.md                     glossary (exists)
README.md
LICENSE                        GPL-3.0 text
package.json  package-lock.json  tsconfig.json  tsconfig.build.json
.oxlintrc.json  .oxfmtrc.json  vitest.config.ts  .gitignore  .gitattributes
.github/
  dependabot.yml               github-actions + npm, weekly
  workflows/ci.yml  release.yml  bump-shellcheck.yml
buildtools/wasm/
  Dockerfile
  version.txt                  ShellCheck tag, e.g. `v0.11.0` (single source of truth)
  shellcheck-src.sha256        sha256 of the upstream source tarball for that tag
  ghc-wasm-meta.txt            ghc-wasm-meta commit SHA
  cabal.project                cabal config copied into the ShellCheck source tree
  check-target-features.py     tail-call gate + prints features as JSON
  write-build-info.sh          produces build-info.json inside the image
scripts/
  build-wasm.sh                docker build → dist/{shellcheck.wasm,shellcheck.wasm.sha256,build-info.json}
  fetch-release-wasm.mjs       download the same three files from the latest GitHub Release into dist/ (CI fast path)
  fetch-native-shellcheck.sh   download native ShellCheck for version.txt into .cache/native/shellcheck (parity tests)
  gen-version.mjs              version.txt → src/generated/version.ts (gitignored)
src/
  index.ts                     isomorphic entry: run, wasmUrl, SHELLCHECK_VERSION, types
  runner.ts                    run() implementation
  fds.ts                       MemoryInput / MemoryOutput Fd classes for stdin/stdout/stderr
  node.ts                      Node entry: wasmPath, loadModule, createReadOnlyPreopen
  host-preopen.ts              read-only node:fs-backed Fd (the preopen)
  generated/version.ts         generated, gitignored
test/
  fixtures/...                 shell scripts and .shellcheckrc trees
  runner.test.ts  preopen.test.ts  parity.test.ts  package.test.ts
docs/adr/  docs/plans/
```

## Workstream A — wasm build + CI/CD

### A1. `buildtools/wasm/Dockerfile`

Two named stages plus an export stage. Reference (adapt, do not copy):

```dockerfile
FROM debian:13-slim AS toolchain
RUN apt-get update && apt-get install -y --no-install-recommends \
      binaryen build-essential ca-certificates curl git jq python3 unzip xz-utils zstd \
    && rm -rf /var/lib/apt/lists/*
ARG GHC_WASM_META_COMMIT
WORKDIR /ghc
RUN curl -fL --retry 5 "https://gitlab.haskell.org/haskell-wasm/ghc-wasm-meta/-/archive/${GHC_WASM_META_COMMIT}/ghc-wasm-meta-${GHC_WASM_META_COMMIT}.tar.gz" \
    | tar xz --strip-components=1
# -mtail-call is opt-in; the default bindists ship without it (disabled upstream 2025-09).
ENV WASM_CFLAGS="-Wno-error=int-conversion -O3 -mcpu=lime1 -mreference-types -msimd128 -mtail-call"
RUN CONF_CC_OPTS_STAGE1="$WASM_CFLAGS" CONF_CXX_OPTS_STAGE1="-fno-exceptions $WASM_CFLAGS" \
    CONF_CC_OPTS_STAGE2="$WASM_CFLAGS" CONF_CXX_OPTS_STAGE2="-fno-exceptions $WASM_CFLAGS" \
    ./setup.sh

FROM toolchain AS build
ARG SHELLCHECK_VERSION
ARG SHELLCHECK_SRC_SHA256
WORKDIR /shellcheck
RUN curl -fL --retry 5 -o src.tar.gz "https://github.com/koalaman/shellcheck/archive/refs/tags/${SHELLCHECK_VERSION}.tar.gz" \
    && echo "${SHELLCHECK_SRC_SHA256}  src.tar.gz" | sha256sum -c - \
    && tar xz --strip-components=1 -f src.tar.gz && rm src.tar.gz
RUN ./striptests
COPY cabal.project ./cabal.project
# cabal's hackage mirror returns 403 for this tarball; pre-seed it. Keep the version in sync with cabal.project's index-state resolution.
RUN mkdir -p /root/.ghc-wasm/.cabal/packages/hackage.haskell.org/fgl/5.8.3.1 \
    && curl -fL https://hackage.haskell.org/package/fgl-5.8.3.1.tar.gz \
       -o /root/.ghc-wasm/.cabal/packages/hackage.haskell.org/fgl/5.8.3.1/fgl-5.8.3.1.tar.gz
RUN . ~/.ghc-wasm/env && wasm32-wasi-cabal update && wasm32-wasi-cabal build exe:shellcheck
RUN . ~/.ghc-wasm/env && wasm-opt --enable-tail-call --flatten --rereloop --converge -O3 \
      -o /out/shellcheck.wasm "$(wasm32-wasi-cabal list-bin exe:shellcheck)"
COPY check-target-features.py write-build-info.sh /tools/
RUN python3 /tools/check-target-features.py /out/shellcheck.wasm --require tail-call > /out/target-features.json
RUN . ~/.ghc-wasm/env && sh /tools/write-build-info.sh /out   # needs SHELLCHECK_VERSION, GHC_WASM_META_COMMIT

FROM scratch AS artifact
COPY --from=build /out/shellcheck.wasm /out/shellcheck.wasm.sha256 /out/build-info.json /
```

Requirements:
- `mkdir -p /out` where needed. Verify `wasm-opt` actually keeps the `target_features` custom section; if it strips it, re-check with the pre-opt binary AND assert the post-opt binary still validates with `wasm-tools validate --features all` (wasm-tools ships in `~/.ghc-wasm`, on PATH after `. ~/.ghc-wasm/env`).
- `write-build-info.sh` writes `/out/shellcheck.wasm.sha256` (`sha256sum` format, filename `shellcheck.wasm`) and `/out/build-info.json`:
  ```json
  {
    "shellcheckVersion": "v0.11.0",
    "ghcWasmMetaCommit": "<sha>",
    "ghcVersion": "<wasm32-wasi-ghc --numeric-version>",
    "cabalVersion": "<wasm32-wasi-cabal --numeric-version>",
    "wasmOptVersion": "<wasm-opt --version>",
    "cflags": "<WASM_CFLAGS>",
    "targetFeatures": ["+tail-call", "+simd128", ...],
    "sha256": "<hex>",
    "size": 1234567
  }
  ```
  No timestamps (keep the file reproducible).
- `check-target-features.py`: stdlib-only. Parse the wasm binary (magic, version, sections; custom section id 0 named `target_features`: vec of (prefix byte `+`/`-`, name)). Print JSON array of `"+name"` strings. `--require <feature>` (repeatable) exits 1 with a clear message when a required `+feature` is missing. Also fail if the section is absent.

### A2. Pins

- `buildtools/wasm/version.txt`: `v0.11.0`
- `buildtools/wasm/shellcheck-src.sha256`: compute with `curl -fL https://github.com/koalaman/shellcheck/archive/refs/tags/v0.11.0.tar.gz | sha256sum`
- `buildtools/wasm/ghc-wasm-meta.txt`: `1fb547741c9665d2c05ee4e3fc73c715b2ff65a1`
- `buildtools/wasm/cabal.project`:
  ```
  packages: .
  optimization: 2
  index-state: hackage.haskell.org <recent ISO timestamp, pick today's date>
  -- ShellCheck 0.11 bounds predate GHC 9.14; allow newer boot libraries.
  allow-newer: ShellCheck:*
  package ShellCheck
    ghc-options: -rtsopts
  ```
  If the `ShellCheck:*` form fails to solve, fall back to an explicit list (base, aeson, array, bytestring, containers, deepseq, directory, fgl, filepath, mtl, parsec, QuickCheck, regex-tdfa, transformers). Check whether the upstream tarball already ships a `cabal.project`; ours overwrites it.

### A3. `scripts/build-wasm.sh`

Bash, `set -euo pipefail`. Reads the three pin files, runs
`docker build -f buildtools/wasm/Dockerfile --target artifact --output type=local,dest=dist --build-arg ... buildtools/wasm`.
Honors `DOCKER=podman` override. Prints the resulting `build-info.json`.

### A4. `scripts/fetch-release-wasm.mjs`

Node ESM, no deps. Uses `GITHUB_TOKEN` if present. Finds the latest GitHub
Release of this repo (`GITHUB_REPOSITORY` env or `vscode-shellcheck/shellcheck-wasm`),
downloads `shellcheck.wasm`, `shellcheck.wasm.sha256`, `build-info.json` into
`dist/`, verifies sha256. Exits 3 (distinct code) when no release exists so CI
can fall back to building.

### A5. `scripts/fetch-native-shellcheck.sh`

Downloads `https://github.com/koalaman/shellcheck/releases/download/<tag>/shellcheck-<tag>.linux.x86_64.tar.xz`
(aarch64 when `uname -m` says so; darwin variants exist too) into
`.cache/native/shellcheck`, idempotent. Prints the path.

### A6. Workflows

`ci.yml` — on `pull_request` and `push` to `main`:
1. `plan` job: `dorny/paths-filter` on `buildtools/**`, `.github/workflows/ci.yml`; plus `gh release view --json tagName` to detect whether any release exists. Output `build=true|false`.
2. `build-wasm` (if `build`): `docker/setup-buildx-action`, `docker/build-push-action` with `file: buildtools/wasm/Dockerfile`, `target: artifact`, `outputs: type=local,dest=dist`, `build-args` from the pin files, `cache-from: type=gha`, `cache-to: type=gha,mode=max`. Upload `dist/` as artifact `shellcheck-wasm`. `timeout-minutes: 180`.
3. `fetch-wasm` (else): `node scripts/fetch-release-wasm.mjs`; upload the same artifact name.
4. `test`: needs both (use `if: always()` + result checks so one skipped job doesn't cancel it); matrix `node: [22, 24]`; download artifact into `dist/`; `scripts/fetch-native-shellcheck.sh`; `npm ci`, `npm run build`, `npm run lint`, `npm run fmt:check`, `npm test`, `npm pack --dry-run --json` and assert the tarball contains `dist/shellcheck.wasm`.

`release.yml` — on `push` tags `v*`:
- `permissions: contents: write, id-token: write`
- always builds (same build step as CI), runs the full test job on Node 24, then `npm publish --provenance --access public` (Node 24 → npm ≥ 11.5 for Trusted Publishing; no `NODE_AUTH_TOKEN`), then `gh release create "$TAG" dist/shellcheck.wasm dist/shellcheck.wasm.sha256 dist/build-info.json --generate-notes`.
- Guard: fail early if `package.json` version ≠ tag without `v`.

`bump-shellcheck.yml` — `schedule: cron "17 3 * * *"` + `workflow_dispatch`:
- `gh api repos/koalaman/shellcheck/releases/latest --jq .tag_name`; if equal to `version.txt`, exit.
- Write `version.txt`, recompute `shellcheck-src.sha256` from the tarball.
- `peter-evans/create-pull-request` with branch `bump/shellcheck-<tag>`, title `chore(wasm): bump ShellCheck to <tag>`, body linking the upstream release. `permissions: contents: write, pull-requests: write`.

`dependabot.yml`: `github-actions` and `npm`, weekly, grouped minor/patch.

### A7. Constraints for workstream A

- Docker is not available on the dev machine; the Dockerfile is validated by
  review and by CI. Keep every `RUN` line independently sensible; put
  `apt-get`, toolchain download and `setup.sh` in separate layers so cache hits
  survive edits below them.
- `setup.sh` deletes and recreates `$PREFIX` (`~/.ghc-wasm`); do not put files
  there before it runs.
- Pin every third-party action to a major tag (`@v4`), Dependabot keeps them fresh.

## Workstream B — npm package, runner, tests

### B1. `package.json`

```jsonc
{
  "name": "@vscode-shellcheck/shellcheck-wasm",
  "version": "0.1.0",
  "description": "ShellCheck compiled to WebAssembly (WASI command module) with a minimal runner",
  "license": "GPL-3.0-or-later",
  "type": "module",
  "engines": { "node": ">=22" },
  "files": ["dist", "README.md", "LICENSE"],
  "exports": {
    ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
    "./node": { "types": "./dist/node.d.ts", "default": "./dist/node.js" },
    "./shellcheck.wasm": "./dist/shellcheck.wasm",
    "./build-info.json": "./dist/build-info.json",
    "./package.json": "./package.json"
  },
  "sideEffects": false,
  "repository": "github:vscode-shellcheck/shellcheck-wasm",
  "publishConfig": { "access": "public" },
  "scripts": {
    "gen:version": "node scripts/gen-version.mjs",
    "build": "npm run gen:version && tsc -p tsconfig.build.json",
    "build:wasm": "scripts/build-wasm.sh",
    "fetch:wasm": "node scripts/fetch-release-wasm.mjs",
    "fetch:native": "scripts/fetch-native-shellcheck.sh",
    "lint": "oxlint",
    "fmt": "oxfmt",
    "fmt:check": "oxfmt --check",
    "test": "vitest run",
    "prepack": "node -e \"require('node:fs').accessSync('dist/shellcheck.wasm')\""
  },
  "dependencies": { "@bjorn3/browser_wasi_shim": "^0.4.2" },
  "devDependencies": { "typescript", "vitest", "oxlint", "oxfmt", "@types/node": "^22" }
}
```
`prepack` guards against publishing without the artifact. Use current stable
versions from the registry for devDependencies.

`tsconfig`: `module: NodeNext`, `target: ES2022`, `strict`, `verbatimModuleSyntax`,
`declaration`, `outDir: dist`, `rootDir: src`. `tsconfig.build.json` excludes tests.

`.gitignore`: `node_modules/`, `dist/`, `.cache/`, `src/generated/`.
`.gitattributes`: `* text=auto eol=lf`, `*.wasm binary`.

### B2. `scripts/gen-version.mjs`

Reads `buildtools/wasm/version.txt`, writes `src/generated/version.ts`:
`export const SHELLCHECK_VERSION = "v0.11.0" as const;` — trimmed, must match `/^v\d+\.\d+\.\d+$/`.

### B3. `src/index.ts` (isomorphic; no `node:` imports)

```ts
export { run } from "./runner.js";
export type { RunOptions, RunResult } from "./runner.js";
export { SHELLCHECK_VERSION } from "./generated/version.js";
/** URL of the bundled shellcheck.wasm, resolved relative to this module. */
export const wasmUrl: URL = new URL("./shellcheck.wasm", import.meta.url);
```

### B4. `src/runner.ts` + `src/fds.ts`

```ts
import type { Fd } from "@bjorn3/browser_wasi_shim";

export interface RunOptions {
  /** ShellCheck arguments, without argv[0]. Example: ["-f", "json1", "-s", "bash", "-"] */
  args: readonly string[];
  /** Script or other data for stdin. Default: empty. */
  stdin?: string | Uint8Array;
  /** Environment. PWD must be a guest path inside a preopen, or unset: the GHC RTS chdir()s to PWD at startup and aborts if that fails. */
  env?: Readonly<Record<string, string>>;
  /** Preopened directories, assigned fd 3, 4, … in order. See createReadOnlyPreopen in ./node. */
  preopens?: readonly Fd[];
}
export interface RunResult { stdout: Uint8Array; stderr: Uint8Array; exitCode: number }

export function run(module: WebAssembly.Module, options: RunOptions): RunResult
```
Implementation:
- argv = `["shellcheck", ...args]` (ShellCheck reads its own name from argv[0]).
- env as `["K=V", ...]`.
- fds = `[MemoryInput(stdin), MemoryOutput(), MemoryOutput(), ...preopens]`.
- `const wasi = new WASI(argv, env, fds, { debug: false })`;
  `const instance = new WebAssembly.Instance(module, { wasi_snapshot_preview1: wasi.wasiImport })`;
  `const exitCode = wasi.start(instance)` — returns 0 or the `proc_exit` code (shim catches `WASIProcExit`). Any other exception propagates.
- `MemoryInput extends Fd`: `fd_read` serves from a cursor over the bytes, `fd_fdstat_get` reports `FILETYPE_CHARACTER_DEVICE`... check what the shim's `OpenFile`/`ConsoleStdout` do and mirror them so ShellCheck's `hGetContents stdin` works (Haskell's IO checks `isatty`/fstat). Simplest robust choice: `new OpenFile(new File(bytes))` for stdin (regular file, works with GHC); custom `MemoryOutput` modelled on `ConsoleStdout` (character device, accumulate every `fd_write` chunk, concat on read-out).
- Node: `WebAssembly.Module` may be posted across Worker boundaries by the host; `run` must not hold module state between calls.

### B5. `src/node.ts` + `src/host-preopen.ts`

```ts
export { wasmUrl, SHELLCHECK_VERSION, run } from "./index.js";
export const wasmPath: string = fileURLToPath(wasmUrl);
/** Reads and compiles the bundled artifact. Hosts should call this once and reuse the Module. */
export async function loadModule(): Promise<WebAssembly.Module>;
/** A read-only WASI preopen backed by the host filesystem, mounted at guestPath (default "/"). */
export function createReadOnlyPreopen(hostDir: string, guestPath?: string): Fd;
```
`createReadOnlyPreopen` requirements:
- Sync `node:fs` only (the runner is synchronous).
- `fd_prestat_get` / `fd_prestat_dir_name` expose `guestPath`; `path_open` resolves guest relative paths under `hostDir`; every mutating call (`path_create_directory`, `path_unlink_file`, `fd_write` on files, `path_rename`, `path_symlink`, `fd_allocate`, `fd_filestat_set_*`, `path_filestat_set_times`, open with `O_CREAT|O_TRUNC` or write rights) returns `ERRNO_ROFS`.
- Containment: after `fs.realpathSync` of the target, require it to start with `realpath(hostDir) + sep` (or equal); otherwise `ERRNO_NOTCAPABLE`. Symlinks pointing outside are therefore invisible. `..` components are resolved before the check.
- Must support what ShellCheck needs: `path_open` of files and directories, `fd_read`, `fd_seek`, `fd_tell`, `fd_close`, `fd_filestat_get`, `path_filestat_get` (with and without `LOOKUPFLAGS_SYMLINK_FOLLOW`), `fd_readdir` (with cookie handling), `fd_fdstat_get`, `path_readlink`. Missing file → `ERRNO_NOENT`, directory-as-file → `ERRNO_ISDIR`, etc.
- Cap open fds per preopen at 256 → `ERRNO_NFILE`. Track opened `fs` fds and close all in a `dispose()` method (also export it on the returned object type `ReadOnlyPreopen extends Fd { dispose(): void }`).
- Reference implementation exists in vscode-shellcheck PR #1952 (`src/runtime/wasm/host-fs.ts` in `/tmp/1952.diff` if still present; otherwise `curl -sL https://patch-diff.githubusercontent.com/raw/vscode-shellcheck/vscode-shellcheck/pull/1952.diff`). Use it to learn which WASI calls ShellCheck exercises; write our own code against the shim's `Fd` API.

### B6. Tests (`vitest`)

Local test artifact: there is no docker locally. For development, obtain a
0.11.0 command-module wasm as a stand-in: `curl -fL -o dist/shellcheck.wasm https://raw.githubusercontent.com/wasilibs/go-shellcheck/24025c1590296bcce8e494624e8c3561740a32a4/internal/wasm/shellcheck.wasm` (sha256 `f9d99fa45ae12d5b735425e6a32f6ea3cc550095b1e82ec1b770141470278c20`).
Document this in AGENTS.md as the dev shortcut; CI always uses our own build.
Do not commit it.

All suites that need the artifact use `describe.skipIf(!existsSync("dist/shellcheck.wasm"))`
and print a hint on skip. Native-dependent suites skip when `.cache/native/shellcheck` is absent
(override path via `SHELLCHECK_NATIVE`).

- `runner.test.ts`: `--version` exits 0 and stdout contains `version: 0.11.0` matching `SHELLCHECK_VERSION`; `-f json1 -s bash -` on `echo $x` yields SC2086 JSON, exit 1; clean script exits 0 with `{"comments":[]}`; `--no-such-flag` exits with code ≥ 2 and stderr non-empty; `stdin` as `Uint8Array` and as string agree; two consecutive `run` calls on the same Module both succeed (fresh Instance each time); env `PWD` set to a path outside any preopen → the run does not hang, result is a non-zero exit or empty stdout (assert the observable behaviour, document it).
- `preopen.test.ts`: fixture tree with `.shellcheckrc` in a parent directory and a script in a child; `run` with `preopens: [createReadOnlyPreopen(fixtureRoot)]`, `env: { PWD: "/child" }`, args `["-f","json1","-"]` honours the rc (e.g. `disable=SC2086` removes the finding). `-x` follows `source ./lib.sh`. Symlink escaping the root → the sourced file is reported as unreadable, never read. `dispose()` closes fds (spy on `fs.closeSync` count or check `/proc/self/fd` delta ≤ 0 over 50 runs).
- `parity.test.ts`: for each scenario, run native (`child_process.spawnSync`, `cwd` = host dir mapping to guest PWD, same args, same stdin) and wasm; assert `Buffer.compare(stdout) === 0`, same exit code, and stderr equal. Scenarios: plain stdin script (`-f json1 -s bash -`), `-f gcc`, `-f checkstyle`, `.shellcheckrc` discovery, `-x` source following, unknown flag error, `--version`, `--list-optional`, a ~500-line fixture (generate deterministic content in the test) to catch buffering bugs.
- `package.test.ts`: `npm pack --dry-run --json` (skip if wasm missing) lists `dist/shellcheck.wasm`, `dist/build-info.json`, `dist/index.js`, `dist/node.js`, `LICENSE`; `build-info.json.shellcheckVersion === SHELLCHECK_VERSION`; `import()` of the built `dist/index.js` and `dist/node.js` works; `require.resolve("@vscode-shellcheck/shellcheck-wasm/shellcheck.wasm")` resolves via a temp `npm pack` + `npm install` into a tmp dir (or via `import.meta.resolve` on a self-referencing package name — self-reference works because `exports` is defined).

`build-info.json` is produced by the Docker build; for local development
against the stand-in wasm, tests that need it must skip when it is absent.

### B7. Lint / format

`.oxlintrc.json` with `typescript` and `unicorn` plugins enabled, `correctness` + `suspicious` as errors. `.oxfmtrc.json` defaults (2-space, double quotes, trailing commas, print width 100). Ensure `npm run lint` and `npm run fmt:check` pass.

## Workstream C — docs (after A and B land)

- `AGENTS.md`: what the repo is (2 lines), layout, `npm` scripts (point at `package.json` rather than re-listing), invariants that nothing else states: `version.txt` is the only place the ShellCheck version lives; the wasm is never committed; a build without `+tail-call` is rejected; parity with native is the acceptance bar; `PWD` must point inside a preopen or be unset; `wasm32-wasi-cabal` wrapper breaks with cabal 3.16 (use the 3.14 that ghc-wasm-meta ships); the dev shortcut for a stand-in wasm; how to bump `ghc-wasm-meta.txt` (also re-check `WASM_CFLAGS` and `index-state`); release procedure. Point to `CONTEXT.md`, `docs/adr/`, `docs/plans/`.
- `CLAUDE.md`: `@AGENTS.md`.
- `README.md`: install, the two entry points with a code sample mirroring the vscode-shellcheck usage (compile once, run per lint; preopen + PWD), `require.resolve(".../shellcheck.wasm")` for bundlers, runtime requirements (wasm tail calls: Node ≥ 22, current browsers), license paragraph from the fixed decisions.
- `LICENSE`: GPL-3.0 text.

## Definition of done

- `npm ci && npm run build && npm run lint && npm run fmt:check && npm test` pass locally against the stand-in wasm + native ShellCheck (parity suites included).
- Workflows are valid YAML and reviewed against the requirements above; the first real build is validated by pushing the branch and watching `ci.yml`.
- `git status` clean except for intentionally ignored `dist/`, `.cache/`, `src/generated/`.
