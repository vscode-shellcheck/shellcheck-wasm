import fs from "node:fs";
import path from "node:path";
import { Fd, wasi } from "@bjorn3/browser_wasi_shim";

/** A read-only WASI preopen backed by a host directory. */
export interface ReadOnlyPreopen extends Fd {
  /** Closes every host file descriptor the guest left open under this preopen. */
  dispose(): void;
}

const MAX_OPEN_FILES = 256;

/** preview1 `lookupflags::symlink_follow`; the shim does not export it. */
const LOOKUPFLAGS_SYMLINK_FOLLOW = 1;

type FdstatResult = { ret: number; fdstat: wasi.Fdstat | null };
type FilestatResult = { ret: number; filestat: wasi.Filestat | null };
type ReadResult = { ret: number; data: Uint8Array };
type WriteResult = { ret: number; nwritten: number };
type SeekResult = { ret: number; offset: bigint };
type OpenResult = { ret: number; fd_obj: Fd | null };
type ReaddirResult = { ret: number; dirent: wasi.Dirent | null };
type ReadlinkResult = { ret: number; data: string | null };
type PrestatResult = { ret: number; prestat: wasi.Prestat | null };
type Resolved = { ret: number; hostPath: string | null };

const EMPTY = new Uint8Array();

/**
 * Node exceptions must become errnos: an exception escaping an fd method unwinds
 * through the guest's wasm stack instead of reaching its error handling.
 */
function errnoOf(error: unknown): number {
  switch ((error as NodeJS.ErrnoException | undefined)?.code) {
    case "ENOENT":
      return wasi.ERRNO_NOENT;
    case "EACCES":
      return wasi.ERRNO_ACCES;
    case "EPERM":
      return wasi.ERRNO_PERM;
    case "ENOTDIR":
      return wasi.ERRNO_NOTDIR;
    case "EISDIR":
      return wasi.ERRNO_ISDIR;
    case "EINVAL":
      return wasi.ERRNO_INVAL;
    case "ELOOP":
      return wasi.ERRNO_LOOP;
    case "ENAMETOOLONG":
      return wasi.ERRNO_NAMETOOLONG;
    case "EMFILE":
      return wasi.ERRNO_MFILE;
    case "ENFILE":
      return wasi.ERRNO_NFILE;
    case "EBUSY":
      return wasi.ERRNO_BUSY;
    case "EBADF":
      return wasi.ERRNO_BADF;
    default:
      return wasi.ERRNO_IO;
  }
}

function filetypeOf(stats: fs.BigIntStats): number {
  if (stats.isDirectory()) return wasi.FILETYPE_DIRECTORY;
  if (stats.isSymbolicLink()) return wasi.FILETYPE_SYMBOLIC_LINK;
  if (stats.isFile()) return wasi.FILETYPE_REGULAR_FILE;
  if (stats.isCharacterDevice()) return wasi.FILETYPE_CHARACTER_DEVICE;
  if (stats.isBlockDevice()) return wasi.FILETYPE_BLOCK_DEVICE;
  return wasi.FILETYPE_UNKNOWN;
}

function filestatOf(stats: fs.BigIntStats): wasi.Filestat {
  const filestat = new wasi.Filestat(stats.ino, filetypeOf(stats), stats.size);
  filestat.dev = stats.dev;
  filestat.nlink = stats.nlink;
  filestat.atim = stats.atimeNs;
  filestat.mtim = stats.mtimeNs;
  filestat.ctim = stats.ctimeNs;
  return filestat;
}

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep);
}

/** State shared by every fd derived from one preopen: the containment root and the open host fds. */
class PreopenRoot {
  readonly root: string;
  private readonly openFiles = new Set<HostFile>();

  constructor(hostDir: string) {
    // Containment compares real paths, so the root has to be one too (e.g. /tmp on macOS).
    this.root = fs.realpathSync.native(hostDir);
    if (!fs.statSync(this.root).isDirectory()) {
      throw new Error(`createReadOnlyPreopen: ${hostDir} is not a directory`);
    }
  }

  /**
   * Maps a guest path (relative to `baseDir`, itself inside the root) to a host path.
   * `..` is folded textually first, then the real path must stay under the root, so a
   * symlink pointing outside is indistinguishable from a path the guest may not name.
   */
  resolve(baseDir: string, guestPath: string): Resolved {
    if (guestPath.includes("\0")) return { ret: wasi.ERRNO_INVAL, hostPath: null };
    // wasi-libc turns absolute paths into (preopen fd, relative path) itself; one that
    // reaches us bypassed that and has no preopen to be relative to.
    if (guestPath.startsWith("/")) return { ret: wasi.ERRNO_NOTCAPABLE, hostPath: null };

    const hostPath = path.resolve(baseDir, guestPath);
    if (!isInside(this.root, hostPath)) return { ret: wasi.ERRNO_NOTCAPABLE, hostPath: null };

    let realPath: string;
    try {
      realPath = fs.realpathSync.native(hostPath);
    } catch (error) {
      return { ret: errnoOf(error), hostPath: null };
    }
    if (!isInside(this.root, realPath)) return { ret: wasi.ERRNO_NOTCAPABLE, hostPath: null };
    return { ret: wasi.ERRNO_SUCCESS, hostPath };
  }

