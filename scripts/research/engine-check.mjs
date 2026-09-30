// Research: what this engine makes of each artifact variant. Probes tail calls and SIMD, tries
// to compile every variant, and lints a few scripts with each one that compiles, comparing
// stdout/exit code with native ShellCheck. Needs `npm run build` output in dist/ and
// `npm run fetch:native`. Runs on Node 18 as well (no tail calls there by default).
//
//   node scripts/research/engine-check.mjs tc=artifacts/tc/shellcheck.wasm notc=... > out.json
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { probe } from "./probes.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const nativePath =
  process.env.SHELLCHECK_NATIVE ?? path.join(repoRoot, ".cache", "native", "shellcheck");
const { createShellCheck } = await import(pathToFileURL(path.join(repoRoot, "dist", "index.js")));
const workerUrl = pathToFileURL(path.join(repoRoot, "test", "support", "node-worker.mjs"));

const long = ["#!/bin/bash"];
for (let i = 0; i < 500; i += 1) {
  long.push(
    [`echo $var${i}`, `var${i}="value ${i}"`, `[ $var${i} == "x" ] && echo ok`][i % 3],
  );
}
const cases = [
  { name: "plain-json1", args: ["-f", "json1", "-s", "bash", "-"], stdin: "#!/bin/bash\necho $FOO\n" },
  { name: "plain-tty", args: ["-s", "bash", "-"], stdin: "#!/bin/bash\necho $FOO\n" },
  { name: "long-gcc", args: ["-f", "gcc", "-s", "bash", "-"], stdin: `${long.join("\n")}\n` },
  { name: "parse-error", args: ["-f", "json1", "-"], stdin: "#!/bin/bash\nif then fi (\n" },
  { name: "version", args: ["--version"], stdin: "" },
];

function native({ args, stdin }) {
  const r = spawnSync(nativePath, args, { input: stdin, env: { LANG: "C.UTF-8" } });
  return { stdout: r.stdout.toString(), stderr: r.stderr.toString(), exitCode: r.status };
}

const report = {
  node: process.version,
  v8: process.versions.v8,
  platform: `${process.platform}-${process.arch}`,
  probes: probe(),
  variants: {},
};

for (const spec of process.argv.slice(2)) {
  const [name, file] = spec.split("=");
  const entry = { file, compiled: false };
  report.variants[name] = entry;
  const bytes = readFileSync(file);
  entry.validate = WebAssembly.validate(bytes);
  let module;
  const started = performance.now();
  try {
    module = await WebAssembly.compile(bytes);
    entry.compiled = true;
    entry.compileMs = Math.round(performance.now() - started);
  } catch (error) {
    entry.compileError = `${error.name}: ${error.message}`;
    continue;
  }
  const shellcheck = createShellCheck({
    module,
    createWorker() {
      const worker = new Worker(workerUrl);
      return {
        postMessage: (m) => worker.postMessage(m),
        onMessage: (l) => worker.on("message", l),
        onError: (l) => worker.on("error", l),
        onExit: (l) => worker.on("exit", l),
        terminate: () => worker.terminate(),
      };
    },
  });
  entry.cases = {};
  for (const c of cases) {
    const expected = native(c);
    try {
      const actual = await shellcheck.lint({ args: c.args, stdin: c.stdin });
      entry.cases[c.name] = {
        parity:
          actual.stdout === expected.stdout &&
          actual.stderr === expected.stderr &&
          actual.exitCode === expected.exitCode,
        exitCode: actual.exitCode,
      };
    } catch (error) {
      entry.cases[c.name] = { parity: false, error: String(error) };
    }
  }
  entry.allParity = Object.values(entry.cases).every((c) => c.parity);
  await shellcheck.dispose();
}

console.log(JSON.stringify(report, null, 2));
