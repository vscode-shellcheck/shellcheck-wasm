import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createReadOnlyPreopen, run, type RunResult } from "../src/node.js";
import {
  fixtureRoot,
  hasNative,
  hasWasm,
  loadTestModule,
  nativeHint,
  nativePath,
  skipHint,
  text,
  wasmHint,
} from "./helpers.js";

interface Scenario {
  readonly name: string;
  readonly args: readonly string[];
  readonly stdin?: string;
  /** Host directory exposed to the guest as `/`; native runs with cwd inside it. */
  readonly hostDir?: string;
  /** Guest working directory (`PWD`), relative to `hostDir`. */
  readonly pwd?: string;
  /** Text native ShellCheck must produce, so two empty outputs cannot pass as parity. */
  readonly expectStdout?: string;
  readonly expectStderr?: string;
  /** Text native ShellCheck must not produce, e.g. a finding an rc file is meant to silence. */
  readonly rejectStdout?: string;
}

const rcRoot = path.join(fixtureRoot, "rc");
const srcRoot = path.join(fixtureRoot, "src");
const fixture = (...parts: string[]): string =>
  fs.readFileSync(path.join(fixtureRoot, ...parts), "utf8");

function longScript(): string {
  const lines = ["#!/bin/bash"];
  for (let i = 0; i < 500; i += 1) {
    switch (i % 3) {
      case 0:
        lines.push(`echo $var${i}`);
        break;
      case 1:
        lines.push(`var${i}="value ${i}"`);
        break;
      default:
        lines.push(`[ $var${i} == "x" ] && echo ok`);
    }
  }
  return `${lines.join("\n")}\n`;
}

const scenarios: readonly Scenario[] = [
  {
    name: "plain stdin script as json1",
    args: ["-f", "json1", "-s", "bash", "-"],
    stdin: fixture("plain", "plain.sh"),
    expectStdout: '"code":2086',
  },
  {
    name: "plain stdin script as gcc",
    args: ["-f", "gcc", "-s", "bash", "-"],
    stdin: fixture("plain", "plain.sh"),
    expectStdout: "[SC2086]",
  },
  {
    name: "plain stdin script as checkstyle",
    args: ["-f", "checkstyle", "-s", "bash", "-"],
    stdin: fixture("plain", "plain.sh"),
    expectStdout: "source='ShellCheck.SC2086'",
  },
  {
    name: "plain stdin script as json",
    args: ["-f", "json", "-s", "bash", "-"],
    stdin: fixture("plain", "plain.sh"),
    expectStdout: '"code":2086',
  },
  {
    name: "plain stdin script in the default tty format",
    args: ["-s", "bash", "-"],
    stdin: fixture("plain", "plain.sh"),
    expectStdout: "SC2086 (info)",
  },
  {
    name: "non-ASCII source text in the gcc format",
    args: ["-f", "gcc", "-s", "bash", "-"],
    stdin: 'echo "héllo wörld ✓" $x\n',
    expectStdout: "[SC2086]",
  },
  {
    name: "a clean script",
    args: ["-f", "json1", "-s", "bash", "-"],
    stdin: '#!/bin/bash\necho "$1"\n',
    expectStdout: '{"comments":[]}',
  },
  {
    name: "empty stdin",
    args: ["-f", "json1", "-s", "bash", "-"],
    stdin: "",
    expectStdout: '{"comments":[]}',
  },
  {
    name: "a syntax error",
    args: ["-f", "json1", "-s", "bash", "-"],
    stdin: "if then\n",
    expectStdout: '"code":1',
  },
  {
    name: "a syntax error in the default format",
    args: ["-s", "bash", "-"],
    stdin: 'for x in $(ls); do\n  echo "$x"\n',
    expectStdout: "SC1",
  },
  {
    name: "optional checks enabled",
    args: ["-o", "all", "-f", "json1", "-s", "bash", "-"],
    stdin: 'x=1\necho "$x"\n',
    expectStdout: '"code":2250',
  },
  {
    name: "severity filter",
    args: ["-S", "warning", "-f", "json1", "-s", "bash", "-"],
    stdin: fixture("plain", "plain.sh"),
    expectStdout: '{"comments":[]}',
  },
  {
    name: "POSIX sh dialect",
    args: ["-f", "gcc", "-s", "sh", "-"],
    stdin: "#!/bin/sh\nfunction f { echo hi; }\n[[ $1 ]]\n",
    expectStdout: "[SC3",
  },
  {
    name: ".shellcheckrc discovery walks up from the working directory",
    args: ["-f", "json1", "-s", "bash", "-"],
    stdin: fixture("rc", "child", "nested", "deep.sh"),
    hostDir: rcRoot,
    pwd: "child/nested",
    expectStdout: '"code":2034',
    rejectStdout: '"code":2086',
  },
  {
    name: ".shellcheckrc discovery stops at the nearest file",
    args: ["-f", "json1", "-s", "bash", "-"],
    stdin: fixture("rc", "nearest", "shadowed.sh"),
    hostDir: rcRoot,
    pwd: "nearest",
    expectStdout: '"code":2086',
    rejectStdout: '"code":2034',
  },
  {
    name: "-x follows source relative to the working directory",
    args: ["-x", "-f", "json1", "-s", "bash", "-"],
    stdin: fixture("src", "main.sh"),
    hostDir: srcRoot,
    pwd: "",
    expectStdout: '"code":2154',
    rejectStdout: '"code":1091',
  },
  {
    name: "-x follows source next to a script given by path",
    args: ["-x", "-f", "gcc", "main.sh"],
    hostDir: srcRoot,
    pwd: "",
    expectStdout: "main.sh:3:12",
    rejectStdout: "[SC1091]",
  },
  {
    name: "without -x the source is reported as not followed",
    args: ["-f", "gcc", "-s", "bash", "-"],
    stdin: fixture("src", "main.sh"),
    hostDir: srcRoot,
    pwd: "",
    expectStdout: "[SC1091]",
  },
  {
    name: "-x on a missing source reports the host errno text",
    args: ["-x", "-f", "json1", "-s", "bash", "-"],
    stdin: 'source ./missing.sh\necho "$FROM_MISSING"\n',
    hostDir: srcRoot,
    pwd: "",
    expectStdout: "does not exist",
  },
  {
    name: "-x on a directory reports the host error text",
    args: ["-x", "-f", "json1", "-s", "bash", "-"],
    stdin: 'source ./child\necho "$X"\n',
    hostDir: rcRoot,
    pwd: "",
    expectStdout: '"code":1091',
  },
  {
    name: "a script file given by path in the default format",
    args: ["child/nested/deep.sh"],
    hostDir: rcRoot,
    pwd: "",
    expectStdout: "In child/nested/deep.sh line 2",
  },
  {
    name: "an unknown flag",
    args: ["--no-such-flag"],
    expectStderr: "no-such-flag",
  },
  {
    name: "no arguments at all",
    args: [],
    expectStderr: "No files specified",
  },
  {
    name: "--help",
    args: ["--help"],
    expectStdout: "Usage:",
  },
  {
    name: "--version",
    args: ["--version"],
    expectStdout: "version: 0.11.0",
  },
  {
    name: "--list-optional",
    args: ["--list-optional"],
    expectStdout: "name:",
  },
  {
    name: "a 500-line script as json1",
    args: ["-f", "json1", "-s", "bash", "-"],
    stdin: longScript(),
    expectStdout: '"line":500,',
  },
  {
    name: "a 500-line script as gcc",
    args: ["-f", "gcc", "-s", "bash", "-"],
    stdin: longScript(),
    expectStdout: "-:499:",
  },
  {
    name: "a 500-line script in the default format",
    args: ["-s", "bash", "-"],
    stdin: longScript(),
    expectStdout: "In - line 499",
  },
];

