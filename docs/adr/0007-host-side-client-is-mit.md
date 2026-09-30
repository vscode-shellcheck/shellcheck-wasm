---
status: accepted
---
# The Host-side Runner is MIT

ADR 0001 made the whole package GPL-3.0-or-later on the grounds that splitting the wrapper would not change what a consumer receives. VS Code for the Web changes that: a web extension must ship as one CommonJS file, so the Host bundles the caller side of the Runner into its own code instead of loading it from `node_modules`, and a GPL module in that bundle would make the extension a derivative work.

The caller side (`createShellCheck`, the Bridge protocol, the File system and build info types, the generated `SHELLCHECK_VERSION` and `BUILD_INFO`) is therefore MIT and exported on its own as `./client`, which imports nothing else. Everything the Artifact runs with stays GPL-3.0-or-later: the Worker side, the WASI shim adapters, the Artifact, the root entry `.`, and `./browser/worker.js`, a self-contained classic script a web Host starts by URL and never bundles. Each source file carries its SPDX identifier; `test/web-package.test.ts` bundles `./client` and fails on any input that is not MIT.

## Consequences

- The package license is `GPL-3.0-or-later AND MIT`, with `LICENSE-MIT` beside `LICENSE`.
- Moving code into a module `./client` reaches makes it MIT, which is only possible for code this project owns.
