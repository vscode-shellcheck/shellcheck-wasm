---
status: accepted
---
# The runner runs the artifact; the host owns isolation and filesystem policy

The package exports a thin runner (args, stdin, env, WASI fds in → stdout, stderr, exit code out) built on `@bjorn3/browser_wasi_shim`, and nothing more. Worker threads, watchdogs, cancellation and read-only filesystem containment stay in the host (vscode-shellcheck), because those are security and UX decisions specific to each embedder and would otherwise be duplicated or fought over. `node:wasi` was rejected because it segfaults with preopens on Node 22 and leaks fds on Node 24.
