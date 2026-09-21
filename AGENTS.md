# shellcheck-wasm

npm package `@vscode-shellcheck/shellcheck-wasm`: ShellCheck compiled to a WASI command module
plus a synchronous TypeScript runner. Built in GitHub Actions from pinned inputs; the artifact is
never committed. Vocabulary: `CONTEXT.md` (use its terms). Decisions: `docs/adr/`. Plans: `docs/plans/`.

## Layout

- `buildtools/wasm/` — everything the Docker build reads: `Dockerfile`, pins (`version.txt`,
  `shellcheck-src.sha256`, `ghc-wasm-meta.txt`), `cabal.project`, `build.sh` (every step after
  the sources are unpacked), the tail-call gate script.
- `src/generated/` — written by `npm run build` from `buildtools/wasm/version.txt`; gitignored.
- `dist/` — compiled JS plus `shellcheck.wasm`, `shellcheck.wasm.sha256`, `build-info.json`; gitignored.
- `.cache/native/` — native ShellCheck for the parity suite; gitignored.

## Working locally

Scripts are defined in `package.json`; there is no Docker on the dev machine, so `build:wasm`
is CI-only.

1. `npm ci`
2. Get an artifact into `dist/`: download `shellcheck.wasm` and `build-info.json` from a GitHub
   Release, or use the dev stand-in, the upstream 0.11.0 command module (no tail calls, fine for
   runner and parity tests, never for a release):
   `mkdir -p dist && curl -fL -o dist/shellcheck.wasm https://raw.githubusercontent.com/wasilibs/go-shellcheck/24025c1590296bcce8e494624e8c3561740a32a4/internal/wasm/shellcheck.wasm`
3. `npm run fetch:native`
4. `npm run build && npm run lint && npm run fmt:check && npm test`

Tests print `[skip] …` and skip when `dist/shellcheck.wasm`, the native binary,
`dist/build-info.json` or `LICENSE` is missing; with `CI=1` the same conditions fail
(`test/helpers.ts`). With the stand-in, only the `build-info.json` skip remains.

## Invariants

- `buildtools/wasm/version.txt` is the only place the ShellCheck version lives. Package semver is
  independent of it (ADR 0004).
- Parity is the acceptance bar: stdout, stderr and exit code byte-identical to native ShellCheck
  of the same version (`test/parity.test.ts`).
- The tail-call gate runs on the pre-`wasm-opt` linker output because `wasm-opt --enable-tail-call`
  rewrites `target_features`. `-mtail-call` stays in `WASM_CFLAGS`: ghc-wasm-meta dropped it from
  its defaults in 2025-09, and GHC only emits `return_call` when the flag is baked in.
- Guest `PWD` must be inside a preopen or unset. The GHC RTS chdir()s to it at init; on failure
  the run exits 1 with empty stdout and `hs_init_ghc: chdir(...) failed` on stderr.
- The runner stays free of threads, cancellation and filesystem policy; those are host
  concerns (ADR 0005).
- `wasm32-wasi-cabal` is the wrapper ghc-wasm-meta ships (cabal 3.14.x). The wrapper breaks with
  cabal 3.16; keep the shipped one.

## Changing the toolchain

Bumping `buildtools/wasm/ghc-wasm-meta.txt` means revisiting, in the same PR:

- `WASM_CFLAGS` in the Dockerfile against ghc-wasm-meta's current defaults (keep `-mtail-call`).
- `index-state` in `buildtools/wasm/cabal.project`.
- The pre-seeded `fgl` tarball version in the Dockerfile: it must equal what the solver picks at
  that `index-state`. The pre-seed exists because Hackage's CDN returns 403 to cabal's download.

The Dockerfile is validated by review and by `ci.yml`, which builds the artifact on every run
(Docker layer cache via `type=gha`).

## Releasing

1. `npm version x.y.z --no-git-tag-version`, commit, push, then push tag `vX.Y.Z`.
2. `release.yml` fails unless the tag equals `package.json` version; it builds, tests, runs
   `npm publish --provenance` through npm Trusted Publishing (no token secret; npm-side setup is
   package `@vscode-shellcheck/shellcheck-wasm`, repo `vscode-shellcheck/shellcheck-wasm`,
   workflow `release.yml`), then creates the GitHub Release with `shellcheck.wasm`, `.sha256`
   and `build-info.json`.

`bump-shellcheck.yml` runs daily and opens `chore(wasm): bump ShellCheck to <tag>` PRs. PRs opened
with `github.token` get no CI run; set the `BUMP_PR_TOKEN` secret (PAT or App token) so they do.

## Conventions

- Commits: Conventional Commits, English, imperative subject.
- Add an ADR only for a decision that is hard to reverse, surprising to a newcomer, and a real
  trade-off.
- `oxfmt` ignores `*.md` and `docs/`; prose is not auto-formatted.
