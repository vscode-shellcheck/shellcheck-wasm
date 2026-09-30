// Research: per-lint latency of several artifact variants against each other and native
// ShellCheck, through the same runner (dist/) and the same Worker entry. Variant runs are
// interleaved round by round so machine-load drift hits all of them alike. Compile time is
// measured in fresh child processes, since V8 may reuse a module compiled earlier in-process.
//
//   N=30 WARM=5 node scripts/research/bench-variants.mjs tc=a/tc.wasm notc=a/notc.wasm
//
// Prints a markdown table and writes the raw numbers to BENCH_JSON (default bench-variants.json).
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { probe } from "./probes.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const nativePath =
  process.env.SHELLCHECK_NATIVE ?? path.join(repoRoot, ".cache", "native", "shellcheck");
const N = Number(process.env.N ?? 20);
const WARM = Number(process.env.WARM ?? 3);
const COMPILE_RUNS = Number(process.env.COMPILE_RUNS ?? 5);
const SIZES = (process.env.SIZES ?? "small,medium,large").split(",");
const ARGS = ["-f", "json1", "-s", "bash", "-"];
const PWD = "/src";

// Same generator as scripts/bench.mjs: 28 / 308 / 1508 lines.
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
  const root = path.join(repoRoot, ".cache", "bench-variants", "mount");
  mkdirSync(path.join(root, "src"), { recursive: true });
  writeFileSync(path.join(root, ".shellcheckrc"), "external-sources=true\ndisable=SC2164\n");
  writeFileSync(
    path.join(root, "src", "lib.sh"),
    '#!/bin/bash\nLIB_HOME="/opt/lib"\nlib_log() { echo "$LIB_HOME: $*"; }\n',
  );
  return root;
}

function nodeFileSystem(root) {
  const host = (p) => path.join(root, p);
  const wrap = async (work) => {
    try {
      return await work();
    } catch (error) {
      const code = { ENOENT: "FileNotFound", ENOTDIR: "FileNotADirectory" }[error.code];
      throw code === undefined ? error : Object.assign(new Error(error.message), { code });
    }
  };
  return {
    stat: (p) =>
      wrap(async () => {
        const s = await fs.stat(host(p));
        return {
          type: s.isFile() ? "file" : s.isDirectory() ? "directory" : "other",
          size: s.size,
          mtime: s.mtimeMs,
        };
      }),
    readFile: (p) => wrap(() => fs.readFile(host(p))),
    readDirectory: (p) =>
      wrap(async () =>
        (await fs.readdir(host(p), { withFileTypes: true })).map((e) => [
          e.name,
          e.isDirectory() ? "directory" : e.isFile() ? "file" : "other",
        ]),
      ),
  };
}

function compileMs(file) {
  // A pending async compile does not keep Node's event loop alive, and anything else the child
  // prints (version-manager shims, warnings) must not end up in the number.
  const code = `const k=setInterval(()=>{},1000);const b=require("fs").readFileSync(${JSON.stringify(file)});const t=performance.now();WebAssembly.compile(b).then(()=>{console.log("COMPILE_MS="+(performance.now()-t));clearInterval(k)})`;
  const times = [];
  for (let i = 0; i < COMPILE_RUNS; i += 1) {
    const r = spawnSync(process.execPath, ["-e", code], { encoding: "utf8" });
    const match = /COMPILE_MS=([\d.]+)/.exec(r.stdout ?? "");
    if (r.status !== 0 || match === null) {
      return { error: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim().split("\n").pop() };
    }
    times.push(Number(match[1]));
  }
  return { median: median(times) };
}

