# @vscode-shellcheck/shellcheck-wasm

[ShellCheck](https://www.shellcheck.net/) compiled to a WASI command module, plus a runner that
lints in a Worker you provide and reads files only through a file system you provide. This
package exists primarily as the WebAssembly runtime of the
[vscode-shellcheck](https://github.com/vscode-shellcheck/vscode-shellcheck) extension; other
JavaScript hosts can use it the same way. Given the same args, stdin, environment and visible
files, output is byte-identical to the native `shellcheck` binary of the same version. The module
uses wasm tail calls and requires Node.js 22 or later, or a browser with tail calls and
`SharedArrayBuffer`.

No module in the package imports `node:*`: the host supplies the Worker and, per lint, the files
ShellCheck may read.

## Install

```sh
npm install @vscode-shellcheck/shellcheck-wasm
```

## Usage

The Worker entry is a file the host ships. In Node:

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
    fs: workspaceFileSystem, // seen by ShellCheck as "/"; see below
  },
  { signal: AbortSignal.timeout(10_000) },
);
const { comments } = JSON.parse(result.stdout);

await shellcheck.dispose(); // when done with the instance
```

`exitCode` is ShellCheck's own: `0` no findings, `1` findings, `2` or higher for invalid input.
A lint rejects only when it is aborted, the instance is disposed, or the Worker or the guest
fails.

`createShellCheck` starts its Worker on the first lint and runs lints one at a time, in call
order. Aborting a queued lint removes it; aborting the running lint terminates the Worker, and
the next lint starts a new one, as it does after the Worker exits or throws. Timeouts,
priorities and dropping stale lints are up to the host, through the `signal` it passes.

In a web Worker, `onMessage` unwraps the event
(`self.addEventListener("message", (event) => listener(event.data))`), and on the creating side
`onExit` can be omitted. Browsers only provide `SharedArrayBuffer` to
[cross-origin isolated](https://developer.mozilla.org/docs/Web/API/Window/crossOriginIsolated)
pages; `WebAssembly.compileStreaming(fetch(wasmUrl))` loads the module there.

## Files

```ts
type FileType = "file" | "directory" | "other";

interface ShellCheckFileSystem {
  stat(path: string): Promise<{ type: FileType; size: number; mtime: number }>;
  readFile(path: string): Promise<Uint8Array>;
  readDirectory(path: string): Promise<ReadonlyArray<readonly [name: string, type: FileType]>>;
}
```

The `fs` of a lint is mounted read-only at guest `/`. ShellCheck needs it to find
`.shellcheckrc` above `PWD` and to follow `source` directives; without `fs` it sees no files at
all and can only lint stdin, and `PWD` must then be left unset. The methods run on the thread
that called `lint()` while the Worker waits, and every `path` is a normalized guest path such as
`/` or `/sub/dir/.shellcheckrc`. Results are cached for the rest of the lint, never across lints.

Signal failures by throwing an error whose `code` is `FileNotFound`, `FileNotADirectory`,
`FileIsADirectory`, `NoPermissions` or `Unavailable` (the `vscode.FileSystemError` codes);
anything else reaches ShellCheck as an I/O error. The package never writes, and a guest path that
climbs out of `/` with `..` is refused before `fs` sees it. Symlinks are resolved however `fs`
resolves them: a host that must keep ShellCheck inside a directory has to keep its `fs` from
following links out of it.

## Entry points

| Subpath             | Provides                                                                                     |
| ------------------- | -------------------------------------------------------------------------------------------- |
| `.`                 | `createShellCheck`, `wasmUrl`, `SHELLCHECK_VERSION`, `BUILD_INFO` and types; no WASI shim    |
| `./worker`          | `startWorker`, `ParentPort`: the Worker side                                                 |
| `./shellcheck.wasm` | The compiled ShellCheck module                                                               |
| `./package.json`    | The package manifest                                                                         |

Bundlers that relocate modules can copy the artifact from
`require.resolve("@vscode-shellcheck/shellcheck-wasm/shellcheck.wasm")` and pass their own
`WebAssembly.Module` as `module`.

## Versioning

The package follows its own semver, independent of the bundled ShellCheck release exposed as
`SHELLCHECK_VERSION`; `BUILD_INFO` describes the build that produced the artifact. Prereleases
are published under the `next` dist-tag.

## License

GPL-3.0-or-later, same as ShellCheck. ShellCheck is copyright Vidar Holen and contributors; this
wrapper is a derivative work.
