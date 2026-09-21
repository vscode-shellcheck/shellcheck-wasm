#!/usr/bin/env bash
# Build dist/{shellcheck.wasm,shellcheck.wasm.sha256,build-info.json} from the pins in
# buildtools/wasm. Set DOCKER=podman to use podman.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

DOCKER="${DOCKER:-docker}"
pins=buildtools/wasm

shellcheck_version="$(tr -d '[:space:]' < "$pins/version.txt")"
shellcheck_src_sha256="$(tr -d '[:space:]' < "$pins/shellcheck-src.sha256")"
ghc_wasm_meta_commit="$(tr -d '[:space:]' < "$pins/ghc-wasm-meta.txt")"

[[ "$shellcheck_version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "bad $pins/version.txt: $shellcheck_version" >&2; exit 1; }
[[ "$shellcheck_src_sha256" =~ ^[0-9a-f]{64}$ ]] || { echo "bad $pins/shellcheck-src.sha256" >&2; exit 1; }
[[ "$ghc_wasm_meta_commit" =~ ^[0-9a-f]{40}$ ]] || { echo "bad $pins/ghc-wasm-meta.txt" >&2; exit 1; }

mkdir -p dist
"$DOCKER" build \
  --file "$pins/Dockerfile" \
  --target artifact \
  --output type=local,dest=dist \
  --build-arg "SHELLCHECK_VERSION=$shellcheck_version" \
  --build-arg "SHELLCHECK_SRC_SHA256=$shellcheck_src_sha256" \
  --build-arg "GHC_WASM_META_COMMIT=$ghc_wasm_meta_commit" \
  "$pins"

cat dist/build-info.json
