#!/usr/bin/env bash
# Build the ShellCheck WASI command module from the source tree in the current directory.
# Reads SHELLCHECK_VERSION, GHC_WASM_META_COMMIT and WASM_CFLAGS from the environment and
# writes shellcheck.wasm, shellcheck.wasm.sha256 and build-info.json to OUT_DIR (default /out).
set -euo pipefail

: "${SHELLCHECK_VERSION:?}" "${GHC_WASM_META_COMMIT:?}" "${WASM_CFLAGS:?}"
out="${OUT_DIR:-/out}"
tools="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

ghc_wasm="${GHC_WASM_PREFIX:-/root/.ghc-wasm}"
# shellcheck source=/dev/null
. "$ghc_wasm/env"
mkdir -p "$out"

# Hackage's CDN answers cabal's own download of this tarball with 403; pre-seed the cache.
# The version must equal what the solver picks at cabal.project's index-state.
fgl_version=5.8.3.1
fgl_dir="$ghc_wasm/.cabal/packages/hackage.haskell.org/fgl/$fgl_version"
mkdir -p "$fgl_dir"
curl -fL --retry 5 -o "$fgl_dir/fgl-$fgl_version.tar.gz" \
  "https://hackage.haskell.org/package/fgl-$fgl_version/fgl-$fgl_version.tar.gz"

wasm32-wasi-cabal update
wasm32-wasi-cabal build exe:shellcheck
cp "$(wasm32-wasi-cabal list-bin exe:shellcheck)" "$out/shellcheck.linked.wasm"

# Gate on the linker output: wasm-opt --enable-tail-call rewrites target_features.
python3 "$tools/check-target-features.py" "$out/shellcheck.linked.wasm" --require tail-call

wasm-opt --enable-tail-call --flatten --rereloop --converge -O3 \
  -o "$out/shellcheck.wasm" "$out/shellcheck.linked.wasm"
wasm-tools validate --features all "$out/shellcheck.wasm"
python3 "$tools/check-target-features.py" "$out/shellcheck.wasm" --require tail-call \
  > "$out/target-features.json"
wasmtime run -W tail-call=y "$out/shellcheck.wasm" --version \
  | grep -Fx "version: ${SHELLCHECK_VERSION#v}"

cd "$out"
sha256sum shellcheck.wasm > shellcheck.wasm.sha256
SHA256="$(cut -d' ' -f1 shellcheck.wasm.sha256)" \
SIZE="$(wc -c < shellcheck.wasm | tr -d ' ')" \
GHC_VERSION="$(wasm32-wasi-ghc --numeric-version)" \
CABAL_VERSION="$(wasm32-wasi-cabal --numeric-version)" \
WASM_OPT_VERSION="$(wasm-opt --version)" \
python3 - <<'PY' > build-info.json
import json, os
with open("target-features.json") as f:
    target_features = json.load(f)
info = {
    "shellcheckVersion": os.environ["SHELLCHECK_VERSION"],
    "ghcWasmMetaCommit": os.environ["GHC_WASM_META_COMMIT"],
    "ghcVersion": os.environ["GHC_VERSION"].strip(),
    "cabalVersion": os.environ["CABAL_VERSION"].strip(),
    "wasmOptVersion": os.environ["WASM_OPT_VERSION"].strip(),
    "cflags": os.environ["WASM_CFLAGS"],
    "targetFeatures": target_features,
    "sha256": os.environ["SHA256"],
    "size": int(os.environ["SIZE"]),
}
print(json.dumps(info, indent=2))
PY
rm -f shellcheck.linked.wasm target-features.json
