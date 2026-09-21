#!/bin/sh
# Usage: write-build-info.sh OUT_DIR
# Expects OUT_DIR/shellcheck.wasm and OUT_DIR/target-features.json, plus
# SHELLCHECK_VERSION, GHC_WASM_META_COMMIT and WASM_CFLAGS in the environment.
# Writes OUT_DIR/shellcheck.wasm.sha256 and OUT_DIR/build-info.json.
set -eu

out="${1:?usage: write-build-info.sh OUT_DIR}"
: "${SHELLCHECK_VERSION:?}" "${GHC_WASM_META_COMMIT:?}" "${WASM_CFLAGS:?}"

cd "$out"
test -f shellcheck.wasm
test -f target-features.json

sha256sum shellcheck.wasm > shellcheck.wasm.sha256

SHA256="$(cut -d' ' -f1 shellcheck.wasm.sha256)" \
SIZE="$(wc -c < shellcheck.wasm | tr -d ' ')" \
GHC_VERSION="$(wasm32-wasi-ghc --numeric-version)" \
CABAL_VERSION="$(wasm32-wasi-cabal --numeric-version)" \
WASM_OPT_VERSION="$(wasm-opt --version)" \
python3 - <<'EOF' > build-info.json
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
EOF
