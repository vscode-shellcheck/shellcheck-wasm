import { afterEach, describe, expect, it } from "vitest";
import type { LintRequest, ShellCheckFileSystem } from "../src/index.js";
import {
  codesOf,
  createTestShellCheck,
  nodeWorkerPort,
  skipWorkerTests,
  supportWorkerUrl,
  type TestShellCheck,
} from "./helpers.js";
import { memoryFileSystem } from "./support/file-systems.js";

const JSON1_STDIN = ["-f", "json1", "-s", "bash", "-"];
const EMPTY_WASM_MODULE = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

/** Long enough that ShellCheck is still busy when a short timeout fires. */
function slowScript(): string {
  const lines = ["#!/bin/bash"];
  for (let i = 0; i < 400; i += 1) lines.push(i % 3 ? `echo $v${i}` : `v${i}="value ${i}"`);
  return `${lines.join("\n")}\n`;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** A mount whose root stat waits for `gate`, holding the lint inside the bridge. */
function gatedFileSystem(gate: Promise<void>, onStat?: () => void): ShellCheckFileSystem {
  const inner = memoryFileSystem({ "/lib.sh": "LIB=1\n" });
  return {
    ...inner,
    stat: async (path) => {
      onStat?.();
      await gate;
      return inner.stat(path);
    },
  };
}

const mountedLint = (fs: ShellCheckFileSystem): LintRequest => ({
  args: JSON1_STDIN,
  stdin: "echo $x\n",
  env: { PWD: "/" },
  fs,
});

describe.skipIf(skipWorkerTests())("createShellCheck scheduling", () => {
  const instances: TestShellCheck[] = [];
  const track = (instance: TestShellCheck): TestShellCheck => {
    instances.push(instance);
    return instance;
  };

  afterEach(async () => {
    await Promise.all(instances.splice(0).map((instance) => instance.dispose()));
  });

  it("starts no Worker before the first lint and then keeps one", async () => {
    const shellcheck = track(createTestShellCheck());
    expect(shellcheck.spawned).toBe(0);
    await shellcheck.lint({ args: ["--version"] });
    await shellcheck.lint({ args: ["--version"] });
    expect(shellcheck.spawned).toBe(1);
  });

  it("runs lints one at a time, first in first out", async () => {
    const shellcheck = track(createTestShellCheck());
    const log: string[] = [];
    const logged = (name: string): ShellCheckFileSystem => {
      const inner = memoryFileSystem({ "/a.sh": "A=1\n" });
      return {
        ...inner,
        stat: async (path) => {
          log.push(name);
          return inner.stat(path);
        },
      };
    };
    const names = ["first", "second", "third"];
    const results = await Promise.all(
      names.map((name) => shellcheck.lint(mountedLint(logged(name))).then(() => name)),
    );
    expect(results).toEqual(names);
    const firstIndexes = names.map((name) => log.indexOf(name));
    const lastIndexes = names.map((name) => log.lastIndexOf(name));
    expect(firstIndexes[1]).toBeGreaterThan(lastIndexes[0]!);
    expect(firstIndexes[2]).toBeGreaterThan(lastIndexes[1]!);
  });

  it("rejects an already aborted signal without starting a Worker", async () => {
    const shellcheck = track(createTestShellCheck());
    const reason = new Error("stale");
    await expect(
      shellcheck.lint({ args: ["--version"] }, { signal: AbortSignal.abort(reason) }),
    ).rejects.toBe(reason);
    expect(shellcheck.spawned).toBe(0);
  });

  it("drops a queued lint when its signal aborts", async () => {
    const shellcheck = track(createTestShellCheck());
    const gate = deferred();
    const running = shellcheck.lint(mountedLint(gatedFileSystem(gate.promise)));
    const queuedFs = memoryFileSystem({});
    const controller = new AbortController();
    const queued = shellcheck.lint(mountedLint(queuedFs), { signal: controller.signal });
    controller.abort();
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    gate.resolve();
    expect((await running).exitCode).toBe(1);
    expect(queuedFs.calls).toEqual([]);
    expect(shellcheck.spawned).toBe(1);
  });

  it("terminates the Worker when the running lint aborts inside a file-system call", async () => {
    const shellcheck = track(createTestShellCheck());
    const controller = new AbortController();
    const never = new Promise<void>(() => {});
    const blocked = shellcheck.lint(mountedLint(gatedFileSystem(never, () => controller.abort())), {
      signal: controller.signal,
    });
    await expect(blocked).rejects.toMatchObject({ name: "AbortError" });
    const next = await shellcheck.lint({ args: JSON1_STDIN, stdin: "echo $x\n" });
    expect(codesOf(next.stdout)).toContain(2086);
    expect(shellcheck.spawned).toBe(2);
  });

  it("terminates the Worker when the running lint times out mid-computation", async () => {
    const shellcheck = track(createTestShellCheck());
    await shellcheck.lint({ args: ["--version"] });
    const started = performance.now();
    await expect(
      shellcheck.lint(
        { args: JSON1_STDIN, stdin: slowScript() },
        { signal: AbortSignal.timeout(300) },
      ),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    expect(performance.now() - started).toBeLessThan(2_000);
    const next = await shellcheck.lint({ args: JSON1_STDIN, stdin: "echo $x\n" });
    expect(next.exitCode).toBe(1);
    expect(shellcheck.spawned).toBe(2);
  });

  it("rejects the running lint when the Worker exits, then starts a new one", async () => {
    const shellcheck = track(
      createTestShellCheck({
        createWorker: () => nodeWorkerPort(supportWorkerUrl("crash-worker.mjs")),
      }),
    );
    await expect(shellcheck.lint({ args: ["--test-exit"] })).rejects.toThrow(
      "ShellCheck worker exited unexpectedly with code 7",
    );
    expect((await shellcheck.lint({ args: ["--version"] })).exitCode).toBe(0);
    expect(shellcheck.spawned).toBe(2);
  });

  it("rejects the running lint when the Worker throws, then starts a new one", async () => {
    const shellcheck = track(
      createTestShellCheck({
        createWorker: () => nodeWorkerPort(supportWorkerUrl("crash-worker.mjs")),
      }),
    );
    await expect(shellcheck.lint({ args: ["--test-throw"] })).rejects.toThrow(
      "ShellCheck worker failed: injected worker failure",
    );
    expect((await shellcheck.lint({ args: ["--version"] })).exitCode).toBe(0);
    expect(shellcheck.spawned).toBe(2);
  });

  it("rejects a lint the guest cannot run without losing the Worker", async () => {
    const shellcheck = track(
      createTestShellCheck({ module: WebAssembly.compile(EMPTY_WASM_MODULE) }),
    );
    for (let i = 0; i < 2; i += 1) {
      await expect(shellcheck.lint({ args: [] })).rejects.toThrow(
        /^ShellCheck failed: TypeError: shellcheck.wasm is not a WASI command module/,
      );
    }
    expect(shellcheck.spawned).toBe(1);
  });

  it("rejects when the module cannot be loaded", async () => {
    const failure = new Error("no wasm here");
    const module = Promise.reject(failure);
    module.catch(() => {});
    const shellcheck = track(createTestShellCheck({ module }));
    await expect(shellcheck.lint({ args: [] })).rejects.toBe(failure);
    expect(shellcheck.spawned).toBe(0);
  });

  it("rejects pending and later lints once disposed", async () => {
    const shellcheck = createTestShellCheck();
    const never = new Promise<void>(() => {});
    const running = shellcheck.lint(mountedLint(gatedFileSystem(never)));
    const queued = shellcheck.lint({ args: ["--version"] });
    await shellcheck.dispose();
    await expect(running).rejects.toThrow("disposed");
    await expect(queued).rejects.toThrow("disposed");
    await expect(shellcheck.lint({ args: ["--version"] })).rejects.toThrow("disposed");
  });
});
