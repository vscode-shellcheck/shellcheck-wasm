// Research: run each artifact variant in real browsers through `./client` and
// `dist/browser/worker.js`, as a web Host would. Serves the checkout with COOP/COEP so the page
// is cross-origin isolated, then per browser: probes tail calls/SIMD, compiles every variant
// with compileStreaming, lints a few scripts on stdin, compares with native ShellCheck and
// times repeated lints of a medium script.
//
// Needs `npm run build`, `npm run fetch:native` and `npm install --no-save playwright` plus
// `npx playwright install chromium firefox webkit`.
//
//   BROWSERS=chromium,firefox,webkit ROUNDS=15 \
//     node scripts/research/browser-check.mjs tc=artifacts/tc/shellcheck.wasm notc=... > out.json
import { spawnSync } from "node:child_process";
import { createReadStream, existsSync, statSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SIMD_PROBE, TAIL_CALL_PROBE } from "./probes.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const nativePath =
  process.env.SHELLCHECK_NATIVE ?? path.join(repoRoot, ".cache", "native", "shellcheck");
const BROWSERS = (process.env.BROWSERS ?? "chromium,firefox,webkit").split(",");
const ROUNDS = Number(process.env.ROUNDS ?? 15);
const WARM = Number(process.env.WARM ?? 3);

const variants = process.argv.slice(2).map((spec) => {
  const [name, file] = spec.split("=");
  return { name, file: path.resolve(file) };
});

function medium() {
  const out = ["#!/bin/bash"];
  for (let i = 0; i < 100; i += 1) {
    out.push(
      `f_${i}() {`,
      `  local UNUSED_${i}="x"`,
      `  for f in $(ls /tmp/d_${i}); do cp $f /b/$1; done`,
      `  [ $r_${i} == "1" ] && echo $HOME/$args`,
      `}`,
    );
  }
  return `${out.join("\n")}\n`;
}
const cases = [
  { name: "plain-json1", args: ["-f", "json1", "-s", "bash", "-"], stdin: "#!/bin/bash\necho $FOO\n" },
  { name: "plain-tty", args: ["-s", "bash", "-"], stdin: "#!/bin/bash\necho $FOO\n" },
  { name: "medium-gcc", args: ["-f", "gcc", "-s", "bash", "-"], stdin: medium() },
  { name: "parse-error", args: ["-f", "json1", "-"], stdin: "#!/bin/bash\nif then fi (\n" },
];
const expected = Object.fromEntries(
  cases.map((c) => {
    const r = spawnSync(nativePath, c.args, { input: c.stdin, env: { LANG: "C.UTF-8" } });
    return [c.name, { stdout: r.stdout.toString(), stderr: r.stderr.toString(), exitCode: r.status }];
  }),
);

const PAGE = `<!doctype html><meta charset="utf-8"><title>shellcheck-wasm research</title>
<script type="module">
import { createShellCheck } from "/dist/client-entry.js";
const median = (v) => { const s = [...v].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
window.runCheck = async ({ variants, cases, probes, rounds, warm }) => {
  const validate = (b) => { try { return WebAssembly.validate(new Uint8Array(b)); } catch { return false; } };
  const out = {
    userAgent: navigator.userAgent,
    crossOriginIsolated: globalThis.crossOriginIsolated === true,
    probes: { tailCall: validate(probes.tailCall), simd: validate(probes.simd) },
    variants: {},
  };
  for (const v of variants) {
    const entry = (out.variants[v.name] = { compiled: false });
    let module;
    const t0 = performance.now();
    try {
      module = await WebAssembly.compileStreaming(fetch(v.url));
      entry.compiled = true;
      entry.compileMs = Math.round(performance.now() - t0);
    } catch (e) {
      entry.compileError = String(e && e.message ? e.name + ": " + e.message : e);
      continue;
    }
    const shellcheck = createShellCheck({
      module,
      createWorker() {
        const w = new Worker("/dist/browser/worker.js");
        return {
          postMessage: (m) => w.postMessage(m),
          onMessage: (l) => w.addEventListener("message", (e) => l(e.data)),
          onError: (l) => w.addEventListener("error", (e) => l(e.message || e)),
          terminate: () => w.terminate(),
        };
      },
    });
    entry.results = {};
    try {
      const t1 = performance.now();
      for (const c of cases) entry.results[c.name] = await shellcheck.lint({ args: c.args, stdin: c.stdin });
      entry.firstPassMs = Math.round(performance.now() - t1);
      const bench = cases.find((c) => c.name === "medium-gcc");
      const times = [];
      for (let i = 0; i < warm + rounds; i += 1) {
        const t = performance.now();
        await shellcheck.lint({ args: bench.args, stdin: bench.stdin });
        if (i >= warm) times.push(performance.now() - t);
      }
      entry.mediumMedianMs = Math.round(median(times) * 10) / 10;
    } catch (e) {
      entry.lintError = String(e && e.message ? e.message : e);
    }
    await shellcheck.dispose();
  }
  return out;
};
window.ready = true;
</script>`;

const TYPES = { ".js": "text/javascript", ".wasm": "application/wasm", ".map": "application/json" };
const server = http.createServer((req, res) => {
  const headers = {
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Cache-Control": "no-store",
  };
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/") {
    res.writeHead(200, { ...headers, "Content-Type": "text/html; charset=utf-8" });
    res.end(PAGE);
    return;
  }
  let file;
  const variant = url.pathname.match(/^\/variant\/([^/]+)\.wasm$/);
  if (variant) file = variants.find((v) => v.name === variant[1])?.file;
  else if (url.pathname.startsWith("/dist/")) file = path.join(repoRoot, url.pathname);
  if (!file || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, headers);
    res.end();
    return;
  }
  res.writeHead(200, {
    ...headers,
    "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream",
  });
  createReadStream(file).pipe(res);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const playwright = await import("playwright");
const report = { date: new Date().toISOString(), browsers: {} };
for (const name of BROWSERS) {
  const entry = (report.browsers[name] = {});
  let browser;
  try {
    browser = await playwright[name].launch();
    entry.version = browser.version();
    const page = await browser.newPage();
    const logs = [];
    page.on("console", (m) => logs.push(m.text()));
    page.on("pageerror", (e) => logs.push(`pageerror: ${e.message}`));
    await page.goto(`${origin}/`);
    await page.waitForFunction(() => window.ready === true, null, { timeout: 30_000 });
    const result = await page.evaluate((input) => window.runCheck(input), {
      variants: variants.map((v) => ({ name: v.name, url: `/variant/${v.name}.wasm` })),
      cases,
      probes: { tailCall: [...TAIL_CALL_PROBE], simd: [...SIMD_PROBE] },
      rounds: ROUNDS,
      warm: WARM,
    });
    for (const v of Object.values(result.variants)) {
      if (!v.results) continue;
      v.parity = Object.fromEntries(
        Object.entries(v.results).map(([c, r]) => [
          c,
          r.stdout === expected[c].stdout &&
            r.stderr === expected[c].stderr &&
            r.exitCode === expected[c].exitCode,
        ]),
      );
      v.allParity = Object.values(v.parity).every(Boolean);
      delete v.results;
    }
    Object.assign(entry, result);
    if (logs.length) entry.logs = logs.slice(0, 20);
  } catch (error) {
    entry.error = String(error);
  } finally {
    await browser?.close();
  }
  console.error(`done ${name}`);
}
server.close();
console.log(JSON.stringify(report, null, 2));
