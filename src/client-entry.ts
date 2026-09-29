// SPDX-License-Identifier: MIT

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
export type { BuildInfo } from "./build-info.js";
export { BUILD_INFO } from "./generated/build-info.js";
export { SHELLCHECK_VERSION } from "./generated/version.js";
