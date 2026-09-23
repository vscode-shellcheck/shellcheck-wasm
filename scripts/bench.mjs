// Compares per-lint latency of this checkout against the published 0.1.1 runner and native
// ShellCheck. Not shipped. Needs `npm run build`, dist/shellcheck.wasm and `npm run fetch:native`.
//
//   node scripts/bench.mjs            # N=20 timed runs per size after WARM=3 warmups
//   N=5 SIZES=small node scripts/bench.mjs
//
// Every wasm variant runs in a worker_threads Worker driven from this thread, so all of them
// pay the same round trip. Exits 1 when the new runner is more than 10% slower than 0.1.1.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cacheDir = path.join(repoRoot, ".cache", "bench");
const nativePath =
  process.env.SHELLCHECK_NATIVE ?? path.join(repoRoot, ".cache", "native", "shellcheck");
const OLD_VERSION = "0.1.1";
const N = Number(process.env.N ?? 20);
const WARM = Number(process.env.WARM ?? 3);
const SIZES = (process.env.SIZES ?? "small,medium,large").split(",");
const GATE = 0.1;
const ARGS = ["-f", "json1", "-s", "bash", "-"];
const RTS_ARGS = ["+RTS", "-A64m", "-RTS", ...ARGS];
const PWD = "/src";

// Varied function blocks, each triggering several ShellCheck warnings; the same generator as
// the 2026-09 runtime spike, so the sizes come out at 28 / 308 / 1508 lines.
const blocks = [
  (i) => `
process_files_${i}() {
  local UNUSED_VAR_${i}="never read"
  target=$1
  echo Processing $target
  for f in $(ls /tmp/dir_${i}); do
    cp $f /backup/$target
  done
  echo "$UNDECLARED_${i}"
}
`,
  (i) => `
compute_sum_${i}() {
  declare TOTAL_${i}=0
  args="$*"
  cd /var/data_${i}
  result=\`expr $args + 1\`
  [ $result == "1" ] && echo yes
  echo $HOME/$args
  return $UNSET_RET_${i}
}
`,
  (i) => `
sync_remote_${i}() {
  HOST_${i}=example.com
  RSYNC_OPTS_${i}="-az --delete"
  rsync $RSYNC_OPTS_${i} ./src $HOST_${i}:/dst
  if [ $? -ne 0 ]; then
    echo "fail" > /dev/stderr
  fi
  echo "\${MISSING_${i}}"
}
`,
  (i) => `
parse_config_${i}() {
  local cfg=$1
  KEY_${i}=$(grep key $cfg | cut -d= -f2)
  DEAD_${i}="unused"
  while read line; do
    echo $line | grep -q $KEY_${i}
  done < $cfg
  eval "echo \\$OTHER_${i}"
  echo $NOPE_${i}
}
`,
  (i) => `
build_pkg_${i}() {
  VERSION_${i}=1.0.${i}
  ARCHIVE_${i}="pkg-\${VERSION_${i}}.tar"
  tar cf $ARCHIVE_${i} $SRC_DIR_${i}
  test -e $ARCHIVE_${i} || exit 1
  echo done
}
`,
];

function script(minLines) {
  const out = ["#!/bin/bash", "# generated bench fixture", "source ./lib.sh"];
  for (let i = 0; out.join("\n").split("\n").length < minLines; i += 1) {
    out.push(blocks[i % blocks.length](i).trim(), "");
  }
  return `${out.join("\n")}\n`;
}

const scripts = { small: script(18), medium: script(300), large: script(1500) };

function prepareMount() {
  const root = path.join(cacheDir, "mount");
  mkdirSync(path.join(root, "src"), { recursive: true });
  writeFileSync(path.join(root, ".shellcheckrc"), "external-sources=true\ndisable=SC2164\n");
  writeFileSync(
    path.join(root, "src", "lib.sh"),
    '#!/bin/bash\nLIB_HOME="/opt/lib"\nlib_log() { echo "$LIB_HOME: $*"; }\n',
  );
  return root;
}

