---
status: accepted, amended 2026-09-23 (see ADR 0006)
---
# The runner runs the artifact; the host owns isolation and filesystem policy

The package exports a thin runner (args, stdin, env, WASI fds in → stdout, stderr, exit code out) built on `@bjorn3/browser_wasi_shim`, and nothing more. Worker threads, watchdogs, cancellation and read-only filesystem containment stay in the host (vscode-shellcheck), because those are security and UX decisions specific to each embedder and would otherwise be duplicated or fought over. `node:wasi` was rejected because it segfaults with preopens on Node 22 and leaks fds on Node 24.

## Amendment 2026-09-23

The Worker protocol, the synchronous file-system bridge and the read-only preopen now live in the package (ADR 0006). Once files come from an async API such as `vscode.workspace.fs`, the guest can only read them through a bridge that blocks the Worker while the host's thread answers, and both ends of that bridge have to agree on one protocol, so they ship together. The package therefore runs one lint at a time in a Worker, in call order, and aborts a lint when the host's `AbortSignal` fires.

Policy stays in the host: how the Worker is created (the package never starts one itself), what each lint may see (the `fs` it passes, including containment of symlinks), scheduling beyond first in, first out, such as putting the active editor first or dropping stale lints, and how long a lint may run before the host aborts it.