const median = (values) => {
  const s = values.toSorted((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

async function main() {
  const { createShellCheck } = await import(pathToFileURL(path.join(repoRoot, "dist", "index.js")));
  const workerUrl = pathToFileURL(path.join(repoRoot, "test", "support", "node-worker.mjs"));
  const root = prepareMount();
  const home = path.join(repoRoot, ".cache", "bench-variants", "home");
  mkdirSync(home, { recursive: true });

  const variants = process.argv.slice(2).map((spec) => {
    const [name, file] = spec.split("=");
    return { name, file: path.resolve(file) };
  });
  const env = { PWD };
  const runners = {};
  const compile = {};
  for (const v of variants) {
    compile[v.name] = compileMs(v.file);
    const module = WebAssembly.compile(readFileSync(v.file));
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
    runners[v.name] = {
      lint: (stdin) => shellcheck.lint({ args: ARGS, stdin, env, fs: nodeFileSystem(root) }),
      dispose: () => shellcheck.dispose(),
    };
  }
  runners.native = {
    lint: async (stdin) => {
      const r = spawnSync(nativePath, ARGS, {
        cwd: path.join(root, PWD),
        input: stdin,
        env: { PATH: process.env.PATH ?? "", HOME: home, LANG: "C.UTF-8" },
        maxBuffer: 64 * 1024 * 1024,
      });
      return { stdout: r.stdout.toString(), stderr: r.stderr.toString(), exitCode: r.status };
    },
    dispose: async () => {},
  };

  const meta = {
    node: process.version,
    v8: process.versions.v8,
    platform: `${process.platform}-${process.arch}`,
    cpu: os.cpus()[0]?.model,
    N,
    WARM,
    probes: probe(),
  };
  console.log(`# ${JSON.stringify(meta)}`);
  const rows = [];
  const names = [...variants.map((v) => v.name), "native"];
  for (const size of SIZES) {
    const stdin = scripts[size];
    const reference = await runners.native.lint(stdin);
    const notes = [];
    for (const name of names) {
      const r = await runners[name].lint(stdin);
      if (r.stdout !== reference.stdout || r.exitCode !== reference.exitCode) {
        notes.push(`${name} differs from native: ${r.stderr.slice(0, 200)}`);
      }
    }
    const times = Object.fromEntries(names.map((n) => [n, []]));
    for (let i = 0; i < WARM + N; i += 1) {
      // Rotate the order each round so no variant always runs right after native.
      const order = names.map((_, k) => names[(k + i) % names.length]);
      for (const name of order) {
        const started = performance.now();
        await runners[name].lint(stdin);
        if (i >= WARM) times[name].push(performance.now() - started);
      }
    }
    rows.push({
      size,
      lines: stdin.split("\n").length - 1,
      median: Object.fromEntries(names.map((n) => [n, median(times[n])])),
      times,
      notes,
    });
    console.error(`done ${size}`);
  }
  for (const r of Object.values(runners)) await r.dispose();

  const base = variants[0].name;
  console.log(
    `\n| script | lines | ${names.map((n) => `${n} ms`).join(" | ")} | ${variants
      .slice(1)
      .map((v) => `${v.name}/${base}`)
      .join(" | ")} | ${variants.map((v) => `${v.name}/native`).join(" | ")} |`,
  );
  console.log(`|${"---|".repeat(2 + names.length + variants.length - 1 + variants.length)}`);
  for (const { size, lines, median: m } of rows) {
    const cells = [
      size,
      lines,
      ...names.map((n) => m[n].toFixed(1)),
      ...variants.slice(1).map((v) => `${((m[v.name] / m[base] - 1) * 100).toFixed(1)}%`),
      ...variants.map((v) => `${(m[v.name] / m.native).toFixed(2)}x`),
    ];
    console.log(`| ${cells.join(" | ")} |`);
  }
  console.log(
    `\ncompile (child process, median of ${COMPILE_RUNS}): ${variants
      .map((v) => `${v.name} ${compile[v.name].median?.toFixed(0) ?? compile[v.name].error} ms`)
      .join(", ")}`,
  );
  for (const { size, notes } of rows) for (const n of notes) console.log(`note (${size}): ${n}`);
  writeFileSync(
    process.env.BENCH_JSON ?? "bench-variants.json",
    JSON.stringify({ meta, compile, rows }, null, 2),
  );
}

await main();
