export type FileType = "file" | "directory" | "other";

export interface FileStat {
  readonly type: FileType;
  /** Size in bytes. */
  readonly size: number;
  /** Modification time in milliseconds since the Unix epoch. */
  readonly mtime: number;
}

/**
 * Codes a {@link ShellCheckFileSystem} puts on the `code` property of what it throws; they
 * mirror `vscode.FileSystemError`. Anything else reaches ShellCheck as `EIO`.
 */
export type FileSystemErrorCode =
  | "FileNotFound"
  | "FileNotADirectory"
  | "FileIsADirectory"
  | "NoPermissions"
  | "Unavailable";

/**
 * The files ShellCheck may read during one lint, served on the thread that called `lint()`.
 * Every `path` is a normalized absolute POSIX path in the guest's view, such as `/` or
 * `/dir/.shellcheckrc`; the implementation decides what backs it and must keep symlinks
 * from leading anywhere the guest may not see.
 */
export interface ShellCheckFileSystem {
  stat(path: string): Promise<FileStat>;
  readFile(path: string): Promise<Uint8Array>;
  readDirectory(path: string): Promise<ReadonlyArray<readonly [name: string, type: FileType]>>;
}