describe.skipIf(skipHint(!hasWasm, wasmHint) || skipHint(!hasNative, nativeHint))("parity", () => {
  let module: WebAssembly.Module;
  let sandbox: string;
  let emptyCwd: string;
  let emptyHome: string;

  beforeAll(async () => {
    module = await loadTestModule();
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "shellcheck-wasm-parity-"));
    emptyCwd = path.join(sandbox, "cwd");
    emptyHome = path.join(sandbox, "home");
    fs.mkdirSync(emptyCwd);
    fs.mkdirSync(emptyHome);
  });

  afterAll(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  function runNative(scenario: Scenario): RunResult {
    const result = spawnSync(nativePath, [...scenario.args], {
      cwd:
        scenario.hostDir === undefined ? emptyCwd : path.join(scenario.hostDir, scenario.pwd ?? ""),
      input: scenario.stdin ?? "",
      // Native ShellCheck also looks in $HOME and $XDG_CONFIG_HOME for an rc file; an empty
      // HOME keeps the machine's own config out. The guest has no locale, so GHC there
      // encodes as UTF-8; C.UTF-8 makes the native side agree.
      env: { PATH: process.env["PATH"] ?? "", HOME: emptyHome, LANG: "C.UTF-8" },
      maxBuffer: 64 * 1024 * 1024,
    });
    if (result.error) throw result.error;
    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.status ?? -1 };
  }

  function runWasm(scenario: Scenario): RunResult {
    if (scenario.hostDir === undefined) {
      return run(module, { args: scenario.args, stdin: scenario.stdin ?? "" });
    }
    const preopen = createReadOnlyPreopen(scenario.hostDir);
    try {
      return run(module, {
        args: scenario.args,
        stdin: scenario.stdin ?? "",
        env: { PWD: path.posix.join("/", scenario.pwd ?? "") },
        preopens: [preopen],
      });
    } finally {
      preopen.dispose();
    }
  }

  for (const scenario of scenarios) {
    it(scenario.name, () => {
      const native = runNative(scenario);
      const wasm = runWasm(scenario);

      if (scenario.expectStdout !== undefined)
        expect(text(native.stdout)).toContain(scenario.expectStdout);
      if (scenario.expectStderr !== undefined)
        expect(text(native.stderr)).toContain(scenario.expectStderr);
      if (scenario.rejectStdout !== undefined)
        expect(text(native.stdout)).not.toContain(scenario.rejectStdout);

      expect(text(wasm.stderr)).toBe(text(native.stderr));
      expect(text(wasm.stdout)).toBe(text(native.stdout));
      expect(Buffer.compare(wasm.stdout, native.stdout)).toBe(0);
      expect(Buffer.compare(wasm.stderr, native.stderr)).toBe(0);
      expect(wasm.exitCode).toBe(native.exitCode);
    });
  }
});
