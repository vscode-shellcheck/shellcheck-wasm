---
status: accepted
---
# Ship a WASI command module, not a reactor

The artifact exports `_start` and is run once per `WebAssembly.Instance`, like a CLI. A reactor with JSFFI exports (as in the `shellcheck-wasm` npm package) would avoid re-initialising the GHC RTS per lint, but its output schema differs from `shellcheck -f json1`, it cannot discover `.shellcheckrc` through the normal path, and re-entry bugs poison the instance. Byte-identical parity with native ShellCheck matters more than the instantiate cost (~20 ms; the lint itself dominates).
