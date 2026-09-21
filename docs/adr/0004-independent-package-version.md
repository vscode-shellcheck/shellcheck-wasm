---
status: accepted
---
# Package semver is independent of the ShellCheck version

The npm version follows this package's own changes; the bundled ShellCheck release is pinned in `version.txt` and exported at runtime as `SHELLCHECK_VERSION`. Mirroring ShellCheck's version would leave no way to ship a runner or packaging fix between upstream releases.
