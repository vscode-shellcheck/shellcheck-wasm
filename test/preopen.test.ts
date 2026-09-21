import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { wasi } from "@bjorn3/browser_wasi_shim";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createReadOnlyPreopen, run, type ReadOnlyPreopen } from "../src/node.js";
import {
  codesOf,
  fixtureRoot,
  hasWasm,
  json1Comments,
  loadTestModule,
  skipHint,
  text,
  wasmHint,
} from "./helpers.js";

const JSON1_STDIN = ["-f", "json1", "-s", "bash", "-"];
const rcRoot = path.join(fixtureRoot, "rc");
const openFdCount = (): number => fs.readdirSync("/proc/self/fd").length;
const onLinux = process.platform === "linux";

function openFile(preopen: ReadOnlyPreopen, guestPath: string, oflags = 0) {
  return preopen.path_open(0, guestPath, oflags, 0n, 0n, 0);
}

describe("createReadOnlyPreopen", () => {
  const preopens: ReadOnlyPreopen[] = [];
  let scratch: string;
  let outside: string;

  const track = (preopen: ReadOnlyPreopen): ReadOnlyPreopen => {
    preopens.push(preopen);
    return preopen;
  };

  beforeAll(() => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "shellcheck-wasm-preopen-"));
    scratch = path.join(base, "root");
    outside = path.join(base, "outside");
    fs.mkdirSync(path.join(scratch, "child"), { recursive: true });
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "secret.sh"), "SECRET=1\n");
    fs.writeFileSync(path.join(scratch, "child", "inside.sh"), "INSIDE=1\n");
    fs.symlinkSync(path.join(outside, "secret.sh"), path.join(scratch, "child", "escape.sh"));
    fs.symlinkSync(outside, path.join(scratch, "child", "escape-dir"));
    fs.symlinkSync("inside.sh", path.join(scratch, "child", "alias.sh"));
  });

  afterEach(() => {
    for (const preopen of preopens.splice(0)) preopen.dispose();
  });

  afterAll(() => {
    fs.rmSync(path.dirname(scratch), { recursive: true, force: true });
  });

  it("announces the guest path as its prestat", () => {
    const preopen = track(createReadOnlyPreopen(rcRoot, "/work"));
    const { ret, prestat } = preopen.fd_prestat_get();
    expect(ret).toBe(wasi.ERRNO_SUCCESS);
    expect(new TextDecoder().decode(prestat?.inner.pr_name)).toBe("/work");
    expect(createReadOnlyPreopen(rcRoot).fd_prestat_get().prestat?.inner.pr_name).toEqual(
      new TextEncoder().encode("/"),
    );
  });

  it("rejects a host path that is not a directory", () => {
    expect(() => createReadOnlyPreopen(path.join(rcRoot, ".shellcheckrc"))).toThrow(
      /not a directory/,
    );
    expect(() => createReadOnlyPreopen(path.join(rcRoot, "does-not-exist"))).toThrow(/ENOENT/);
  });

  it("opens and reads a file through a nested directory fd", () => {
    const preopen = track(createReadOnlyPreopen(rcRoot));
    const dir = openFile(preopen, "child", wasi.OFLAGS_DIRECTORY);
    expect(dir.ret).toBe(wasi.ERRNO_SUCCESS);
    expect(dir.fd_obj?.fd_fdstat_get().fdstat?.fs_filetype).toBe(wasi.FILETYPE_DIRECTORY);

    const file = dir.fd_obj!.path_open(0, "lib.sh", 0, 0n, 0n, 0);
    expect(file.ret).toBe(wasi.ERRNO_SUCCESS);
    const fd = file.fd_obj!;
    expect(fd.fd_fdstat_get().fdstat?.fs_filetype).toBe(wasi.FILETYPE_REGULAR_FILE);

    const expected = fs.readFileSync(path.join(rcRoot, "child", "lib.sh"));
    const head = fd.fd_read(8);
    const rest = fd.fd_read(1 << 16);
    expect(Buffer.concat([head.data, rest.data])).toEqual(expected);
    expect(fd.fd_read(16).data).toHaveLength(0);
    expect(fd.fd_tell().offset).toBe(BigInt(expected.length));
    expect(fd.fd_seek(0n, wasi.WHENCE_SET)).toEqual({ ret: wasi.ERRNO_SUCCESS, offset: 0n });
    expect(fd.fd_seek(-3n, wasi.WHENCE_END).offset).toBe(BigInt(expected.length - 3));
    expect(fd.fd_pread(4, 0n).data).toEqual(new Uint8Array(expected.subarray(0, 4)));
    expect(fd.fd_filestat_get().filestat?.size).toBe(BigInt(expected.length));
    expect(fd.fd_close()).toBe(wasi.ERRNO_SUCCESS);
    expect(fd.fd_read(1).ret).toBe(wasi.ERRNO_BADF);
  });

  it("stats paths with and without following symlinks", () => {
    const preopen = track(createReadOnlyPreopen(scratch));
    const followed = preopen.path_filestat_get(1, "child/alias.sh");
    expect(followed.ret).toBe(wasi.ERRNO_SUCCESS);
    expect(followed.filestat?.filetype).toBe(wasi.FILETYPE_REGULAR_FILE);
    const unfollowed = preopen.path_filestat_get(0, "child/alias.sh");
    expect(unfollowed.filestat?.filetype).toBe(wasi.FILETYPE_SYMBOLIC_LINK);
    expect(preopen.path_readlink("child/alias.sh")).toEqual({
      ret: wasi.ERRNO_SUCCESS,
      data: "inside.sh",
    });
    expect(preopen.path_filestat_get(1, "child").filestat?.filetype).toBe(wasi.FILETYPE_DIRECTORY);
    expect(preopen.path_filestat_get(1, "./child/../child/./inside.sh").ret).toBe(
      wasi.ERRNO_SUCCESS,
    );
  });

  it("maps host errors to errnos", () => {
    const preopen = track(createReadOnlyPreopen(rcRoot));
    expect(openFile(preopen, "missing.sh").ret).toBe(wasi.ERRNO_NOENT);
    expect(preopen.path_filestat_get(1, "child/missing").ret).toBe(wasi.ERRNO_NOENT);
    expect(openFile(preopen, "child/lib.sh", wasi.OFLAGS_DIRECTORY).ret).toBe(wasi.ERRNO_NOTDIR);
    expect(openFile(preopen, "child/lib.sh/x").ret).toBe(wasi.ERRNO_NOTDIR);
    expect(openFile(preopen, "child\0x").ret).toBe(wasi.ERRNO_INVAL);
    const dir = openFile(preopen, "child");
    expect(dir.ret).toBe(wasi.ERRNO_SUCCESS);
    expect(dir.fd_obj?.fd_read(16).ret).toBe(wasi.ERRNO_ISDIR);
    expect(preopen.path_readlink("child/lib.sh").ret).toBe(wasi.ERRNO_INVAL);
  });

  it("enumerates a directory with . and .. first", () => {
    const preopen = track(createReadOnlyPreopen(rcRoot));
    const names: string[] = [];
    let cookie = 0n;
    for (;;) {
      const { ret, dirent } = preopen.fd_readdir_single(cookie);
      expect(ret).toBe(wasi.ERRNO_SUCCESS);
      if (dirent === null) break;
      names.push(new TextDecoder().decode(dirent.dir_name));
      cookie = dirent.d_next;
    }
    expect(names.slice(0, 2)).toEqual([".", ".."]);
    expect(names.slice(2).toSorted()).toEqual([".shellcheckrc", "child", "nearest"]);
    expect(preopen.fd_readdir_single(2n).dirent?.d_type).toBeOneOf([
      wasi.FILETYPE_REGULAR_FILE,
      wasi.FILETYPE_DIRECTORY,
    ]);
  });

  it("refuses paths that leave the root, textually or through a symlink", () => {
    const preopen = track(createReadOnlyPreopen(scratch));
    for (const escaping of [
      "..",
      "../outside/secret.sh",
      "child/../../outside/secret.sh",
      "/etc/passwd",
    ]) {
      expect(openFile(preopen, escaping).ret, escaping).toBe(wasi.ERRNO_NOTCAPABLE);
      expect(preopen.path_filestat_get(1, escaping).ret, escaping).toBe(wasi.ERRNO_NOTCAPABLE);
    }
    for (const viaSymlink of [
      "child/escape.sh",
      "child/escape-dir",
      "child/escape-dir/secret.sh",
    ]) {
      expect(openFile(preopen, viaSymlink).ret, viaSymlink).toBe(wasi.ERRNO_NOTCAPABLE);
      expect(preopen.path_filestat_get(1, viaSymlink).ret, viaSymlink).toBe(wasi.ERRNO_NOTCAPABLE);
      expect(preopen.path_filestat_get(0, viaSymlink).ret, viaSymlink).toBe(wasi.ERRNO_NOTCAPABLE);
      expect(preopen.path_readlink(viaSymlink).ret, viaSymlink).toBe(wasi.ERRNO_NOTCAPABLE);
    }
    expect(openFile(preopen, "child/alias.sh").ret).toBe(wasi.ERRNO_SUCCESS);
  });

  it("refuses every mutating operation with EROFS", () => {
    const preopen = track(createReadOnlyPreopen(rcRoot));
    expect(openFile(preopen, "new.sh", wasi.OFLAGS_CREAT).ret).toBe(wasi.ERRNO_ROFS);
    expect(openFile(preopen, "child/lib.sh", wasi.OFLAGS_TRUNC).ret).toBe(wasi.ERRNO_ROFS);
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

    const file = openFile(preopen, "child/lib.sh").fd_obj!;
    expect(file.fd_write(new Uint8Array([1])).ret).toBe(wasi.ERRNO_ROFS);
    expect(file.fd_pwrite(new Uint8Array([1]), 0n).ret).toBe(wasi.ERRNO_ROFS);
    expect(file.fd_allocate(0n, 1n)).toBe(wasi.ERRNO_ROFS);
    expect(file.fd_filestat_set_size(0n)).toBe(wasi.ERRNO_ROFS);
    expect(file.fd_filestat_set_times(0n, 0n, 0)).toBe(wasi.ERRNO_ROFS);
    expect(fs.readFileSync(path.join(rcRoot, "child", "lib.sh"), "utf8")).toContain("lib_greet");
  });

  it("caps open files at 256 with ENFILE", () => {
    const preopen = track(createReadOnlyPreopen(rcRoot));
    for (let i = 0; i < 256; i += 1) {
      expect(openFile(preopen, "child/lib.sh").ret).toBe(wasi.ERRNO_SUCCESS);
    }
    expect(openFile(preopen, "child/lib.sh").ret).toBe(wasi.ERRNO_NFILE);
    preopen.dispose();
    expect(openFile(preopen, "child/lib.sh").ret).toBe(wasi.ERRNO_SUCCESS);
  });

  it.skipIf(!onLinux)("dispose closes host descriptors the guest left open", () => {
    const before = openFdCount();
    const preopen = createReadOnlyPreopen(rcRoot);
    const first = openFile(preopen, "child/lib.sh");
    const second = openFile(preopen, "child/main.sh");
    expect(openFdCount()).toBe(before + 2);
    expect(first.fd_obj!.fd_close()).toBe(wasi.ERRNO_SUCCESS);
    expect(openFdCount()).toBe(before + 1);
    preopen.dispose();
    expect(openFdCount()).toBe(before);
    expect(second.fd_obj!.fd_read(1).ret).toBe(wasi.ERRNO_BADF);
    preopen.dispose();
    expect(openFdCount()).toBe(before);
  });

  it.skipIf(!onLinux)("closes the host descriptor when fstat fails after open", () => {
    const preopen = track(createReadOnlyPreopen(rcRoot));
    const before = openFdCount();
    const fstat = vi.spyOn(fs, "fstatSync").mockImplementationOnce(() => {
      throw Object.assign(new Error("injected"), { code: "EIO" });
    });
    try {
      expect(openFile(preopen, "child/lib.sh").ret).toBe(wasi.ERRNO_IO);
    } finally {
      fstat.mockRestore();
    }
    expect(openFdCount()).toBe(before);
  });

  describe.skipIf(skipHint(!hasWasm, wasmHint))("with ShellCheck", () => {
    let module: WebAssembly.Module;

    beforeAll(async () => {
      module = await loadTestModule();
    });

    it("finds a .shellcheckrc above the guest working directory", () => {
      const withRc = run(module, {
        args: JSON1_STDIN,
        stdin: "echo $x\n",
        env: { PWD: "/child" },
        preopens: [track(createReadOnlyPreopen(rcRoot))],
      });
      expect(codesOf(withRc.stdout)).toEqual([2154]);

      const withoutRc = run(module, { args: JSON1_STDIN, stdin: "echo $x\n" });
      expect(codesOf(withoutRc.stdout)).toEqual([2154, 2086]);
    });

    it("lets the nearest .shellcheckrc shadow the one above it", () => {
      const result = run(module, {
        args: JSON1_STDIN,
        stdin: "unused_here=1\necho $PATH\n",
        env: { PWD: "/nearest" },
        preopens: [track(createReadOnlyPreopen(rcRoot))],
      });
      expect(codesOf(result.stdout)).toEqual([2086]);
    });

    it("follows source relative to the guest working directory with -x", () => {
      const script = 'source ./lib.sh\necho "$LIB_HOME"\n';
      const followed = run(module, {
        args: ["-x", ...JSON1_STDIN],
        stdin: script,
        env: { PWD: "/child" },
        preopens: [track(createReadOnlyPreopen(rcRoot))],
      });
      expect(followed.exitCode).toBe(0);
      expect(codesOf(followed.stdout)).toEqual([]);

      const unfollowed = run(module, {
        args: JSON1_STDIN,
        stdin: script,
        env: { PWD: "/child" },
        preopens: [track(createReadOnlyPreopen(rcRoot))],
      });
      expect(codesOf(unfollowed.stdout)).toEqual([1091]);
    });

    it("reports a sourced file behind an escaping symlink as unreadable", () => {
      const result = run(module, {
        args: ["-x", ...JSON1_STDIN],
        stdin: 'source ./escape.sh\necho "$SECRET"\n',
        env: { PWD: "/child" },
        preopens: [track(createReadOnlyPreopen(scratch))],
      });
      const comments = json1Comments(result.stdout);
      expect(comments.map((comment) => comment.code)).toEqual([1091]);
      expect(comments[0]?.message).toContain("./escape.sh");
      expect(comments[0]?.message).not.toContain("does not exist");
      expect(text(result.stderr)).toBe("");

      const control = run(module, {
        args: ["-x", ...JSON1_STDIN],
        stdin: 'source ./inside.sh\necho "$INSIDE"\n',
        env: { PWD: "/child" },
        preopens: [track(createReadOnlyPreopen(scratch))],
      });
      expect(codesOf(control.stdout)).toEqual([]);
    });

    it("mounts at a guest path other than /", () => {
      const result = run(module, {
        args: ["-x", ...JSON1_STDIN],
        stdin: 'source /work/child/lib.sh\necho "$LIB_HOME"\n',
        env: { PWD: "/work/child" },
        preopens: [track(createReadOnlyPreopen(rcRoot, "/work"))],
      });
      expect(codesOf(result.stdout)).toEqual([]);
    });

    it.skipIf(!onLinux)("does not leak host descriptors across 50 runs", () => {
      const before = openFdCount();
      for (let i = 0; i < 50; i += 1) {
        const preopen = createReadOnlyPreopen(rcRoot);
        const result = run(module, {
          args: ["-x", ...JSON1_STDIN],
          stdin: "source ./lib.sh\nlib_greet $USER\n",
          env: { PWD: "/child" },
          preopens: [preopen],
        });
        preopen.dispose();
        expect(result.exitCode).toBe(0);
      }
      expect(openFdCount()).toBeLessThanOrEqual(before);
    });
  });
});
