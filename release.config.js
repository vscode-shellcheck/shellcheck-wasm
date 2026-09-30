/** @type {import("semantic-release").GlobalConfig} */
export default {
  branches: ["main", { name: "next", prerelease: true }],
  plugins: [
    [
      "@semantic-release/commit-analyzer",
      {
        // The angular default preset ignores `feat!:`; only conventionalcommits reads the `!`.
        preset: "conventionalcommits",
        // semantic-release has no 0.x mode and would turn a breaking change into 1.0.0.
        // Drop this rule when the package goes 1.0.
        releaseRules: [{ breaking: true, release: "minor" }],
      },
    ],
    ["@semantic-release/release-notes-generator", { preset: "conventionalcommits" }],
    // The tarball is packed from dist/ built earlier in the job; the version is only written
    // into package.json at publish time, never committed back.
    "@semantic-release/npm",
    [
      "@semantic-release/github",
      {
        // build-info.json is not in the npm tarball (its contents are compiled into BUILD_INFO)
        // but stays a release asset next to the artifact it describes.
        assets: [
          { path: "dist/shellcheck.wasm" },
          { path: "dist/shellcheck.wasm.sha256" },
          { path: "dist/build-info.json" },
        ],
      },
    ],
  ],
};
