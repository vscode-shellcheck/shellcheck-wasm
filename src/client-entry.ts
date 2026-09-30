/*! SPDX-License-Identifier: MIT */

export { createShellCheck } from "./client.js";
export type {
  LintOptions,
  LintRequest,
  LintResult,
  ShellCheck,
  ShellCheckOptions,
  WorkerPort,
} from "./client.js";
export type {
  FileStat,
  FileSystemErrorCode,
  FileType,
  ShellCheckFileSystem,
} from "./file-system.js";
export {
  BUILD_INFO,
  SHELLCHECK_VERSION,
  type ArtifactInfo,
  type BuildInfo,
} from "./build-info.js";
export { isArtifactSupported } from "./support.js";
