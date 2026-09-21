# @vscode-shellcheck/shellcheck-wasm

[ShellCheck](https://www.shellcheck.net/) compiled to a WASI command module, plus a minimal
runner. This package exists primarily as the WebAssembly runtime of the
[vscode-shellcheck](https://github.com/vscode-shellcheck/vscode-shellcheck) extension; other Node.js
hosts can use it the same way. Output is byte-identical to the native `shellcheck` binary of the
same version. The module uses wasm tail calls and requires Node.js 22 or later.

## Install

```sh
npm install @vscode-shellcheck/shellcheck-wasm
```

## Usage

```ts
import { loadModule, createReadOnlyPreopen, run } from "@vscode-shellcheck/shellcheck-wasm/node";

const module = await loadModule(); // compile once, reuse for every run

const preopen = createReadOnlyPreopen("/path/to/workspace"); // visible to ShellCheck as "/"
const result = run(module, {
  args: ["-f", "json1", "-s", "bash", "-"],
  stdin: script,
  env: { PWD: "/sub/dir" }, // guest path of the script's directory, inside the preopen
  preopens: [preopen],
});
preopen.dispose();

const { comments } = JSON.parse(new TextDecoder().decode(result.stdout));
```

`exitCode` is ShellCheck's own: `0` no findings, `1` findings, `2` or higher for invalid input.
`PWD` must be a path inside one of the preopens, or unset. The runner is synchronous and does no
threading, cancellation or filesystem policy; those are host concerns.

## Entry points

| Subpath             | Provides                                                                                                          |
| ------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `.`                 | `run`, `wasmUrl`, `SHELLCHECK_VERSION`, `RunOptions`, `RunResult`; no Node imports                                |
| `./node`            | The above plus `loadModule`, `createReadOnlyPreopen`, `readBuildInfo`, `wasmPath`, `ReadOnlyPreopen`, `BuildInfo` |
| `./build-info`      | `readBuildInfo`, `BuildInfo`: toolchain and feature metadata for the bundled module, without the runner           |
| `./shellcheck.wasm` | The compiled ShellCheck module                                                                                    |
| `./package.json`    | The package manifest                                                                                              |

Bundlers that relocate modules can copy the artifact from
`require.resolve("@vscode-shellcheck/shellcheck-wasm/shellcheck.wasm")` and pass their own
`WebAssembly.Module` to `run`.

## Versioning

The package follows its own semver, independent of the bundled ShellCheck release exposed as
`SHELLCHECK_VERSION`; `readBuildInfo()` describes the build that produced the artifact.

## License

GPL-3.0-or-later, same as ShellCheck. ShellCheck is copyright Vidar Holen and contributors; this
wrapper is a derivative work.
