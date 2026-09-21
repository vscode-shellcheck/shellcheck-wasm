# shellcheck-wasm

An npm package that ships ShellCheck compiled to WebAssembly, so that JavaScript hosts (first of all the vscode-shellcheck extension) can lint shell scripts without a native ShellCheck binary.

## Language

**Artifact**:
The `shellcheck.wasm` binary produced by compiling a pinned ShellCheck release with the GHC wasm backend. The thing this package exists to distribute.
_Avoid_: binary, bundle, blob

**ShellCheck version**:
The upstream ShellCheck release tag (e.g. `v0.11.0`) the Artifact was built from. Recorded once in `version.txt`; independent of the package's own semver.
_Avoid_: tool version, upstream version

**Package version**:
The npm semver of this package. Bumps independently of the ShellCheck version so wrapper fixes can ship without a new ShellCheck release.

**Build info**:
The metadata describing how a given Artifact was built: its ShellCheck version, toolchain versions, compiler flags, target features, digest and size. Produced together with the Artifact and exposed to Hosts as a typed value.
_Avoid_: build metadata, manifest

**Command module**:
The WASI execution model the Artifact uses: exports `_start`, reads argv/stdin, writes stdout/stderr, exits. One run per `WebAssembly.Instance`. Chosen over a reactor module so output stays byte-identical to native ShellCheck.
_Avoid_: reactor, JSFFI module

**Runner**:
The thin JavaScript layer in this package that instantiates the Artifact with a WASI host and runs it once with given args/stdin, returning stdout/stderr/exit code. Contains no threading, cancellation or filesystem policy; those belong to the Host.
_Avoid_: wrapper, FFI, binding

**Host**:
The consumer that embeds the Runner (e.g. the vscode-shellcheck extension). Owns Worker isolation, watchdogs, cancellation and which directories the Artifact may see.
_Avoid_: client, consumer, caller

**Preopen**:
A directory the Host exposes to the Artifact through WASI. ShellCheck needs one to discover `.shellcheckrc` and follow `source` directives; without one it can only lint stdin.
_Avoid_: mount, sandbox

**Parity**:
The property that, for the same args, stdin and filesystem, the Artifact's stdout, stderr and exit code are byte-identical to the same ShellCheck version's native binary. The acceptance bar for every Artifact.
_Avoid_: compatibility, equivalence

**Tail-call gate**:
The CI check that the final Artifact's `target_features` includes `tail-call`. The GHC wasm toolchain does not enable it by default; a build without it is rejected.
