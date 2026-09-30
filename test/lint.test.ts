import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SHELLCHECK_VERSION } from "../src/index.js";
import { codesOf, createTestShellCheck, skipWorkerTests, type TestShellCheck } from "./helpers.js";

const JSON1_STDIN = ["-f", "json1", "-s", "bash", "-"];

describe.skipIf(skipWorkerTests())("lint without a file system", () => {
  let shellcheck: TestShellCheck;

  beforeAll(() => {
    shellcheck = createTestShellCheck();
  });

  afterAll(async () => {
    await shellcheck.dispose();
  });

  const lint: TestShellCheck["lint"] = (request, options) => shellcheck.lint(request, options);

  it("reports the version recorded in version.txt", async () => {
    const result = await lint({ args: ["--version"] });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`version: ${SHELLCHECK_VERSION.slice(1)}`);
    expect(result.stderr).toBe("");
  });

  it("reports SC2086 as json1 with exit code 1", async () => {
    const result = await lint({ args: JSON1_STDIN, stdin: "echo $x\n" });
    expect(result.exitCode).toBe(1);
    expect(codesOf(result.stdout)).toContain(2086);
    expect(result.stderr).toBe("");
  });

  it("exits 0 with an empty comment list for a clean script", async () => {
    const result = await lint({ args: JSON1_STDIN, stdin: 'echo "$1"\n' });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('{"comments":[]}\n');
  });

  it("rejects an unknown flag on stderr with exit code >= 2", async () => {
    const result = await lint({ args: ["--no-such-flag"] });
    expect(result.exitCode).toBeGreaterThanOrEqual(2);
    expect(result.stderr).toContain("no-such-flag");
  });

  it("treats string and Uint8Array stdin alike", async () => {
    const script = "echo $x\n";
    const asString = await lint({ args: JSON1_STDIN, stdin: script });
    const asBytes = await lint({ args: JSON1_STDIN, stdin: new TextEncoder().encode(script) });
    expect(asBytes).toEqual(asString);
  });

  it("defaults stdin to empty", async () => {
    const result = await lint({ args: JSON1_STDIN });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('{"comments":[]}\n');
  });

  it("runs lints back to back on fresh Instances in one Worker", async () => {
    const [first, second] = await Promise.all([
      lint({ args: JSON1_STDIN, stdin: "echo $a\n" }),
      lint({ args: JSON1_STDIN, stdin: "echo $b\n" }),
    ]);
    expect(first.stdout).toContain("a is referenced");
    expect(second.stdout).toContain("b is referenced");
    expect(shellcheck.spawned).toBe(1);
  });

  it("passes the environment through", async () => {
    // SHELLCHECK_OPTS is read by ShellCheck itself, so its effect proves env reaches the guest.
    const result = await lint({
      args: JSON1_STDIN,
      stdin: "echo $x\n",
      env: { SHELLCHECK_OPTS: "-e SC2086 -e SC2154" },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('{"comments":[]}\n');
  });

  it("cannot follow a source directive: nothing is mounted", async () => {
    const result = await lint({
      args: ["-x", ...JSON1_STDIN],
      stdin: 'source ./lib.sh\necho "$LIB_HOME"\n',
    });
    expect(codesOf(result.stdout)).toContain(1091);
  });

  it("fails fast, without hanging, when PWD is set and nothing is mounted", async () => {
    // The GHC RTS chdir()s to PWD before main runs; with no preopen to satisfy it the
    // program aborts before ShellCheck can write anything to stdout.
    const result = await lint({ args: JSON1_STDIN, stdin: "echo $x\n", env: { PWD: "/nowhere" } });
    expect(result.stdout).toBe("");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("chdir");
  });
});
