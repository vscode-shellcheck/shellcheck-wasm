import { Fd, File, OpenFile, wasi } from "@bjorn3/browser_wasi_shim";
import type { DirectoryEntry, SyncFileSystem } from "./bridge.js";
import type { FileStat, FileType } from "./file-system.js";

type FdstatResult = { ret: number; fdstat: wasi.Fdstat | null };
type FilestatResult = { ret: number; filestat: wasi.Filestat | null };
type ReadResult = { ret: number; data: Uint8Array };
type WriteResult = { ret: number; nwritten: number };
type SeekResult = { ret: number; offset: bigint };
type OpenResult = { ret: number; fd_obj: Fd | null };
type ReaddirResult = { ret: number; dirent: wasi.Dirent | null };
type ReadlinkResult = { ret: number; data: string | null };
type PrestatResult = { ret: number; prestat: wasi.Prestat | null };
type Resolved = { ret: number; path: string | null; directoryOnly: boolean };

const EMPTY = new Uint8Array();

function filetypeOf(type: FileType): number {
  switch (type) {
    case "file":
      return wasi.FILETYPE_REGULAR_FILE;
    case "directory":
      return wasi.FILETYPE_DIRECTORY;
    default:
      return wasi.FILETYPE_UNKNOWN;
  }
}

function parentOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash <= 0 ? "/" : path.slice(0, slash);
}

function childOf(path: string, name: string): string {
  return path === "/" ? `/${name}` : `${path}/${name}`;
}

/**
 * Folds `guestPath` onto the guest-absolute directory `base` without asking the file
 * system, as `path.resolve` would. A `..` above the mount root has nothing to name, so it
 * fails with `ENOTCAPABLE` like any other attempt to leave the mount.
 */
function resolve(base: string, guestPath: string): Resolved {
  if (guestPath.includes("\0")) return { ret: wasi.ERRNO_INVAL, path: null, directoryOnly: false };
  // wasi-libc turns absolute paths into (preopen fd, relative path) itself; one that
  // reaches us bypassed that and has no preopen to be relative to.
  if (guestPath.startsWith("/")) {
    return { ret: wasi.ERRNO_NOTCAPABLE, path: null, directoryOnly: false };
  }
  const parts = base === "/" ? [] : base.slice(1).split("/");
  for (const part of guestPath.split("/")) {
    if (part === "" || part === ".") continue;
    if (part !== "..") {
      parts.push(part);
    } else if (parts.pop() === undefined) {
      return { ret: wasi.ERRNO_NOTCAPABLE, path: null, directoryOnly: false };
    }
  }
  return {
    ret: wasi.ERRNO_SUCCESS,
    path: `/${parts.join("/")}`,
    directoryOnly: guestPath.endsWith("/"),
  };
}

/** Per-lint state shared by every fd under one preopen. */
class Mount {
  private readonly inodes = new Map<string, bigint>();

  constructor(readonly fs: SyncFileSystem) {}

  /** Stable per path within the lint, so path and fd stats of one file agree. */
  ino(path: string): bigint {
    let ino = this.inodes.get(path);
    if (ino === undefined) {
      ino = BigInt(this.inodes.size + 1);
      this.inodes.set(path, ino);
    }
    return ino;
  }

  filestat(path: string, stat: FileStat): wasi.Filestat {
    const filestat = new wasi.Filestat(this.ino(path), filetypeOf(stat.type), BigInt(stat.size));
    const time = BigInt(stat.mtime) * 1_000_000n;
    filestat.atim = time;
    filestat.mtim = time;
    filestat.ctim = time;
    return filestat;
  }

  /** Stats `guestPath` under `base`; `ENOTDIR` for a trailing slash on a non-directory. */
  lookup(base: string, guestPath: string): { ret: number; path: string; stat: FileStat | null } {
    const resolved = resolve(base, guestPath);
    if (resolved.path === null) return { ret: resolved.ret, path: "", stat: null };
    const stat = this.fs.stat(resolved.path);
    if (typeof stat === "number") return { ret: stat, path: resolved.path, stat: null };
    if (resolved.directoryOnly && stat.type !== "directory") {
      return { ret: wasi.ERRNO_NOTDIR, path: resolved.path, stat: null };
    }
    return { ret: wasi.ERRNO_SUCCESS, path: resolved.path, stat };
  }
}

