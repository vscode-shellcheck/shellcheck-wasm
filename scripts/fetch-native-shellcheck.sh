#!/usr/bin/env bash
# Downloads the native ShellCheck release matching buildtools/wasm/version.txt
# into .cache/native/shellcheck for the parity tests. Prints the binary path.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tag="$(tr -d '[:space:]' < "$repo_root/buildtools/wasm/version.txt")"
dest_dir="$repo_root/.cache/native"
dest="$dest_dir/shellcheck"

if [ -x "$dest" ] && [ "$(cat "$dest_dir/version.txt" 2>/dev/null)" = "$tag" ]; then
  echo "$dest"
  exit 0
fi

case "$(uname -s)" in
  Linux) os="linux" ;;
  Darwin) os="darwin" ;;
  *) echo "fetch-native-shellcheck: unsupported OS $(uname -s)" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch="x86_64" ;;
  aarch64 | arm64) arch="aarch64" ;;
  *) echo "fetch-native-shellcheck: unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac

archive="shellcheck-${tag}.${os}.${arch}.tar.xz"
url="https://github.com/koalaman/shellcheck/releases/download/${tag}/${archive}"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
curl -fL --retry 5 -o "$tmp/$archive" "$url" >&2
tar -xJf "$tmp/$archive" -C "$tmp"

mkdir -p "$dest_dir"
install -m 0755 "$tmp/shellcheck-${tag}/shellcheck" "$dest"
printf '%s\n' "$tag" > "$dest_dir/version.txt"
echo "$dest"