function installOld() {
  const dir = path.join(cacheDir, `old-${OLD_VERSION}`);
  const entry = path.join(dir, "old-worker.mjs");
  mkdirSync(dir, { recursive: true });
  // Without a package.json of its own, the entry would resolve the package name to this
  // checkout through self-reference instead of to the installed 0.1.1.
  writeFileSync(path.join(dir, "package.json"), '{ "private": true, "type": "module" }\n');
  if (!existsSync(path.join(dir, "node_modules", "@vscode-shellcheck", "shellcheck-wasm"))) {
    execFileSync(
      "npm",
      [
        "install",
        "--no-save",
        "--no-package-lock",
        "--prefix",
        dir,
        `@vscode-shellcheck/shellcheck-wasm@${OLD_VERSION}`,
      ],
      { stdio: "inherit" },
    );
  }
  writeFileSync(
    entry,
    `import { parentPort } from "node:worker_threads";
import { createReadOnlyPreopen, loadModule, run } from "@vscode-shellcheck/shellcheck-wasm/node";

const module = await loadModule();
const decoder = new TextDecoder();
parentPort.on("message", ({ args, stdin, env, root }) => {
  const preopen = createReadOnlyPreopen(root);
  try {
    const result = run(module, { args, stdin, env, preopens: [preopen] });
    parentPort.postMessage({
      stdout: decoder.decode(result.stdout),
      stderr: decoder.decode(result.stderr),
      exitCode: result.exitCode,
    });
  } finally {
    preopen.dispose();
  }
});
parentPort.postMessage("ready");
`,
  );
  const wasm = path.join(
    dir,
    "node_modules",
    "@vscode-shellcheck",
    "shellcheck-wasm",
    "dist",
    "shellcheck.wasm",
  );
  return { entry, wasm };
}

/** The 0.1.1 runner in a Worker; one request in flight at a time. */
async function startOld(entry) {
  const worker = new Worker(entry);
  await new Promise((resolve, reject) => {
    worker.once("message", resolve);
    worker.once("error", reject);
  });
  return {
    lint: (request) =>
      new Promise((resolve, reject) => {
        worker.once("error", reject);
        worker.once("message", (result) => {
          worker.off("error", reject);
          resolve(result);
        });
        worker.postMessage(request);
      }),
    close: () => worker.terminate(),
  };
}

const CODES = {
  ENOENT: "FileNotFound",
  ENOTDIR: "FileNotADirectory",
  EISDIR: "FileIsADirectory",
  EACCES: "NoPermissions",
  EPERM: "NoPermissions",
};

/** A node:fs/promises file system over `root`, counting calls. */
function nodeFileSystem(root, counter) {
  const host = (guestPath) => path.join(root, guestPath);
  const translate = async (work) => {
    counter.calls += 1;
    try {
      return await work();
    } catch (error) {
      const code = CODES[error.code];
      throw code === undefined ? error : Object.assign(new Error(error.message), { code });
    }
  };
  return {
    stat: (guestPath) =>
      translate(async () => {
        const stats = await fs.stat(host(guestPath));
        const type = stats.isFile() ? "file" : stats.isDirectory() ? "directory" : "other";
        return { type, size: stats.size, mtime: stats.mtimeMs };
      }),
    readFile: (guestPath) => translate(() => fs.readFile(host(guestPath))),
    readDirectory: (guestPath) =>
      translate(async () =>
        (await fs.readdir(host(guestPath), { withFileTypes: true })).map((entry) => [
          entry.name,
          entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other",
        ]),
      ),
  };
}

async function startNew(module) {
  const { createShellCheck } = await import(pathToFileURL(path.join(repoRoot, "dist", "index.js")));
  const workerUrl = pathToFileURL(path.join(repoRoot, "test", "support", "node-worker.mjs"));
  const shellcheck = createShellCheck({
    module,
    createWorker() {
      const worker = new Worker(workerUrl);
      return {
        postMessage: (message) => worker.postMessage(message),
        onMessage: (listener) => worker.on("message", listener),
        onError: (listener) => worker.on("error", listener),
        onExit: (listener) => worker.on("exit", listener),
        terminate: () => worker.terminate(),
      };
    },
  });
  return shellcheck;
}