class ReadOnlyFile extends OpenFile {
  constructor(
    private readonly mount: Mount,
    private readonly path: string,
    private readonly stat: FileStat,
    data: Uint8Array,
  ) {
    super(new File(data, { readonly: true }));
  }

  override fd_fdstat_set_flags(): number {
    return wasi.ERRNO_SUCCESS;
  }

  override fd_filestat_get(): { ret: number; filestat: wasi.Filestat } {
    const stat = { ...this.stat, size: this.file.data.byteLength };
    return { ret: wasi.ERRNO_SUCCESS, filestat: this.mount.filestat(this.path, stat) };
  }

  override fd_write(): WriteResult {
    return { ret: wasi.ERRNO_ROFS, nwritten: 0 };
  }

  override fd_pwrite(): WriteResult {
    return { ret: wasi.ERRNO_ROFS, nwritten: 0 };
  }

  override fd_allocate(): number {
    return wasi.ERRNO_ROFS;
  }

  override fd_filestat_set_size(): number {
    return wasi.ERRNO_ROFS;
  }

  override fd_filestat_set_times(): number {
    return wasi.ERRNO_ROFS;
  }
}

class ReadOnlyDirectory extends Fd {
  private entries: readonly DirectoryEntry[] | null = null;

  constructor(
    protected readonly mount: Mount,
    protected readonly path: string,
  ) {
    super();
  }

  override fd_fdstat_get(): FdstatResult {
    return { ret: wasi.ERRNO_SUCCESS, fdstat: new wasi.Fdstat(wasi.FILETYPE_DIRECTORY, 0) };
  }

  override fd_fdstat_set_flags(): number {
    return wasi.ERRNO_SUCCESS;
  }

  override fd_filestat_get(): FilestatResult {
    const stat = this.mount.fs.stat(this.path);
    if (typeof stat === "number") return { ret: stat, filestat: null };
    return { ret: wasi.ERRNO_SUCCESS, filestat: this.mount.filestat(this.path, stat) };
  }

  override fd_read(): ReadResult {
    return { ret: wasi.ERRNO_ISDIR, data: EMPTY };
  }

  override fd_pread(): ReadResult {
    return { ret: wasi.ERRNO_ISDIR, data: EMPTY };
  }

  override fd_seek(): SeekResult {
    return { ret: wasi.ERRNO_BADF, offset: 0n };
  }

  override fd_tell(): SeekResult {
    return { ret: wasi.ERRNO_BADF, offset: 0n };
  }

  override fd_close(): number {
    this.entries = null;
    return wasi.ERRNO_SUCCESS;
  }

  override fd_readdir_single(cookie: bigint): ReaddirResult {
    if (cookie === 0n) {
      // A rewind re-lists; later cookies keep the snapshot so a multi-call readdir
      // cannot skip or repeat entries.
      this.entries = null;
      return this.dirent(1n, this.path, ".", wasi.FILETYPE_DIRECTORY);
    }
    if (cookie === 1n) return this.dirent(2n, parentOf(this.path), "..", wasi.FILETYPE_DIRECTORY);
    if (this.entries === null) {
      const entries = this.mount.fs.readDirectory(this.path);
      if (typeof entries === "number") return { ret: entries, dirent: null };
      this.entries = entries;
    }
    const entry = this.entries[Number(cookie - 2n)];
    if (entry === undefined) return { ret: wasi.ERRNO_SUCCESS, dirent: null };
    const [name, type] = entry;
    return this.dirent(cookie + 1n, childOf(this.path, name), name, filetypeOf(type));
  }

