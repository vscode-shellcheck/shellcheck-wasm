# @vscode-shellcheck/shellcheck-wasm

[ShellCheck](https://www.shellcheck.net/) compiled to WebAssembly, with a minimal runner. The
package ships `shellcheck.wasm`, a WASI command module built from a pinned ShellCheck release, and
a small TypeScript API that runs it once per call with the arguments, stdin and directories you
provide. Output is byte-identical to the native `shellcheck` binary of the same version, so
existing `-f json1` / `-f gcc` / `-f checkstyle` consumers work unchanged. The module uses wasm
tail calls and therefore needs Node.js 22 or later, or a current Chromium, Firefox or Safari
(18.2+).

## Install

```sh
npm install @vscode-shellcheck/shellcheck-wasm
```

## Usage

Compile the module once and reuse it; each `run` creates a fresh instance. The compiled
`WebAssembly.Module` can also be sent to a Worker with `postMessage`.

```ts
import { loadModule, createReadOnlyPreopen } from "@vscode-shellcheck/shellcheck-wasm/node";
import { run, SHELLCHECK_VERSION } from "@vscode-shellcheck/shellcheck-wasm";

const module = await loadModule(); // once; reuse across runs

// Expose the workspace read-only at "/" so ShellCheck can find .shellcheckrc and follow `source`.
const preopen = createReadOnlyPreopen("/path/to/workspace");
const result = run(module, {
  args: ["-f", "json1", "-s", "bash", "-"],
  stdin: script,
  env: { PWD: "/sub/dir" }, // guest path of the script's directory, inside the preopen
  preopens: [preopen],
});
preopen.dispose();

// result.exitCode: 0 = no findings, 1 = findings; result.stdout holds the json1 bytes
const findings = JSON.parse(new TextDecoder().decode(result.stdout));
console.log(SHELLCHECK_VERSION); // e.g. "v0.11.0"
```

### Entry points

- `@vscode-shellcheck/shellcheck-wasm` — `run`, `wasmUrl` (a `URL` of the bundled module),
  `SHELLCHECK_VERSION`, and the `RunOptions` / `RunResult` types.
- `@vscode-shellcheck/shellcheck-wasm/node` — everything above plus `wasmPath`, `loadModule()`,
  `createReadOnlyPreopen(hostDir, guestPath = "/")` and the `ReadOnlyPreopen` type.
- `@vscode-shellcheck/shellcheck-wasm/shellcheck.wasm` — the artifact itself.
- `@vscode-shellcheck/shellcheck-wasm/build-info.json` — toolchain metadata for the artifact (see below).
- `@vscode-shellcheck/shellcheck-wasm/package.json` — the package manifest.

The root entry point has no Node-specific imports and runs anywhere `WebAssembly` and
`@bjorn3/browser_wasi_shim` do. `preopens` accepts any `Fd` from that shim, so a browser host can
supply an in-memory directory instead of `createReadOnlyPreopen`.

### `run(module, options)`

- `args` — ShellCheck arguments without the program name, e.g. `["-f", "json1", "-s", "bash", "-"]`.
- `stdin` — `string` or `Uint8Array`; pass `-` in `args` to lint it.
- `env` — guest environment. `PWD` is the guest working directory and must be a path inside one of
  `preopens`, or left unset. ShellCheck resolves `.shellcheckrc` lookup and relative `source`
  paths from it. If `PWD` points outside every preopen the runtime cannot change into it: the run
  exits with code 1, empty stdout and `hs_init_ghc: chdir(...) failed` on stderr.
- `preopens` — directories the guest may read, assigned fd 3, 4, … in order. `createReadOnlyPreopen`
  serves a host directory read-only; paths that resolve outside it, including through symlinks,
  are refused. Call `dispose()` after the run to close any host file descriptors the guest left
  open.

Returns `{ stdout, stderr, exitCode }` with `Uint8Array` streams. Exit codes are ShellCheck's own:
`0` no findings, `1` findings, `2` and above when files could not be processed or the invocation
was invalid. Traps inside the module propagate as exceptions.

The runner is synchronous and deliberately small: it does not spawn threads, cannot be cancelled,
and applies no filesystem policy beyond what the preopens you pass allow. Run it in a Worker if the
calling thread must stay responsive, and add watchdogs or sandboxing in the host.

### Bundlers and VSIX packaging

`wasmUrl` and `wasmPath` resolve relative to the installed package, so they keep working when
`node_modules` is shipped as-is. When a bundler rewrites module locations, copy the artifact
explicitly and load it yourself:

```ts
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const wasmFile = require.resolve("@vscode-shellcheck/shellcheck-wasm/shellcheck.wasm");
// or, in ESM: import.meta.resolve("@vscode-shellcheck/shellcheck-wasm/shellcheck.wasm")

const module = await WebAssembly.compile(await fs.readFile(wasmFile));
```

`run` accepts any `WebAssembly.Module` compiled from the artifact; `loadModule` is a convenience.

## `build-info.json`

Describes how the bundled artifact was produced:

| Field               | Meaning                                                     |
| ------------------- | ----------------------------------------------------------- |
| `shellcheckVersion` | ShellCheck release tag, equal to `SHELLCHECK_VERSION`       |
| `ghcWasmMetaCommit` | `ghc-wasm-meta` commit that provided the toolchain           |
| `ghcVersion`        | GHC version used                                             |
| `cabalVersion`      | cabal version used                                           |
| `wasmOptVersion`    | binaryen `wasm-opt` version used for the final optimisation  |
| `cflags`            | C compiler flags baked into the toolchain                    |
| `targetFeatures`    | wasm features the artifact requires, e.g. `"+tail-call"`     |
| `sha256`            | SHA-256 of `shellcheck.wasm`                                 |
| `size`              | size of `shellcheck.wasm` in bytes                           |

The same three files (`shellcheck.wasm`, `shellcheck.wasm.sha256`, `build-info.json`) are attached
to every GitHub Release.

## Versioning

The package follows its own semver and bumps whenever the runner, typings or packaging change. The
bundled ShellCheck release is exposed as `SHELLCHECK_VERSION` and in `build-info.json`; a new
ShellCheck release ships as a new package version, and a package release may keep the same
ShellCheck version.

## License

GPL-3.0-or-later, same as ShellCheck. ShellCheck is copyright Vidar Holen and contributors; this
wrapper is a derivative work.
