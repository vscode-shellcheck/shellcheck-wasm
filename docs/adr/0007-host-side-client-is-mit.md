---
status: accepted
---
# Host-side client is MIT

The host-side client (`createShellCheck`, its protocol, file-system types and generated build
constants) is original wrapper code and is licensed under the MIT License. It is exposed through
`./client` so an MIT VS Code Web bundle can use the host API without bundling the GPL guest side.
The existing package entry, Worker, WASI runner, preopen, filesystem shim and `shellcheck.wasm`
remain GPL-3.0-or-later. This amends ADR 0001: the package is dual-licensed at its source boundary,
not wholly GPL, while the distributed artifact and guest-side code remain GPL-3.0-or-later.
