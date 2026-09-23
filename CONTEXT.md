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
The metadata describing how a given Artifact was built: its ShellCheck version, toolchain versions, compiler flags, target features, digest and size. Produced together with the Artifact as `build-info.json` and compiled into the package as `BUILD_INFO`.
_Avoid_: build metadata, manifest

**Command module**:
The WASI execution model the Artifact uses: exports `_start`, reads argv/stdin, writes stdout/stderr, exits. One run per `WebAssembly.Instance`. Chosen over a reactor module so output stays byte-identical to native ShellCheck.
_Avoid_: reactor, JSFFI module

**Runner**:
The JavaScript layer in this package (`createShellCheck` plus the Worker side, `startWorker`) that runs the Artifact once per lint on a fresh `WebAssembly.Instance` inside a Worker, one lint at a time in call order, and returns stdout/stderr/exit code. It aborts a lint when told to but holds no policy about when; that belongs to the Host.
_Avoid_: wrapper, FFI, binding

**Host**:
The consumer that embeds the Runner (e.g. the vscode-shellcheck extension). Creates the Worker, decides what each lint may see through its File system, and owns scheduling policy and watchdog durations.
_Avoid_: client, consumer, caller

**File system**:
The async `ShellCheckFileSystem` (`stat`, `readFile`, `readDirectory`) a Host passes with a lint, run on the Host's thread. Paths are guest paths such as `/dir/.shellcheckrc`; symlink containment is its job.
_Avoid_: backend, VFS

**Bridge**:
The SharedArrayBuffer channel that lets the Artifact's synchronous WASI calls in the Worker wait on the File system's async answers on the Host's thread.
_Avoid_: RPC, proxy

**Preopen**:
The read-only directory tree the Artifact sees at guest `/` during one lint, served lazily from the File system through the Bridge. ShellCheck needs one to discover `.shellcheckrc` and follow `source` directives; a lint without a File system has none and can only lint stdin.
_Avoid_: sandbox

**Parity**:
The property that, for the same args, stdin, environment and filesystem, the Artifact's stdout, stderr and exit code are byte-identical to the same ShellCheck version's native binary. The acceptance bar for every Artifact.
_Avoid_: compatibility, equivalence

**Tail-call gate**:
The CI check that the final Artifact's `target_features` includes `tail-call`. The GHC wasm toolchain does not enable it by default; a build without it is rejected.
