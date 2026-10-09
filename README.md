# @vscode-shellcheck/shellcheck-wasm

[![npm](https://img.shields.io/npm/v/@vscode-shellcheck/shellcheck-wasm)](https://www.npmjs.com/package/@vscode-shellcheck/shellcheck-wasm)
[![License: GPL-3.0-or-later](https://img.shields.io/badge/license-GPL--3.0--or--later-blue)](#license)

[ShellCheck](https://www.shellcheck.net/) for JavaScript hosts, in Node.js or the browser, with
stdout, stderr and exit code byte-identical to the native `shellcheck` binary of the same
version.

> **License:** GPL-3.0-or-later, like ShellCheck. Only the `./client` entry is MIT, so a Host can
> bundle it. See [License](#license).

ShellCheck is compiled to a WASI command module and runs in a Worker you create. It reads files
only through a file system you pass per lint, and no module in the package imports `node:*`.
The package is the WebAssembly runtime of the
[vscode-shellcheck](https://github.com/vscode-shellcheck/vscode-shellcheck) extension.

## Requirements

| Runtime         | Supported                                                         |
| --------------- | ----------------------------------------------------------------- |
| Node.js         | 22 or later                                                       |
| Chrome, Edge    | 112 or later                                                      |
| Firefox         | 121 or later (not ESR 115)                                        |
| Safari          | 18.2 or later (macOS 13 or later, iOS and iPadOS 18.2 or later)   |

The artifact needs wasm tail calls and SIMD, which Safari 16.4 to 18.1 and Firefox ESR 115 lack.
`isArtifactSupported()` reports whether the current engine can compile it, so a Host can say so
instead of surfacing a `CompileError`.

The runner also needs `SharedArrayBuffer`. Browsers only provide it to
[cross-origin isolated](https://developer.mozilla.org/docs/Web/API/Window/crossOriginIsolated)
pages.

## Usage

The Worker entry is a file the Host ships. In Node:

```ts
// shellcheck-worker.ts
import { parentPort } from "node:worker_threads";
import { startWorker } from "@vscode-shellcheck/shellcheck-wasm/worker";

startWorker({
  postMessage: (message) => parentPort!.postMessage(message),
  onMessage: (listener) => parentPort!.on("message", listener),
});
```

On the thread that lints:

```ts
import { readFile } from "node:fs/promises";
import { Worker } from "node:worker_threads";
import { createShellCheck, wasmUrl } from "@vscode-shellcheck/shellcheck-wasm";

const shellcheck = createShellCheck({
  module: WebAssembly.compile(await readFile(wasmUrl)), // compiled once, sent to each Worker
  createWorker() {
    const worker = new Worker(new URL("./shellcheck-worker.js", import.meta.url));
    return {
      postMessage: (message) => worker.postMessage(message),
      onMessage: (listener) => worker.on("message", listener),
      onError: (listener) => worker.on("error", listener),
      onExit: (listener) => worker.on("exit", listener),
      terminate: () => worker.terminate(),
    };
  },
});

const result = await shellcheck.lint(
  {
    args: ["-f", "json1", "-s", "bash", "-"],
    stdin: script,
    env: { PWD: "/sub/dir" }, // guest path of the script's directory
    fs: workspaceFileSystem, // seen by ShellCheck as "/"; see "File system"
  },
  { signal: AbortSignal.timeout(10_000) },
);
const { comments } = JSON.parse(result.stdout);

await shellcheck.dispose(); // when done with the instance
```

### In a browser

- Point `new Worker(url)` at the packaged `./browser/worker.js`, a classic script that already
  calls `startWorker`. A Worker entry of your own must unwrap the event in `onMessage`:
  `self.addEventListener("message", (event) => listener(event.data))`.
- Load the module with `WebAssembly.compileStreaming(fetch(wasmUrl))`.
- Omit `onExit` on the creating side; web Workers have no exit event.

## Behavior

### Result

| `exitCode` | Meaning                       |
| ---------- | ----------------------------- |
| `0`        | No findings                   |
| `1`        | Findings                      |
| `2` or up  | Invalid input                 |

`exitCode` is ShellCheck's own. A lint rejects only when it is aborted, the instance is
disposed, or the Worker or the guest fails.

### Queue and cancellation

`createShellCheck` starts its Worker on the first lint and runs lints one at a time, in call
order.

- Aborting a queued lint removes it.
- Aborting the running lint terminates the Worker; the next lint starts a new one, as it does
  after the Worker exits or throws.
- Timeouts, priorities and dropping stale lints are up to the Host, through the `signal` it
  passes.

### File system

```ts
type FileType = "file" | "directory" | "other";

interface ShellCheckFileSystem {
  stat(path: string): Promise<{ type: FileType; size: number; mtime: number }>;
  readFile(path: string): Promise<Uint8Array>;
  readDirectory(path: string): Promise<ReadonlyArray<readonly [name: string, type: FileType]>>;
}
```

The `fs` of a lint is mounted read-only at guest `/`. ShellCheck reads it to find
`.shellcheckrc` above `PWD` and to follow `source` directives.

- **Without `fs`**, ShellCheck sees no files and can only lint stdin. Leave `PWD` unset then.
- **`PWD`** must name a directory in `fs`, or be unset. Otherwise the lint ends with empty
  stdout and `hs_init_ghc: chdir(...) failed` on stderr.
- **Paths** are normalized guest paths such as `/` or `/sub/dir/.shellcheckrc`. A path that
  climbs out of `/` with `..` is refused before `fs` sees it.
- **Threading:** the methods run on the thread that called `lint()` while the Worker waits.
- **Caching:** results are cached for the rest of the lint, never across lints.
- **Writes:** the package never writes.
- **Symlinks** resolve however `fs` resolves them. To keep ShellCheck inside a directory, keep
  `fs` from following links out of it.

To signal a failure, throw an error whose `code` is one of the `vscode.FileSystemError` codes
below. Anything else reaches ShellCheck as an I/O error.

| `code`              |
| ------------------- |
| `FileNotFound`      |
| `FileNotADirectory` |
| `FileIsADirectory`  |
| `NoPermissions`     |
| `Unavailable`       |

## Entry points

| Subpath               | Provides                                                                                                         |
| --------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `.`                   | `createShellCheck`, `isArtifactSupported`, `wasmUrl`, `SHELLCHECK_VERSION`, `BUILD_INFO` and types; no WASI shim |
| `./client`            | The same without `wasmUrl`, for Hosts that bundle it; MIT and free of `import.meta`                              |
| `./worker`            | `startWorker`, `ParentPort`: the Worker side                                                                     |
| `./browser/worker.js` | The Worker side as one classic script, for `new Worker(url)` in a browser                                        |
| `./shellcheck.wasm`   | The compiled ShellCheck module                                                                                   |
| `./package.json`      | The package manifest                                                                                             |

Bundlers that relocate modules can copy the artifact from
`require.resolve("@vscode-shellcheck/shellcheck-wasm/shellcheck.wasm")` and pass their own
`WebAssembly.Module` as `module`.

## Install

```sh
npm install @vscode-shellcheck/shellcheck-wasm
```

Prereleases are published under the `next` dist-tag (`npm install
@vscode-shellcheck/shellcheck-wasm@next`).

## Versioning

The package follows its own semver, independent of the bundled ShellCheck release, which is
exposed as `SHELLCHECK_VERSION`. `BUILD_INFO` describes the toolchain and, under `artifacts`,
each file it produced, keyed by name.

## Contributing

Building, testing and releasing are described in [AGENTS.md](./AGENTS.md); design decisions are
recorded in [docs/adr](./docs/adr).

## License

GPL-3.0-or-later ([`LICENSE`](./LICENSE)), same as ShellCheck (copyright Vidar Holen and
contributors). The `./client` entry and the modules behind it are MIT
([`LICENSE-MIT`](./LICENSE-MIT)) so that a Host can bundle them
([ADR 0007](./docs/adr/0007-host-side-client-is-mit.md)).
