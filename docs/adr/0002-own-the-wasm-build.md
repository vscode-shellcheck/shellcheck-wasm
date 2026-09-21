---
status: accepted
---
# Build shellcheck.wasm ourselves instead of reusing wasilibs/go-shellcheck

vscode-shellcheck PR #1952 downloads a prebuilt `shellcheck.wasm` from `wasilibs/go-shellcheck`, which pins a 2025-03 ghc-wasm-meta that predates GHC's wasm tail-call support. We build the artifact in this repository from a pinned ShellCheck release with a current ghc-wasm-meta and `-mtail-call` in the GHC stage1/stage2 C/C++ options, so the artifact actually uses `return_call` and we control when the toolchain moves.

## Consequences

- CI rejects an artifact whose `target_features` lacks `tail-call` (the toolchain default is off since 2025-09).
- Consumers need a runtime with wasm tail calls: Node >= 22, current VS Code Electron.
