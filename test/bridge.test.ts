import { createHash } from "node:crypto";
import { wasi } from "@bjorn3/browser_wasi_shim";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ShellCheckFileSystem } from "../src/index.js";
import { CHUNK_BYTES, errnoOf } from "../src/protocol.js";
import {
  createTestShellCheck,
  nodeWorkerPort,
  skipWorkerTests,
  supportWorkerUrl,
  type TestShellCheck,
} from "./helpers.js";
import { fileSystemError, memoryFileSystem } from "./support/file-systems.js";

type BridgeResult = { errno: number } | { size: number; sha256: string } | { value: unknown };

function bytes(size: number): Uint8Array {
  const data = new Uint8Array(size);
  for (let i = 0; i < size; i += 1) data[i] = (i * 31 + (i >> 11)) & 0xff;
  return data;
}

const digest = (data: Uint8Array): { size: number; sha256: string } => ({
  size: data.byteLength,
  sha256: createHash("sha256").update(data).digest("hex"),
});

describe("errnoOf", () => {
  it("maps file-system error codes to WASI errnos", () => {
    expect(errnoOf(fileSystemError("FileNotFound"))).toBe(wasi.ERRNO_NOENT);
    expect(errnoOf(fileSystemError("FileNotADirectory"))).toBe(wasi.ERRNO_NOTDIR);
    expect(errnoOf(fileSystemError("FileIsADirectory"))).toBe(wasi.ERRNO_ISDIR);
    expect(errnoOf(fileSystemError("NoPermissions"))).toBe(wasi.ERRNO_ACCES);
    expect(errnoOf(fileSystemError("Unavailable"))).toBe(wasi.ERRNO_IO);
    expect(errnoOf(fileSystemError("ENOENT"))).toBe(wasi.ERRNO_IO);
    expect(errnoOf(new Error("plain"))).toBe(wasi.ERRNO_IO);
    expect(errnoOf(undefined)).toBe(wasi.ERRNO_IO);
    expect(errnoOf("FileNotFound")).toBe(wasi.ERRNO_IO);
  });
});

describe.skipIf(skipWorkerTests())("bridge", () => {
  let shellcheck: TestShellCheck;

  beforeAll(() => {
    shellcheck = createTestShellCheck({
      createWorker: () => nodeWorkerPort(supportWorkerUrl("bridge-worker.mjs")),
    });
  });

  afterAll(async () => {
    await shellcheck.dispose();
  });

  /** Each request is "<op> <path>", answered by the bridge inside one lint. */
  async function ask(fs: ShellCheckFileSystem, ...requests: string[]): Promise<BridgeResult[]> {
    const result = await shellcheck.lint({ args: requests, fs });
    return JSON.parse(result.stdout) as BridgeResult[];
  }

  it("transfers files of any size, including across chunk boundaries", async () => {
    const sizes = [0, 1, CHUNK_BYTES - 1, CHUNK_BYTES, CHUNK_BYTES + 1, 2 * CHUNK_BYTES + 17];
    const files = Object.fromEntries(sizes.map((size) => [`/f${size}`, bytes(size)]));
    const fs = memoryFileSystem(files);
    const results = await ask(fs, ...sizes.map((size) => `readFile /f${size}`));
    expect(results).toEqual(sizes.map((size) => digest(files[`/f${size}`]!)));
  });

  it("round-trips stat and directory listings", async () => {
    const fs = memoryFileSystem({ "/dir/a.sh": "a", "/dir/sub/b.sh": "bb" });
    expect(await ask(fs, "stat /dir/sub/b.sh", "stat /dir", "readDirectory /dir")).toEqual([
      { value: { type: "file", size: 2, mtime: 0 } },
      { value: { type: "directory", size: 0, mtime: 0 } },
      {
        value: [
          ["a.sh", "file"],
          ["sub", "directory"],
        ],
      },
    ]);
  });

  it("normalizes stat numbers and rejects malformed answers with EIO", async () => {
    const fs: ShellCheckFileSystem = {
      stat: async (path) => {
        if (path === "/odd") return { type: "file", size: 12.9, mtime: 1_700_000_000_123.4 };
        return { type: "symlink" as never, size: 0, mtime: 0 };
      },
      readFile: async () => "text" as unknown as Uint8Array,
      readDirectory: async () => [[42 as unknown as string, "file"]],
    };
    expect(await ask(fs, "stat /odd", "stat /bad", "readFile /x", "readDirectory /")).toEqual([
      { value: { type: "file", size: 12, mtime: 1_700_000_000_123 } },
      { errno: wasi.ERRNO_IO },
      { errno: wasi.ERRNO_IO },
      { errno: wasi.ERRNO_IO },
    ]);
  });

  it("passes file-system errors through as errnos", async () => {
    const codes = ["FileNotFound", "FileNotADirectory", "FileIsADirectory", "NoPermissions"];
    const fs = memoryFileSystem(
      {},
      {
        readFile: async (path) => {
          const code = path.slice(1);
          if (code === "plain") throw new Error("boom");
          throw fileSystemError(code);
        },
      },
    );
    const results = await ask(
      fs,
      ...[...codes, "Unavailable", "plain"].map((c) => `readFile /${c}`),
    );
    expect(results).toEqual(
      [wasi.ERRNO_NOENT, wasi.ERRNO_NOTDIR, wasi.ERRNO_ISDIR, wasi.ERRNO_ACCES]
        .concat(wasi.ERRNO_IO, wasi.ERRNO_IO)
        .map((errno) => ({ errno })),
    );
  });

  it("asks the file system once per path and operation within a lint, not across lints", async () => {
    const fs = memoryFileSystem({ "/a.sh": "a" });
    const requests = ["stat /a.sh", "stat /missing", "readFile /a.sh", "readDirectory /"];
    await ask(fs, ...requests, ...requests);
    expect(fs.calls).toEqual(requests);
    await ask(fs, "stat /a.sh");
    expect(fs.calls).toEqual([...requests, "stat /a.sh"]);
  });
});