  openFile(hostPath: string): OpenResult {
    if (this.openFiles.size >= MAX_OPEN_FILES) return { ret: wasi.ERRNO_NFILE, fd_obj: null };
    let fd: number;
    try {
      fd = fs.openSync(hostPath, fs.constants.O_RDONLY);
    } catch (error) {
      return { ret: errnoOf(error), fd_obj: null };
    }
    let stats: fs.BigIntStats;
    try {
      stats = fs.fstatSync(fd, { bigint: true });
    } catch (error) {
      // Not in openFiles yet, so dispose() could never reclaim it.
      try {
        fs.closeSync(fd);
      } catch {
        // The fstat errno is the one the guest needs.
      }
      return { ret: errnoOf(error), fd_obj: null };
    }
    const file = new HostFile(this, fd, filetypeOf(stats));
    this.openFiles.add(file);
    return { ret: wasi.ERRNO_SUCCESS, fd_obj: file };
  }

  release(file: HostFile): void {
    this.openFiles.delete(file);
  }

  dispose(): void {
    for (const file of Array.from(this.openFiles)) file.fd_close();
  }
}

class HostFile extends Fd {
  private fd: number | null;
  private position = 0n;

  constructor(
    private readonly owner: PreopenRoot,
    fd: number,
    private readonly filetype: number,
  ) {
    super();
    this.fd = fd;
  }

  override fd_fdstat_get(): FdstatResult {
    return { ret: wasi.ERRNO_SUCCESS, fdstat: new wasi.Fdstat(this.filetype, 0) };
  }

  override fd_fdstat_set_flags(): number {
    return wasi.ERRNO_SUCCESS;
  }

  override fd_filestat_get(): FilestatResult {
    if (this.fd === null) return { ret: wasi.ERRNO_BADF, filestat: null };
    try {
      return {
        ret: wasi.ERRNO_SUCCESS,
        filestat: filestatOf(fs.fstatSync(this.fd, { bigint: true })),
      };
    } catch (error) {
      return { ret: errnoOf(error), filestat: null };
    }
  }

  override fd_read(size: number): ReadResult {
    const result = this.readAt(size, this.position);
    this.position += BigInt(result.data.byteLength);
    return result;
  }

  override fd_pread(size: number, offset: bigint): ReadResult {
    return this.readAt(size, offset);
  }

  override fd_seek(offset: bigint, whence: number): SeekResult {
    if (this.fd === null) return { ret: wasi.ERRNO_BADF, offset: 0n };
    let target: bigint;
    switch (whence) {
      case wasi.WHENCE_SET:
        target = offset;
        break;
      case wasi.WHENCE_CUR:
        target = this.position + offset;
        break;
      case wasi.WHENCE_END:
        try {
          target = fs.fstatSync(this.fd, { bigint: true }).size + offset;
        } catch (error) {
          return { ret: errnoOf(error), offset: 0n };
        }
        break;
      default:
        return { ret: wasi.ERRNO_INVAL, offset: 0n };
    }
    if (target < 0n) return { ret: wasi.ERRNO_INVAL, offset: 0n };
    this.position = target;
    return { ret: wasi.ERRNO_SUCCESS, offset: target };
  }

  override fd_tell(): SeekResult {
    if (this.fd === null) return { ret: wasi.ERRNO_BADF, offset: 0n };
    return { ret: wasi.ERRNO_SUCCESS, offset: this.position };
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

  override fd_close(): number {
    const fd = this.fd;
    this.fd = null;
    this.owner.release(this);
    if (fd === null) return wasi.ERRNO_BADF;
    try {
      fs.closeSync(fd);
    } catch (error) {
      return errnoOf(error);
    }
    return wasi.ERRNO_SUCCESS;
  }

  private readAt(size: number, offset: bigint): ReadResult {
    if (this.fd === null) return { ret: wasi.ERRNO_BADF, data: EMPTY };
    if (size === 0) return { ret: wasi.ERRNO_SUCCESS, data: EMPTY };
    const buffer = new Uint8Array(size);
    try {
      const read = fs.readSync(this.fd, buffer, 0, size, Number(offset));
      return { ret: wasi.ERRNO_SUCCESS, data: buffer.subarray(0, read) };
    } catch (error) {
      return { ret: errnoOf(error), data: EMPTY };
    }
  }
}

class HostDirectory extends Fd {
  private entries: fs.Dirent[] | null = null;

