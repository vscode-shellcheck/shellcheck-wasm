---
status: accepted
---
# The package is file-system agnostic

vscode-shellcheck will lint documents of any URI scheme (remote, virtual) by reading them through `vscode.workspace.fs`, and later run in VS Code for the Web. Neither works if the package reads files with `node:fs`, so no shipped entry imports `node:*`, and the only way the artifact sees a file is a `ShellCheckFileSystem` the host passes with each lint: async `stat`, `readFile` and `readDirectory` on guest paths, run on the thread that called `lint()`.

ShellCheck is a WASI command module and calls the file system synchronously from inside `_start`. The package bridges the two: the guest runs in a Worker the host creates; on a WASI call the Worker posts a request and blocks in `Atomics.wait` on a SharedArrayBuffer allocated once per Worker; the host's thread runs the async call, writes the answer into the buffer (in 1 MiB chunks) and wakes it. Answers, failures included, are cached for the rest of the lint because ShellCheck probes the same rc paths repeatedly. The preopen built on the bridge is read-only by construction, since the interface has no write operation; `..` is folded lexically and may not climb above guest `/`. Symlinks are whatever the file system makes of them: containing them is the backend's job, and the realpath checks of the `node:fs` preopen are gone with it. For the same reason build info is compiled into the package as `BUILD_INFO` rather than read from `build-info.json` at run time.

## Considered options

- `ms-vscode.wasm-wasi-core`: rejected. Dormant since its 1.0.1 release in 2024, it accepts no custom imports, cannot mount a directory read-only, services every syscall on the extension host's main thread, and would be a hard dependency on another extension.
- `@vscode/sync-api-client` / `@vscode/sync-api-service`: rejected. A generic JSON RPC over the same SharedArrayBuffer mechanism, with an extra round trip per `readFile` (size first, then content) and far more surface than three read operations need.
- Keep `node:fs` in the Worker: rejected. Only `file:` documents could be linted and the package could never run on the web.

## Consequences

- Browsers only provide `SharedArrayBuffer` to cross-origin isolated pages. Node and VS Code desktop always have it.
- Every uncached file-system call costs a round trip to the host's thread, and that thread must keep its event loop running while a lint that reads files is in progress. A typical lint with a `.shellcheckrc` and one sourced file makes 8 of them. The Worker polls for up to 1 ms before sleeping on each, because a guest that sleeps for every answer runs measurably slower after waking; `npm run bench` holds the result to within 10% of the 0.1.1 `node:fs` runner.
- A host exposing a directory other processes can write to decides for itself how to treat symlinks inside it.
