---
status: accepted
---
# Ship a WASI command module, not a reactor

The artifact exports `_start` and is run once per `WebAssembly.Instance`, like a CLI. A reactor with JSFFI exports (as in the `shellcheck-wasm` npm package) would avoid re-initialising the GHC RTS per lint, but its output schema differs from `shellcheck -f json1`, it cannot discover `.shellcheckrc` through the normal path, and re-entry bugs poison the instance. Byte-identical parity with native ShellCheck matters more than the instantiate cost (~20 ms; the lint itself dominates).

## Note 2026-09-23

The measurements that had a reactor build losing on medium and large scripts came from the third-party `shellcheck-wasm` npm package, built with GHC 9.10, without tail calls or `wasm-opt`, and loaded with `hs_init` instead of `_initialize`. They measure that build, not the reactor model. A JSFFI reactor whose `SystemInterface` calls an async file system directly would need neither the SharedArrayBuffer bridge of ADR 0006 nor cross-origin isolation in browsers; re-evaluate it when adding web support, weighing that it means maintaining a fork of ShellCheck's `shellcheck.hs` and re-establishing parity on every ShellCheck upgrade.
