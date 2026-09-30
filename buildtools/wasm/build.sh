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
# The version must equal what the solver picks at cabal.project's index-state; the hash pins
# the content cabal would otherwise have verified itself.
fgl_version=5.8.3.1
fgl_sha256=02f71384d3f286f8473a58c55ed3ca040f4d142ca4badf5c024ab077bc40362f
fgl_dir="$ghc_wasm/.cabal/packages/hackage.haskell.org/fgl/$fgl_version"
mkdir -p "$fgl_dir"
curl -fL --retry 5 -o "$fgl_dir/fgl-$fgl_version.tar.gz" \
  "https://hackage.haskell.org/package/fgl-$fgl_version/fgl-$fgl_version.tar.gz"
echo "$fgl_sha256  $fgl_dir/fgl-$fgl_version.tar.gz" | sha256sum -c -

tail_call="${TAIL_CALL:-require}"
read -r -a forbid <<< "${FORBID_FEATURES:-}"
case "$tail_call" in
  require) ;;
  forbid) forbid+=(tail-call) ;;
  *) echo "TAIL_CALL must be require or forbid, got $tail_call" >&2; exit 1 ;;
esac

wasm32-wasi-cabal update
started=$SECONDS
wasm32-wasi-cabal build exe:shellcheck
cabal_seconds=$((SECONDS - started))
cp "$(wasm32-wasi-cabal list-bin exe:shellcheck)" "$out/shellcheck.linked.wasm"

# Research diagnostics: instruction counts and the functions that use SIMD, from the linker
# output (which still has a name section). Printed so they survive a failing gate below.
mkdir -p "$out/diag"
wasm-tools print "$out/shellcheck.linked.wasm" > /tmp/linked.wat
awk '
  /^  \(func /     { name = $2; funcs++ }
  /return_call/    { rc++; rcf[name] = 1 }
  /(^|[ (])call /  { calls++ }
  /call_indirect/  { ci++ }
  /v128\.|i8x16\.|i16x8\.|i32x4\.|i64x2\.|f32x4\.|f64x2\./ { simd++; sf[name]++ }
  END {
    printf "funcs=%d\nreturn_call_lines=%d\nfuncs_with_return_call=%d\n", funcs, rc, length(rcf)
    printf "call_lines=%d\ncall_indirect_lines=%d\nsimd_lines=%d\nfuncs_with_simd=%d\n", calls, ci, simd, length(sf)
    for (f in sf) printf "%d %s\n", sf[f], f > "/tmp/simd-funcs.txt"
  }' /tmp/linked.wat > "$out/diag/linked-counts.txt"
touch /tmp/simd-funcs.txt
sort -rn /tmp/simd-funcs.txt > "$out/diag/simd-funcs.txt"
python3 "$tools/check-target-features.py" "$out/shellcheck.linked.wasm" \
  > "$out/diag/linked-target-features.json" || true
{
  echo "cflags=$WASM_CFLAGS"
  echo "tail_call=$tail_call forbid=${forbid[*]:-}"
  echo "cabal_build_seconds=$cabal_seconds"
  echo "linked_size=$(wc -c < "$out/shellcheck.linked.wasm" | tr -d ' ')"
  cat "$out/diag/linked-target-features.json"
  cat "$out/diag/linked-counts.txt"
  echo "--- simd functions (count name)"
  cat "$out/diag/simd-funcs.txt"
} | tee "$out/diag/summary.txt"

# Gate on the linker output: wasm-opt --enable-tail-call rewrites target_features.
opt_features=()
if [ "$tail_call" = require ]; then
  python3 "$tools/check-target-features.py" "$out/shellcheck.linked.wasm" --require tail-call
  opt_features=(--enable-tail-call)
fi
# A feature missing from `validate --features all,-X` is one no instruction uses, whatever
# target_features claims.
for feature in "${forbid[@]}"; do
  wasm-tools validate --features "all,-$feature" "$out/shellcheck.linked.wasm"
done

started=$SECONDS
wasm-opt "${opt_features[@]}" --flatten --rereloop --converge -O3 \
  -o "$out/shellcheck.wasm" "$out/shellcheck.linked.wasm"
echo "wasm_opt_seconds=$((SECONDS - started))" | tee -a "$out/diag/summary.txt"
wasm-tools validate --features all "$out/shellcheck.wasm"
for feature in "${forbid[@]}"; do
  wasm-tools validate --features "all,-$feature" "$out/shellcheck.wasm"
done
if [ "$tail_call" = require ]; then
  python3 "$tools/check-target-features.py" "$out/shellcheck.wasm" --require tail-call \
    > "$out/target-features.json"
  wasmtime_flags=(-W tail-call=y)
else
  python3 "$tools/check-target-features.py" "$out/shellcheck.wasm" > "$out/target-features.json"
  wasmtime_flags=(-W tail-call=n)
fi
wasmtime run "${wasmtime_flags[@]}" "$out/shellcheck.wasm" --version \
  | grep -Fx "version: ${SHELLCHECK_VERSION#v}"
{
  echo "final_size=$(wc -c < "$out/shellcheck.wasm" | tr -d ' ')"
  echo "final_gzip9=$(gzip -9 -c "$out/shellcheck.wasm" | wc -c | tr -d ' ')"
  echo "final_target_features=$(cat "$out/target-features.json")"
} | tee -a "$out/diag/summary.txt"

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
