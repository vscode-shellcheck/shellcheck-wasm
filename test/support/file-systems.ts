import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  FileStat,
  FileSystemErrorCode,
  FileType,
  ShellCheckFileSystem,
} from "../../src/index.js";

export interface RecordingFileSystem extends ShellCheckFileSystem {
  /** Every call made, as `"<op> <path>"`, in order. */
  readonly calls: string[];
}

const CODES: Partial<Record<string, FileSystemErrorCode>> = {
  ENOENT: "FileNotFound",
  ENOTDIR: "FileNotADirectory",
  EISDIR: "FileIsADirectory",
  EACCES: "NoPermissions",
  EPERM: "NoPermissions",
};

export function fileSystemError(code: FileSystemErrorCode | string, message = code): Error {
  return Object.assign(new Error(message), { code });
}

function typeOf(stats: Stats): FileType {
  if (stats.isFile()) return "file";
  if (stats.isDirectory()) return "directory";
  return "other";
}

/**
 * What a Node Host would pass as `fs`: `root` seen as guest `/`, with Node errors
 * translated to the codes the package understands. No symlink containment; tests only.
 */
export function nodeFileSystem(root: string): RecordingFileSystem {
  const calls: string[] = [];
  const host = (guestPath: string): string => path.join(root, guestPath);
  const translate = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      const code = CODES[(error as NodeJS.ErrnoException).code ?? ""];
      throw code === undefined ? error : fileSystemError(code, (error as Error).message);
    }
  };
  return {
    calls,
    stat: (guestPath) => {
      calls.push(`stat ${guestPath}`);
      return translate(async (): Promise<FileStat> => {
        const stats = await fs.stat(host(guestPath));
        return { type: typeOf(stats), size: stats.size, mtime: stats.mtimeMs };
      });
    },
    readFile: (guestPath) => {
      calls.push(`readFile ${guestPath}`);
      return translate(() => fs.readFile(host(guestPath)));
    },
    readDirectory: (guestPath) => {
      calls.push(`readDirectory ${guestPath}`);
      return translate(async () => {
        const entries = await fs.readdir(host(guestPath), { withFileTypes: true });
        return entries.map((entry): [string, FileType] => [
          entry.name,
          entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other",
        ]);
      });
    },
  };
}

/**
 * An in-memory tree from guest paths to contents; parent directories are implied.
 * `overrides` replace individual operations, e.g. to throw.
 */
export function memoryFileSystem(
  files: Record<string, string | Uint8Array>,
  overrides: Partial<ShellCheckFileSystem> = {},
): RecordingFileSystem {
  const calls: string[] = [];
  const contents = new Map<string, Uint8Array>();
  const directories = new Map<string, Map<string, FileType>>([["/", new Map()]]);
  for (const [file, content] of Object.entries(files)) {
    contents.set(file, typeof content === "string" ? new TextEncoder().encode(content) : content);
    let child = file;
    let type: FileType = "file";
    while (child !== "/") {
      const parent = path.posix.dirname(child);
      if (!directories.has(parent)) directories.set(parent, new Map());
      directories.get(parent)!.set(path.posix.basename(child), type);
      child = parent;
      type = "directory";
    }
  }
  const missing = (guestPath: string): Error =>
    fileSystemError("FileNotFound", `${guestPath} not found`);
  const base: ShellCheckFileSystem = {
    stat: async (guestPath) => {
      const data = contents.get(guestPath);
      if (data !== undefined) return { type: "file", size: data.byteLength, mtime: 0 };
      if (directories.has(guestPath)) return { type: "directory", size: 0, mtime: 0 };
      throw missing(guestPath);
    },
    readFile: async (guestPath) => {
      const data = contents.get(guestPath);
      if (data !== undefined) return data;
      if (directories.has(guestPath)) throw fileSystemError("FileIsADirectory");
      throw missing(guestPath);
    },
    readDirectory: async (guestPath) => {
      const entries = directories.get(guestPath);
      if (entries !== undefined) return [...entries];
      if (contents.has(guestPath)) throw fileSystemError("FileNotADirectory");
      throw missing(guestPath);
    },
  };
  const record =
    <A extends unknown[], R>(op: string, fn: (guestPath: string, ...rest: A) => R) =>
    (guestPath: string, ...rest: A): R => {
      calls.push(`${op} ${guestPath}`);
      return fn(guestPath, ...rest);
    };
  return {
    calls,
    stat: record("stat", overrides.stat ?? base.stat),
    readFile: record("readFile", overrides.readFile ?? base.readFile),
    readDirectory: record("readDirectory", overrides.readDirectory ?? base.readDirectory),
  };
}