  override path_filestat_get(_flags: number, guestPath: string): FilestatResult {
    const { ret, path, stat } = this.mount.lookup(this.path, guestPath);
    if (stat === null) return { ret, filestat: null };
    return { ret, filestat: this.mount.filestat(path, stat) };
  }

  override path_readlink(guestPath: string): ReadlinkResult {
    // The file system follows symlinks itself, so from here nothing is one.
    const { ret, stat } = this.mount.lookup(this.path, guestPath);
    return { ret: stat === null ? ret : wasi.ERRNO_INVAL, data: null };
  }

  override path_open(
    _dirflags: number,
    guestPath: string,
    oflags: number,
    fsRightsBase: bigint,
    _fsRightsInheriting: bigint,
    _fdFlags: number,
  ): OpenResult {
    const writeRights = BigInt(wasi.RIGHTS_FD_WRITE);
    if (
      (oflags & (wasi.OFLAGS_CREAT | wasi.OFLAGS_TRUNC)) !== 0 ||
      (fsRightsBase & writeRights) !== 0n
    ) {
      return { ret: wasi.ERRNO_ROFS, fd_obj: null };
    }
    const { ret, path, stat } = this.mount.lookup(this.path, guestPath);
    if (stat === null) return { ret, fd_obj: null };
    if (stat.type === "directory") {
      return { ret: wasi.ERRNO_SUCCESS, fd_obj: new ReadOnlyDirectory(this.mount, path) };
    }
    if ((oflags & wasi.OFLAGS_DIRECTORY) !== 0) return { ret: wasi.ERRNO_NOTDIR, fd_obj: null };
    const data = this.mount.fs.readFile(path);
    if (typeof data === "number") return { ret: data, fd_obj: null };
    return { ret: wasi.ERRNO_SUCCESS, fd_obj: new ReadOnlyFile(this.mount, path, stat, data) };
  }

  override fd_write(): WriteResult {
    return { ret: wasi.ERRNO_ROFS, nwritten: 0 };
  }

  override fd_pwrite(): WriteResult {
    return { ret: wasi.ERRNO_ROFS, nwritten: 0 };
  }

  override fd_allocate(): number {
    return wasi.ERRNO_ROFS;
  }

  override fd_filestat_set_size(): number {
    return wasi.ERRNO_ROFS;
  }

  override fd_filestat_set_times(): number {
    return wasi.ERRNO_ROFS;
  }

  override path_create_directory(): number {
    return wasi.ERRNO_ROFS;
  }

  override path_filestat_set_times(): number {
    return wasi.ERRNO_ROFS;
  }

  override path_link(): number {
    return wasi.ERRNO_ROFS;
  }

  override path_unlink(): { ret: number; inode_obj: null } {
    return { ret: wasi.ERRNO_ROFS, inode_obj: null };
  }

  override path_lookup(): { ret: number; inode_obj: null } {
    return { ret: wasi.ERRNO_ROFS, inode_obj: null };
  }

  override path_remove_directory(): number {
    return wasi.ERRNO_ROFS;
  }

  override path_rename(): number {
    return wasi.ERRNO_ROFS;
  }

  override path_unlink_file(): number {
    return wasi.ERRNO_ROFS;
  }

  private dirent(next: bigint, path: string, name: string, filetype: number): ReaddirResult {
    return {
      ret: wasi.ERRNO_SUCCESS,
      dirent: new wasi.Dirent(next, this.mount.ino(path), name, filetype),
    };
  }
}

class PreopenRoot extends ReadOnlyDirectory {
  override fd_prestat_get(): PrestatResult {
    return { ret: wasi.ERRNO_SUCCESS, prestat: wasi.Prestat.dir("/") };
  }
}

/**
 * The read-only WASI preopen at guest `/` for one lint. Every lookup goes through `fs`, so
 * the tree is only ever as deep as what ShellCheck asks for; every mutation fails with
 * `EROFS`.
 */
export function createReadOnlyPreopen(fs: SyncFileSystem): Fd {
  return new PreopenRoot(new Mount(fs), "/");
}