function runNative(stdin, root, home) {
  const result = spawnSync(nativePath, ARGS, {
    cwd: path.join(root, PWD),
    input: stdin,
    env: { PATH: process.env.PATH ?? "", HOME: home, LANG: "C.UTF-8" },
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return {
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    exitCode: result.status,
  };
}

const median = (values) => {
  const sorted = values.toSorted((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const ms = (value) => value.toFixed(1);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex").slice(0, 12);

async function main() {
  for (const required of [path.join(repoRoot, "dist", "index.js"), nativePath]) {
    if (!existsSync(required))
      throw new Error(`${required} is missing; see the header of this script`);
  }
  const root = prepareMount();
  const home = path.join(cacheDir, "home");
  mkdirSync(home, { recursive: true });
  const old = installOld();

  const newWasm = readFileSync(path.join(repoRoot, "dist", "shellcheck.wasm"));
  const oldWasm = readFileSync(old.wasm);
  console.log(
    `# node ${process.version}, N=${N}, warmup=${WARM}; artifact new ${sha(newWasm)} old ${sha(oldWasm)}`,
  );

  const oldRunner = await startOld(old.entry);
  const module = WebAssembly.compile(newWasm);
  const newRunner = await startNew(module);
  // Its own Worker: a 64 MiB nursery left behind in a shared one would slow (b) down.
  const rtsRunner = await startNew(module);
  const counter = { calls: 0 };
  const env = { PWD };

  const variants = {
    old: (stdin) => oldRunner.lint({ args: ARGS, stdin, env, root }),
    new: (stdin) => newRunner.lint({ args: ARGS, stdin, env, fs: nodeFileSystem(root, counter) }),
    rts: (stdin) =>
      rtsRunner.lint({ args: RTS_ARGS, stdin, env, fs: nodeFileSystem(root, counter) }),
    native: async (stdin) => runNative(stdin, root, home),
  };

  const rows = [];
  let failed = false;
  for (const size of SIZES) {
    const stdin = scripts[size];
    const lines = stdin.split("\n").length - 1;
    const reference = await variants.native(stdin);
    const notes = [];
    for (const [name, lint] of Object.entries(variants)) {
      const result = await lint(stdin);
      if (result.stdout !== reference.stdout || result.exitCode !== reference.exitCode) {
        notes.push(
          `${name} differs from native (exit ${result.exitCode}): ${result.stderr.slice(0, 200)}`,
        );
      }
    }
    counter.calls = 0;
    await variants.new(stdin);
    const bridgeCalls = counter.calls;

    const times = Object.fromEntries(Object.keys(variants).map((name) => [name, []]));
    // The gated pair is interleaved so drift in machine load hits both alike; (c) and (d)
    // get passes of their own so a 64 MiB nursery or a native process cannot perturb it.
    for (const group of [["old", "new"], ["rts"], ["native"]]) {
      for (let i = 0; i < WARM + N; i += 1) {
        for (const name of group) {
          const started = performance.now();
          await variants[name](stdin);
          if (i >= WARM) times[name].push(performance.now() - started);
        }
      }
    }
    const med = Object.fromEntries(
      Object.entries(times).map(([name, list]) => [name, median(list)]),
    );
    const delta = med.new / med.old - 1;
    if (delta > GATE) failed = true;
    rows.push({ size, lines, med, delta, bridgeCalls, notes });
    console.log(`  done ${size}`);
  }
  await oldRunner.close();
  await newRunner.dispose();
  await rtsRunner.dispose();

  console.log(
    "\n| script | lines | (a) 0.1.1 | (b) new | (b)/(a) | (c) new +RTS -A64m | (d) native | (b)/(d) | fs calls/lint |",
  );
  console.log("|---|---|---|---|---|---|---|---|---|");
  for (const { size, lines, med, delta, bridgeCalls } of rows) {
    const sign = delta >= 0 ? "+" : "";
    console.log(
      `| ${size} | ${lines} | ${ms(med.old)} | ${ms(med.new)} | ${sign}${(delta * 100).toFixed(1)}% | ${ms(med.rts)} | ${ms(med.native)} | ${(med.new / med.native).toFixed(2)}x | ${bridgeCalls} |`,
    );
  }
  for (const { size, notes } of rows)
    for (const note of notes) console.log(`note (${size}): ${note}`);
  console.log(
    `\nmedian ms per lint; gate: (b) at most ${GATE * 100}% slower than (a): ${failed ? "FAIL" : "pass"}`,
  );
  process.exitCode = failed ? 1 : 0;
}

await main();