  constructor(
    protected readonly owner: PreopenRoot,
    protected readonly hostPath: string,
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
    try {
      return {
        ret: wasi.ERRNO_SUCCESS,
        filestat: filestatOf(fs.statSync(this.hostPath, { bigint: true })),
      };
    } catch (error) {
      return { ret: errnoOf(error), filestat: null };
    }
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
      // A rewind re-lists; later cookies keep the snapshot so a directory changing
      // underneath a multi-call readdir cannot skip or repeat entries.
      this.entries = null;
      return this.dirent(1n, this.hostPath, ".");
    }
    if (cookie === 1n) return this.dirent(2n, path.dirname(this.hostPath), "..");
    if (this.entries === null) {
      try {
        this.entries = fs.readdirSync(this.hostPath, { withFileTypes: true });
      } catch (error) {
        return { ret: errnoOf(error), dirent: null };
      }
    }
    const entry = this.entries[Number(cookie - 2n)];
    if (entry === undefined) return { ret: wasi.ERRNO_SUCCESS, dirent: null };
    return this.dirent(cookie + 1n, path.join(this.hostPath, entry.name), entry.name);
  }

  override path_filestat_get(flags: number, guestPath: string): FilestatResult {
    const { ret, hostPath } = this.owner.resolve(this.hostPath, guestPath);
    if (hostPath === null) return { ret, filestat: null };
    try {
      const stats =
        (flags & LOOKUPFLAGS_SYMLINK_FOLLOW) !== 0
          ? fs.statSync(hostPath, { bigint: true })
          : fs.lstatSync(hostPath, { bigint: true });
      return { ret: wasi.ERRNO_SUCCESS, filestat: filestatOf(stats) };
    } catch (error) {
      return { ret: errnoOf(error), filestat: null };
    }
  }

  override path_readlink(guestPath: string): ReadlinkResult {
    const { ret, hostPath } = this.owner.resolve(this.hostPath, guestPath);
    if (hostPath === null) return { ret, data: null };
    try {
      return { ret: wasi.ERRNO_SUCCESS, data: fs.readlinkSync(hostPath, "utf8") };
    } catch (error) {
      return { ret: errnoOf(error), data: null };
    }
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
    const { ret, hostPath } = this.owner.resolve(this.hostPath, guestPath);
    if (hostPath === null) return { ret, fd_obj: null };
    let stats: fs.BigIntStats;
    try {
      stats = fs.statSync(hostPath, { bigint: true });
    } catch (error) {
      return { ret: errnoOf(error), fd_obj: null };
    }
    if (stats.isDirectory()) {
      return { ret: wasi.ERRNO_SUCCESS, fd_obj: new HostDirectory(this.owner, hostPath) };
    }
    if ((oflags & wasi.OFLAGS_DIRECTORY) !== 0) return { ret: wasi.ERRNO_NOTDIR, fd_obj: null };
    return this.owner.openFile(hostPath);
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

  private dirent(next: bigint, hostPath: string, name: string): ReaddirResult {
    let ino = 0n;
    let filetype = wasi.FILETYPE_UNKNOWN;
    try {
      const stats = fs.lstatSync(hostPath, { bigint: true });
      ino = stats.ino;
      filetype = filetypeOf(stats);
    } catch {
      // The entry vanished between readdir and lstat; report it with unknown type
      // rather than fail the whole listing.
    }
    return { ret: wasi.ERRNO_SUCCESS, dirent: new wasi.Dirent(next, ino, name, filetype) };
  }
}

class PreopenDirectory extends HostDirectory implements ReadOnlyPreopen {
  constructor(
    owner: PreopenRoot,
    private readonly guestPath: string,
  ) {
    super(owner, owner.root);
  }

  override fd_prestat_get(): PrestatResult {
    return { ret: wasi.ERRNO_SUCCESS, prestat: wasi.Prestat.dir(this.guestPath) };
  }

  dispose(): void {
    this.owner.dispose();
  }
}

/**
 * A read-only WASI preopen serving `hostDir` to the guest at `guestPath` (default `/`).
 * Guest paths are contained by real path: anything that resolves outside `hostDir`,
 * including through a symlink, is refused with `ENOTCAPABLE`. Every mutating call
 * fails with `EROFS`. Call `dispose()` after the run to close host fds the guest left open.
 */
export function createReadOnlyPreopen(hostDir: string, guestPath = "/"): ReadOnlyPreopen {
  return new PreopenDirectory(new PreopenRoot(hostDir), guestPath);
}
