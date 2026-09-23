import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { wasi, type Fd } from "@bjorn3/browser_wasi_shim";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DirectoryEntry, SyncFileSystem } from "../src/bridge.js";
import type { FileType } from "../src/index.js";
import { createReadOnlyPreopen } from "../src/preopen.js";
import {
  codesOf,
  createTestShellCheck,
  fixtureRoot,
  json1Comments,
  skipWorkerTests,
  type TestShellCheck,
} from "./helpers.js";
import { fileSystemError, memoryFileSystem, nodeFileSystem } from "./support/file-systems.js";

const JSON1_STDIN = ["-f", "json1", "-s", "bash", "-"];
const rcRoot = path.join(fixtureRoot, "rc");
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** A synchronous in-memory stand-in for the bridge; parent directories are implied. */
function syncFileSystem(files: Record<string, string>): SyncFileSystem & { calls: string[] } {
  const calls: string[] = [];
  const directories = new Map<string, Map<string, FileType>>([["/", new Map()]]);
  for (const file of Object.keys(files)) {
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
  return {
    calls,
    stat: (guestPath) => {
      calls.push(`stat ${guestPath}`);
      const content = files[guestPath];
      if (content !== undefined) return { type: "file", size: content.length, mtime: 1_000 };
      if (directories.has(guestPath)) return { type: "directory", size: 0, mtime: 1_000 };
      return wasi.ERRNO_NOENT;
    },
    readFile: (guestPath) => {
      calls.push(`readFile ${guestPath}`);
      const content = files[guestPath];
      return content === undefined ? wasi.ERRNO_NOENT : encoder.encode(content);
    },
    readDirectory: (guestPath): readonly DirectoryEntry[] | number => {
      calls.push(`readDirectory ${guestPath}`);
      const entries = directories.get(guestPath);
      return entries === undefined ? wasi.ERRNO_NOTDIR : [...entries];
    },
  };
}

function openAt(dir: Fd, guestPath: string, oflags = 0) {
  return dir.path_open(0, guestPath, oflags, 0n, 0n, 0);
}

describe("read-only preopen", () => {
  const files = {
    "/.shellcheckrc": "disable=SC2086\n",
    "/child/lib.sh": 'LIB_HOME="/opt/lib"\n',
    "/child/nested/deep.sh": "echo deep\n",
  };

  it("announces itself as guest /", () => {
    const { ret, prestat } = createReadOnlyPreopen(syncFileSystem(files)).fd_prestat_get();
    expect(ret).toBe(wasi.ERRNO_SUCCESS);
    expect(decoder.decode(prestat?.inner.pr_name)).toBe("/");
  });

  it("opens and reads a file through a nested directory fd", () => {
    const preopen = createReadOnlyPreopen(syncFileSystem(files));
    const dir = openAt(preopen, "child", wasi.OFLAGS_DIRECTORY);
    expect(dir.ret).toBe(wasi.ERRNO_SUCCESS);
    expect(dir.fd_obj?.fd_fdstat_get().fdstat?.fs_filetype).toBe(wasi.FILETYPE_DIRECTORY);

    const file = openAt(dir.fd_obj!, "lib.sh");
    expect(file.ret).toBe(wasi.ERRNO_SUCCESS);
    const fd = file.fd_obj!;
    expect(fd.fd_fdstat_get().fdstat?.fs_filetype).toBe(wasi.FILETYPE_REGULAR_FILE);
    expect(fd.fd_fdstat_set_flags(0)).toBe(wasi.ERRNO_SUCCESS);

    const expected = encoder.encode(files["/child/lib.sh"]);
    const head = fd.fd_read(8);
    const rest = fd.fd_read(1 << 16);
    expect(new Uint8Array([...head.data, ...rest.data])).toEqual(expected);
    expect(fd.fd_read(16).data).toHaveLength(0);
    expect(fd.fd_tell().offset).toBe(BigInt(expected.length));
    expect(fd.fd_seek(-3n, wasi.WHENCE_END).offset).toBe(BigInt(expected.length - 3));
    expect(fd.fd_pread(4, 0n).data).toEqual(expected.subarray(0, 4));

    const byFd = fd.fd_filestat_get().filestat!;
    const byPath = preopen.path_filestat_get(1, "child/lib.sh").filestat!;
    expect(byFd.size).toBe(BigInt(expected.length));
    expect(byFd.filetype).toBe(wasi.FILETYPE_REGULAR_FILE);
    expect(byFd.ino).toBe(byPath.ino);
    expect(byPath.mtim).toBe(1_000_000_000n);
  });

  it("maps lookups to errnos", () => {
    const preopen = createReadOnlyPreopen(syncFileSystem(files));
    expect(openAt(preopen, "missing.sh").ret).toBe(wasi.ERRNO_NOENT);
    expect(preopen.path_filestat_get(1, "child/missing").ret).toBe(wasi.ERRNO_NOENT);
    expect(openAt(preopen, "child/lib.sh", wasi.OFLAGS_DIRECTORY).ret).toBe(wasi.ERRNO_NOTDIR);
    expect(openAt(preopen, "child/lib.sh/").ret).toBe(wasi.ERRNO_NOTDIR);
    expect(preopen.path_filestat_get(1, "child/lib.sh/").ret).toBe(wasi.ERRNO_NOTDIR);
    expect(openAt(preopen, "child\0x").ret).toBe(wasi.ERRNO_INVAL);
    expect(preopen.path_filestat_get(1, "child/").filestat?.filetype).toBe(wasi.FILETYPE_DIRECTORY);
    expect(preopen.path_filestat_get(1, "./child/../child/./lib.sh").ret).toBe(wasi.ERRNO_SUCCESS);
    const dir = openAt(preopen, "child");
    expect(dir.fd_obj?.fd_read(16).ret).toBe(wasi.ERRNO_ISDIR);
    expect(dir.fd_obj?.fd_filestat_get().filestat?.filetype).toBe(wasi.FILETYPE_DIRECTORY);
  });

  it("reports nothing as a symlink", () => {
    const preopen = createReadOnlyPreopen(syncFileSystem(files));
    expect(preopen.path_readlink("child/lib.sh")).toEqual({ ret: wasi.ERRNO_INVAL, data: null });
    expect(preopen.path_readlink("child")).toEqual({ ret: wasi.ERRNO_INVAL, data: null });
    expect(preopen.path_readlink("child/missing")).toEqual({ ret: wasi.ERRNO_NOENT, data: null });
  });

  it("enumerates a directory with . and .. first", () => {
    const preopen = createReadOnlyPreopen(syncFileSystem(files));
    const entries: [string, number][] = [];
    let cookie = 0n;
    for (;;) {
      const { ret, dirent } = preopen.fd_readdir_single(cookie);
      expect(ret).toBe(wasi.ERRNO_SUCCESS);
      if (dirent === null) break;
      entries.push([decoder.decode(dirent.dir_name), dirent.d_type]);
      cookie = dirent.d_next;
    }
    expect(entries).toEqual([
      [".", wasi.FILETYPE_DIRECTORY],
      ["..", wasi.FILETYPE_DIRECTORY],
      [".shellcheckrc", wasi.FILETYPE_REGULAR_FILE],
      ["child", wasi.FILETYPE_DIRECTORY],
    ]);
  });

  it("refuses paths that leave the mount without asking the file system", () => {
    const mount = syncFileSystem(files);
    const preopen = createReadOnlyPreopen(mount);
    const child = openAt(preopen, "child").fd_obj!;
    mount.calls.length = 0;
    for (const escaping of ["..", "../outside/secret.sh", "child/../../outside", "/etc/passwd"]) {
      expect(openAt(preopen, escaping).ret, escaping).toBe(wasi.ERRNO_NOTCAPABLE);
      expect(preopen.path_filestat_get(1, escaping).ret, escaping).toBe(wasi.ERRNO_NOTCAPABLE);
      expect(preopen.path_readlink(escaping).ret, escaping).toBe(wasi.ERRNO_NOTCAPABLE);
    }
    expect(openAt(child, "../../child/lib.sh").ret).toBe(wasi.ERRNO_NOTCAPABLE);
    expect(mount.calls).toEqual([]);
    expect(openAt(child, "../child/./lib.sh").ret).toBe(wasi.ERRNO_SUCCESS);
    expect(mount.calls).toEqual(["stat /child/lib.sh", "readFile /child/lib.sh"]);
  });

  it("refuses every mutating operation with EROFS", () => {
    const preopen = createReadOnlyPreopen(syncFileSystem(files));
    expect(openAt(preopen, "new.sh", wasi.OFLAGS_CREAT).ret).toBe(wasi.ERRNO_ROFS);
    expect(openAt(preopen, "child/lib.sh", wasi.OFLAGS_TRUNC).ret).toBe(wasi.ERRNO_ROFS);
    expect(preopen.path_open(0, "child/lib.sh", 0, BigInt(wasi.RIGHTS_FD_WRITE), 0n, 0).ret).toBe(
      wasi.ERRNO_ROFS,
    );
    expect(preopen.path_create_directory("x")).toBe(wasi.ERRNO_ROFS);
    expect(preopen.path_unlink_file("child/lib.sh")).toBe(wasi.ERRNO_ROFS);
    expect(preopen.path_remove_directory("child")).toBe(wasi.ERRNO_ROFS);
    expect(preopen.path_rename("child/lib.sh", 3, "child/moved.sh")).toBe(wasi.ERRNO_ROFS);
    expect(preopen.path_filestat_set_times(0, "child/lib.sh", 0n, 0n, 0)).toBe(wasi.ERRNO_ROFS);
    expect(preopen.fd_write(new Uint8Array([1])).ret).toBe(wasi.ERRNO_ROFS);
    expect(preopen.fd_allocate(0n, 1n)).toBe(wasi.ERRNO_ROFS);
    expect(preopen.fd_filestat_set_size(0n)).toBe(wasi.ERRNO_ROFS);
    expect(preopen.fd_filestat_set_times(0n, 0n, 0)).toBe(wasi.ERRNO_ROFS);

    const file = openAt(preopen, "child/lib.sh").fd_obj!;
    expect(file.fd_write(new Uint8Array([1])).ret).toBe(wasi.ERRNO_ROFS);
    expect(file.fd_pwrite(new Uint8Array([1]), 0n).ret).toBe(wasi.ERRNO_ROFS);
    expect(file.fd_allocate(0n, 1n)).toBe(wasi.ERRNO_ROFS);
    expect(file.fd_filestat_set_size(0n)).toBe(wasi.ERRNO_ROFS);
    expect(file.fd_filestat_set_times(0n, 0n, 0)).toBe(wasi.ERRNO_ROFS);
    expect(decoder.decode(file.fd_pread(64, 0n).data)).toBe(files["/child/lib.sh"]);
  });
});

describe.skipIf(skipWorkerTests())("read-only preopen with ShellCheck", () => {
  let shellcheck: TestShellCheck;
  let scratch: string;

  beforeAll(() => {
    shellcheck = createTestShellCheck();
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "shellcheck-wasm-preopen-"));
    fs.mkdirSync(path.join(scratch, "root", "child"), { recursive: true });
    fs.mkdirSync(path.join(scratch, "outside"));
    fs.writeFileSync(path.join(scratch, "outside", "secret.sh"), "SECRET=1\n");
    fs.writeFileSync(path.join(scratch, "root", "child", "inside.sh"), "INSIDE=1\n");
  });

  afterAll(async () => {
    await shellcheck.dispose();
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it("finds a .shellcheckrc above the guest working directory", async () => {
    const withRc = await shellcheck.lint({
      args: JSON1_STDIN,
      stdin: "echo $x\n",
      env: { PWD: "/child" },
      fs: nodeFileSystem(rcRoot),
    });
    expect(codesOf(withRc.stdout)).toEqual([2154]);

    const withoutRc = await shellcheck.lint({ args: JSON1_STDIN, stdin: "echo $x\n" });
    expect(codesOf(withoutRc.stdout)).toEqual([2154, 2086]);
  });

  it("lets the nearest .shellcheckrc shadow the one above it", async () => {
    const result = await shellcheck.lint({
      args: JSON1_STDIN,
      stdin: "unused_here=1\necho $PATH\n",
      env: { PWD: "/nearest" },
      fs: nodeFileSystem(rcRoot),
    });
    expect(codesOf(result.stdout)).toEqual([2086]);
  });

  it("follows source relative to the guest working directory with -x", async () => {
    const script = 'source ./lib.sh\necho "$LIB_HOME"\n';
    const followed = await shellcheck.lint({
      args: ["-x", ...JSON1_STDIN],
      stdin: script,
      env: { PWD: "/child" },
      fs: nodeFileSystem(rcRoot),
    });
    expect(followed.exitCode).toBe(0);
    expect(codesOf(followed.stdout)).toEqual([]);

    const unfollowed = await shellcheck.lint({
      args: JSON1_STDIN,
      stdin: script,
      env: { PWD: "/child" },
      fs: nodeFileSystem(rcRoot),
    });
    expect(codesOf(unfollowed.stdout)).toEqual([1091]);
  });

  it("asks the file system about each path at most once per lint", async () => {
    const mount = nodeFileSystem(rcRoot);
    await shellcheck.lint({
      args: ["-x", ...JSON1_STDIN],
      stdin: "source ../lib.sh\nsource ../lib.sh\necho $x\n",
      env: { PWD: "/child/nested" },
      fs: mount,
    });
    expect(mount.calls).toContain("readFile /.shellcheckrc");
    expect(mount.calls).toContain("readFile /child/lib.sh");
    expect(new Set(mount.calls).size).toBe(mount.calls.length);
  });

  it("never lets .. reach a file outside the mount", async () => {
    const mount = nodeFileSystem(path.join(scratch, "root"));
    const result = await shellcheck.lint({
      args: ["-x", ...JSON1_STDIN],
      stdin: 'source ../../outside/secret.sh\necho "$SECRET"\n',
      env: { PWD: "/child" },
      fs: mount,
    });
    const comments = json1Comments(result.stdout);
    expect(comments.map((comment) => comment.code)).toEqual([1091]);
    expect(comments[0]?.message).toContain("../../outside/secret.sh");
    expect(result.stderr).toBe("");
    expect(mount.calls.filter((call) => call.includes("secret"))).toEqual([]);

    const control = await shellcheck.lint({
      args: ["-x", ...JSON1_STDIN],
      stdin: 'source ./inside.sh\necho "$INSIDE"\n',
      env: { PWD: "/child" },
      fs: nodeFileSystem(path.join(scratch, "root")),
    });
    expect(codesOf(control.stdout)).toEqual([]);
  });

  it("reports a sourced file the file system refuses", async () => {
    const mount = memoryFileSystem(
      { "/work/lib.sh": "LIB=1\n" },
      {
        readFile: async () => {
          throw fileSystemError("NoPermissions");
        },
      },
    );
    const result = await shellcheck.lint({
      args: ["-x", ...JSON1_STDIN],
      stdin: 'source ./lib.sh\necho "$LIB"\n',
      env: { PWD: "/work" },
      fs: mount,
    });
    const comments = json1Comments(result.stdout);
    expect(comments[0]?.code).toBe(1091);
    expect(comments[0]?.message).toMatch(/permission denied/i);
  });
});
