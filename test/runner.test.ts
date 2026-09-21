import { beforeAll, describe, expect, it } from "vitest";
import { run, SHELLCHECK_VERSION } from "../src/index.js";
import { codesOf, hasWasm, loadTestModule, skipHint, text, wasmHint } from "./helpers.js";

describe.skipIf(skipHint(!hasWasm, wasmHint))("run", () => {
  let module: WebAssembly.Module;

  beforeAll(async () => {
    module = await loadTestModule();
  });

  it("reports the version recorded in version.txt", () => {
    const result = run(module, { args: ["--version"] });
    expect(result.exitCode).toBe(0);
    expect(text(result.stdout)).toContain(`version: ${SHELLCHECK_VERSION.slice(1)}`);
    expect(result.stderr).toHaveLength(0);
  });

  it("reports SC2086 as json1 with exit code 1", () => {
    const result = run(module, { args: ["-f", "json1", "-s", "bash", "-"], stdin: "echo $x\n" });
    expect(result.exitCode).toBe(1);
    expect(codesOf(result.stdout)).toContain(2086);
    expect(result.stderr).toHaveLength(0);
  });

  it("exits 0 with an empty comment list for a clean script", () => {
    const result = run(module, { args: ["-f", "json1", "-s", "bash", "-"], stdin: 'echo "$1"\n' });
    expect(result.exitCode).toBe(0);
    expect(text(result.stdout)).toBe('{"comments":[]}\n');
  });

  it("rejects an unknown flag on stderr with exit code >= 2", () => {
    const result = run(module, { args: ["--no-such-flag"] });
    expect(result.exitCode).toBeGreaterThanOrEqual(2);
    expect(text(result.stderr)).toContain("no-such-flag");
  });

  it("treats string and Uint8Array stdin alike", () => {
    const script = "echo $x\n";
    const asString = run(module, { args: ["-f", "json1", "-s", "bash", "-"], stdin: script });
    const asBytes = run(module, {
      args: ["-f", "json1", "-s", "bash", "-"],
      stdin: new TextEncoder().encode(script),
    });
    expect(asBytes).toEqual(asString);
  });

  it("defaults stdin to empty", () => {
    const result = run(module, { args: ["-f", "json1", "-s", "bash", "-"] });
    expect(result.exitCode).toBe(0);
    expect(text(result.stdout)).toBe('{"comments":[]}\n');
  });

  it("runs the same Module repeatedly with a fresh Instance each time", () => {
    const first = run(module, { args: ["-f", "json1", "-s", "bash", "-"], stdin: "echo $a\n" });
    const second = run(module, { args: ["-f", "json1", "-s", "bash", "-"], stdin: "echo $b\n" });
    expect(first.exitCode).toBe(1);
    expect(second.exitCode).toBe(1);
    expect(text(first.stdout)).toContain("a is referenced");
    expect(text(second.stdout)).toContain("b is referenced");
  });

  it("passes the environment through", () => {
    // SHELLCHECK_OPTS is read by ShellCheck itself, so its effect proves env reaches the guest.
    const result = run(module, {
      args: ["-f", "json1", "-s", "bash", "-"],
      stdin: "echo $x\n",
      env: { SHELLCHECK_OPTS: "-e SC2086 -e SC2154" },
    });
    expect(result.exitCode).toBe(0);
    expect(text(result.stdout)).toBe('{"comments":[]}\n');
  });

  it("fails fast, without hanging, when PWD is outside every preopen", () => {
    // The GHC RTS chdir()s to PWD before main runs; with no preopen to satisfy it the
    // program aborts before ShellCheck can write anything to stdout.
    const result = run(module, {
      args: ["-f", "json1", "-s", "bash", "-"],
      stdin: "echo $x\n",
      env: { PWD: "/nowhere" },
    });
    expect(result.stdout).toHaveLength(0);
    expect(result.exitCode).not.toBe(0);
    expect(text(result.stderr)).toContain("chdir");
  });
});
