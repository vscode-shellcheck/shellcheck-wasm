# 研究：再发一份不用 tail call 的 Artifact，按运行环境选用

2026-09-30。分支 `research/non-tail-call-artifact`，CI run
[36693002523](https://github.com/vscode-shellcheck/shellcheck-wasm/actions/runs/36693002523)。

## 结论

- **能编**。同一套 pin（GHC 9.14.1 / ghc-wasm-meta `1fb54774` / ShellCheck v0.11.0），只把
  `-mtail-call` 从 `WASM_CFLAGS` 去掉，得到的 Artifact：0 条 `return_call*`，Node 22/24 上
  `npm test`（含 parity 全套）全过，Node 18（没有 tail call 的 V8）上也跑出与 native
  逐字节一致的输出。
- **SIMD 去不掉**。去掉 `-msimd128` 后仍有 91 个函数用 SIMD：它们来自 ghc-wasm-meta
  预编译的 RTS、wasi-libc、gmp，不是我们编的代码。想要无 SIMD 版就得自建 GHC bindist 和
  wasi-sdk sysroot，不值得。好在 SIMD 的门槛（Safari 16.4）比 tail call（18.2）低得多。
- **慢多少**：
  - Node：x64 CI 上 notc 比 tc 慢 2–5%（小脚本）、9–15%（300 行）、13–20%（1500 行）；
    Apple M3 Max 上 Node 24 慢 7–16%，Node 22 慢 6%。
  - 浏览器（M3 Max，medium 脚本）：Chromium 慢 13%，WebKit 慢 6%，Firefox 基本不变（+0.3%）。
- **浏览器里能跑**：最新 Chromium 153、Firefox 155、WebKit 26.6 三款里，两个版本都能编译，
  输出与 native 逐字节一致。旧 WebKit 17.4 里探测正确返回 false，tc 编译失败，notc 能编译
  （lint 因为该构建没有 `SharedArrayBuffer` 没跑成）。
- **多大**：npm tarball 2.05 MB → 4.05 MB（+1.98 MB）；VSIX 约 +2.0 MB（deflate）。
- **推荐**：现在**不发第二份 Artifact**（方案 C+），但在 `./client` 加一个几十行的
  `supportsTailCalls()` 探测，让 web Host 在不支持的浏览器里给出明确提示，而不是
  `CompileError`。满足[触发条件](#推荐)时再上方案 A（两份 + 探测）。

## 1. 能不能编出来

### 机制

- GHC wasm NCG 在 `compiler/GHC/CmmToAsm/Wasm.hs` 里用
  `doTailCall ts = Option "-mtail-call" `elem` as_args` 决定输出方式，`as_args` 来自 GHC
  `settings`，也就是 `setup.sh` 时的 `CONF_CC_OPTS_STAGE*`。
- 同一个 `WasmTailCall` 节点（`Wasm/Asm.hs`）：开 → `return_call` / `return_call_indirect`；
  关 → 把下一个函数指针压栈后 `return`，回到 RTS 的 trampoline。函数签名不变，所以两种代码
  可以混链，功能等价。
- 不带 `-mtail-call` 正是 ghc-wasm-meta 自 2025-09-24（commit `eb8480b7`）以来的默认配置，
  上游 CI 测的就是它。README 给的理由："only supported in webkit since 18.2 and seems to
  cause ios webkit webview crashes occasionally"。

### 实测（三个变体，同一 pin，CI 冷构建）

| | tc（现状） | notc | notc-nosimd |
|---|---|---|---|
| `WASM_CFLAGS` 差异 | `-msimd128 -mtail-call` | `-msimd128` | 两者都去掉 |
| 链接产物函数数 | 74,671 | 74,671 | 74,671 |
| 含 `return_call` 的函数 | 61,976 | **0** | **0** |
| `call_indirect` 行数 | 43,353 | 110 | 110 |
| 用 SIMD 的函数 | 92 | 92 | **91**（只少了 `$main`） |
| 最终大小 | 9,891,167 | 9,244,686（−6.5%） | 9,244,747 |
| gzip -9 | 1,992,363 | 1,984,709 | 1,984,861 |
| sha256 | `5c6df43f…`（**与已发布的 0.2.0-next.1 逐字节相同**） | `912f4958…` | `33627abc…` |
| `npm test`（Node 22、24） | 通过 | 通过 | 通过 |

- tc 变体复现了 Release 里的 sha256，说明这条构建链是可复现的，对比可信。
- 用 SIMD 最多的函数：`$iconv`、`$evacuate`、`$getMBlocks`、`$poll_wasip1`、`$sweep`、
  `$__gmpn_*`、`$__strchrnul`、`$hs_init_ghc`……全是 RTS / libc / gmp。

### 实际用到的 wasm 特性（`wasm-tools validate --features …` 逐项关掉验证）

- tc：Wasm 2.0 子集（不含 reference-types、multi-value）+ SIMD + tail-call。
- notc：Wasm 2.0 子集 + SIMD，**不需要** tail-call。
- `-mcpu=lime1` 打开的 extended-const 在最终二进制里**没用到**（`target_features` 声称有，
  是 `wasm-opt` 按启用集合重写的，不能信）。所以 notc 的浏览器门槛由 SIMD 决定：
  Chrome 91 / Firefox 89 / Safari 16.4。页面还需要 cross-origin isolation 下的
  `SharedArrayBuffer`（Safari 15.2），不会更低。

### 构建流水线要改什么（本分支已经做了实验版）

- `Dockerfile`：`WASM_CFLAGS` 改成 `ARG`（toolchain stage），build stage 加
  `ARG TAIL_CALL=require|forbid`。toolchain 层按 flags 分开缓存，两份各自 `setup.sh`。
- `build.sh`：
  - `require`：维持现状（`check-target-features.py --require tail-call` 查链接产物，
    `wasm-opt --enable-tail-call`，`wasmtime -W tail-call=y`）。
  - `forbid`：**反向 gate 不能靠 `target_features`**（它只说"允许"，不说"用了"），改用
    `wasm-tools validate --features all,-tail-call`，对链接产物和 `wasm-opt` 之后的产物各跑一次；
    有一条 `return_call` 就失败。`wasm-opt` 不加 `--enable-tail-call`；`wasmtime -W tail-call=n`。
  - `validate --features all,-X` 比现在的 `target_features` gate 更硬，也适合替换 tc 版的
    post-opt 检查（现 gate 只能查 pre-opt，见 AGENTS.md）。
- CI / Release：`build-wasm` 变成 2 个 matrix job；Release 资产从 3 个变成 6 个
  （`shellcheck-baseline.wasm` + `.sha256` + `build-info-baseline.json`）。
- `scripts/build-constants.ts`：两份 build-info 都校验 sha256/size/version。
- `BUILD_INFO`：要么变成 `{ tailCall: BuildInfo, baseline: BuildInfo }`，要么新增
  `BASELINE_BUILD_INFO`。现在还是 `0.2.0-next`，破坏性改动的成本最低。
- `package.json`：`exports` 加 `./shellcheck-baseline.wasm`；`prepack` 检查两份都在。
- 测试：`test/package.test.ts` 里 `+tail-call` 断言按变体分支（本分支已改）；parity 对两份都跑。

## 2. 代价

| 项 | 现状 | 两份 | 差 |
|---|---|---|---|
| npm tarball（`npm pack`） | 2,054,986 B | 4,052,397 B | +1.98 MB（~2×） |
| unpacked | 10.1 MB | 19.3 MB | +9.2 MB |
| VSIX 增量（zip deflate 单文件） | — | — | +2.02 MB |
| CI 冷构建（并行 job） | tc 16 min | notc 12 min | 并行，墙钟不变；有 gha cache 时约 1 min |
| parity 矩阵 | 1 份 × Node 22/24 | 2 份 × Node 22/24 | 测试 job 翻倍，每个 < 1 min |
| Release 资产 | 3 | 6 | — |

- 只发 notc 时 tarball 反而小 5 KB（2,049,574 B）。
- 维护成本：多一份 build-info、多一个 gate 分支、一条 ADR；ghc-wasm-meta 升级时两份都要过 parity。

## 3. 运行时怎么选

### 探测

两个极小模块，`WebAssembly.validate` 同步、微秒级：

```js
// (func return_call 0) — 26 bytes
const TAIL_CALL_PROBE = new Uint8Array([
  0x00,0x61,0x73,0x6d,0x01,0x00,0x00,0x00, 0x01,0x04,0x01,0x60,0x00,0x00,
  0x03,0x02,0x01,0x00, 0x0a,0x06,0x01,0x04,0x00,0x12,0x00,0x0b]);
// (func v128.const i32x4 0 0 0 0 drop) — 43 bytes
const SIMD_PROBE = /* 见 scripts/research/probes.mjs */;
export const supportsTailCalls = () => WebAssembly.validate(TAIL_CALL_PROBE);
```

实测（`scripts/research/engine-check.mjs`，CI）：

| 引擎 | probe tailCall | tc | notc |
|---|---|---|---|
| Node 18.20（V8 10.2） | **false** | `CompileError: … Invalid opcode 0x13` | 编译 154 ms，5/5 parity |
| Node 22.23（V8 12.4） | true | 5/5 parity | 5/5 parity |
| Node 24.21（V8 13.6） | true | 5/5 parity | 5/5 parity |

浏览器（Playwright，Apple M3 Max，页面经 COOP/COEP 做 cross-origin isolation，走
`./client` + `dist/browser/worker.js`；`scripts/research/browser-check.mjs`）：

| 浏览器 | probe tailCall / simd | tc | notc |
|---|---|---|---|
| Chromium 153 | true / true | 4/4 parity | 4/4 parity |
| Firefox 155 | true / true | 4/4 parity | 4/4 parity |
| WebKit 26.6 | true / true | 4/4 parity | 4/4 parity |
| WebKit 17.4（Playwright 1.45.3） | **false** / true | `CompileError: … wasm tail calls are not enabled, in function at index 17` | 编译成功；lint 没跑（见下） |

- 旧 WebKit 那一行：页面 `crossOriginIsolated` 为 false，报 `Can't find variable:
  SharedArrayBuffer`。Safari 从 15.2 起支持 COOP/COEP，所以这更像是 Playwright 这个旧
  WebKit 构建的问题，而不是 Safari 17.4 本身的行为；**真 Safari 17.x 上 notc 能否跑完 lint 未验证**。
- notc-nosimd 在所有浏览器里的结果都与 notc 相同，表里省略。

### 放在哪

- **放 `./client`**：纯函数、无 `import.meta`、无依赖，MIT，符合 ADR 0007。Host 本来就在
  `./client` 所在线程上编译 Module，探测和编译是同一个引擎。
- 不建议"先编 tc、失败再编 notc"：10 MB 的失败编译代价不可控，而且吞掉的错误会掩盖真问题。
- 包只回答"这个引擎能不能跑 tc"；"能跑但要不要用"（例如 iOS WebKit 的崩溃风险，见下）是
  Host 的策略（ADR 0005）。

### API 草案（仅方案 A 需要全部；C+ 只需要第一行）

```ts
// ./client（MIT）
export function supportsTailCalls(): boolean;
export const ARTIFACTS: { tailCall: "shellcheck.wasm"; baseline: "shellcheck-baseline.wasm" };
export function selectArtifact(): "shellcheck.wasm" | "shellcheck-baseline.wasm";
// exports
"./shellcheck.wasm": "./dist/shellcheck.wasm",
"./shellcheck-baseline.wasm": "./dist/shellcheck-baseline.wasm",
```

vscode-shellcheck 侧只改一行：`joinPath(pkgDist, selectArtifact())`，桌面和 web 共用。

### 各环境

| 环境 | tail call | 选中 | 出处 |
|---|---|---|---|
| Node 22 / 24（`engines`） | 有（Node 20+） | tc | 实测；wa.org |
| VS Code 桌面 1.139（Electron 43，Chromium 150） | 有（≥ 1.82 / Chromium 114） | tc | Electron releases.json；v1_82 release notes |
| Chrome / Edge ≥ 112 | 有 | tc | chromestatus 5423405012615168 |
| Firefox ≥ 121（ESR 140/153） | 有 | tc | Firefox 121 release notes |
| Firefox ESR 115（Win7–8.1、macOS 10.12–10.14，支持到 2027-03） | 无 | notc | whattrainisitnow.com |
| Safari ≥ 18.2（macOS 13+、iOS 18.2+） | 有 | tc（但见下方风险） | Safari 18.2 release notes |
| Safari 16.4–18.1（macOS 12 封顶 17.6；iPhone 8/X 封顶 iOS 16；iPad 6 代等封顶 iPadOS 17） | 无 | notc | Apple 兼容性页面 |
| Safari < 16.4 | 无，SIMD 也无 | 都不行 | BCD |

## 4. 值不值：谁会受益

- **人群小**：caniuse（2026-09-30）按版本加总，Safari < 18.2 约占全球浏览量 **1.8%**
  （iOS 1.24% + 桌面 0.55%）；再乘上"在这些设备上用 vscode.dev 写 shell 脚本"的比例，接近 0。
  caniuse 自己的 `wasm-tail-calls` 78% 是错的（它把 Safari 全标成 no，该条目已隐藏不维护）。
- **VS Code for the Web 官方只保证最新版浏览器**："we only guarantee support for the latest
  version"（code.visualstudio.com/docs/setup/vscode-web）。
- **vscode.dev 默认不是 cross-origin isolated**，SAB 要 `?vscode-coi=on`（2023 年的官方博客；
  现在是否仍然如此**未验证**）。这一门槛比 tail call 挡掉的人更多。
- **反方向的风险（重要）**：即使在支持 tail call 的最新 iOS 上也有问题。
  - WebKit bug [325447](https://bugs.webkit.org/show_bug.cgi?id=325447)（2026-09-28，NEW）：
    "[Wasm][iOS 27] Intermittent WebContent crash in IPInt cross-instance tail-call
    restore-frame insertion"，只在 iPhone（arm64e）上复现，Mac 上没有。
  - 我们的模块是单实例，"cross-instance" 可能不适用；**是否影响本 Artifact 未验证**（手头没有 iOS 设备）。
  - 这与 ghc-wasm-meta 的 "ios webkit webview crashes" 说法吻合。如果坐实，notc 就是 iOS 上
    唯一稳定的选项，此时"按 probe 选"不够，Host 需要"iOS WebKit 一律用 notc"的策略。

## 5. 方案对比

| 方案 | 做法 | 好处 | 坏处 |
|---|---|---|---|
| **A. 两份 + 探测** | 包里发 tc + notc；`./client` 导出 `supportsTailCalls` / `selectArtifact` | 所有人拿到能跑的最快版本；为 iOS 崩溃留退路 | tarball/VSIX +2 MB；构建/Release/BUILD_INFO/测试都翻倍；新 ADR |
| B. 只发 notc | 去掉 `-mtail-call`，gate 反过来 | 最简单；与 ghc-wasm-meta 默认一致；门槛降到 Safari 16.4；绕开 WebKit tail-call bug | 桌面（绝大多数用户）慢 2–20%，大文件越慢越多；ADR 0002 的主要理由作废 |
| C. 不做 | 维持 tc，README 写明 Safari 18.2+ | 零成本 | 老 Safari 上是一条看不懂的 `CompileError` |
| **C+. 不做 + 探测**（推荐） | 维持 tc；`./client` 只加 `supportsTailCalls()`；README 写门槛 | 成本 ≈ 30 行 MIT 代码 + 一个单测；Host 能给出"浏览器太旧"的提示；将来升级到 A 时 API 不变 | 老 Safari / ESR 115 用户仍然用不了 |
| A'. 桌面只用 tc，web 按探测选 | 同 A，只是桌面不探测 | — | 同一个 VSIX 服务桌面和 web，包里照样要带两份；和 A 成本一样，只是 Host 代码多一个分支。不如统一探测 |

### 推荐

**现在做 C+。** 理由：受益人群约 1.8% 的浏览量，且与 vscode.dev 的真实用户重叠极小；
代价是包体积翻倍和一整套双份流水线；B 让绝大多数桌面用户付 6–20% 的性能税（Node 22/24，
x64 与 arm64），不划算。

浏览器实测没有改变这个结论，但让方案 A 的一种变体更便宜：tail call 在浏览器里的收益不大
（Chromium 13%、WebKit 6%、Firefox 0%），所以真要上 A 时，web Host 可以对 WebKit 一律用 notc，
几乎不损失性能，又绕开 WebKit 的 tail-call bug。

**满足任一条件就升级到 A**（本分支的 Dockerfile/build.sh/workflow 可以直接复用）：

1. 有用户在 Safari < 18.2、iPadOS 17 或 Firefox ESR 115 上报"用不了"；
2. WebKit 325447 或类似 bug 被证实会让本 Artifact 在 iOS 上崩溃（这时 Host 对 iOS 用 notc）；
3. vscode-shellcheck 要把 iPad / 移动端当成正式支持平台。

## 6. 牵动的 ADR 与文档

| 文档 | 方案 C+ | 方案 A |
|---|---|---|
| ADR 0002 own the wasm build | 不变；Consequences 补一句"web 需要 Safari 18.2+，`supportsTailCalls()` 可探测" | 修订：tail call 从"唯一产物"变成"首选产物"，另有 baseline；gate 变成两个方向 |
| ADR 0003 command module | 不变 | 不变（两份都是 command module） |
| ADR 0004 独立版本号 | 不变 | 不变；但 `BUILD_INFO` 形状变化是包的破坏性改动，需要在 0.2.0 正式版前定 |
| ADR 0005 Host 策略 | 不变 | 补充：包只回答"能不能"，"用哪份"（如 iOS 规避）归 Host |
| ADR 0006 FS agnostic | 不变 | 不变（`BUILD_INFO` 仍编译进包，多一份而已） |
| ADR 0007 client 是 MIT | 新函数进 `./client`，保持 MIT、无 `import.meta` | 同左，多 `ARTIFACTS` / `selectArtifact` |
| 新 ADR | 不需要 | 需要："发两份 Artifact，由探测选择"（难以撤回、有真实权衡） |
| README | 写明 Safari 18.2+ / Firefox 121+，介绍 `supportsTailCalls()` | 两个文件、选择方法、各环境表 |
| AGENTS.md 不变量 | 不变 | tail-call gate 描述改成"tc 要求 / baseline 禁止，用 `wasm-tools validate --features all,-tail-call`"；Layout 列出两份 |
| CONTEXT.md | 不变 | "Artifact" 定义改成可有两份；新词 "Baseline artifact"；"Tail-call gate" 改成双向 |

## 性能

### x64（GitHub Actions，`scripts/research/bench-variants.mjs`，N=20，轮次交错，中位数 ms/lint）

Node 22.23（AMD EPYC 9V74）：

| 脚本 | 行 | tc | notc | notc-nosimd | native | notc/tc | tc/native | notc/native |
|---|---|---|---|---|---|---|---|---|
| small | 23 | 74.1 | 77.9 | 78.0 | 22.3 | +5.1% | 3.32x | 3.49x |
| medium | 307 | 681.4 | 740.7 | 741.9 | 151.8 | +8.7% | 4.49x | 4.88x |
| large | 1503 | 3976.0 | 4490.1 | 4514.3 | 897.7 | +12.9% | 4.43x | 5.00x |

Node 24.21（AMD EPYC 7763）：

| 脚本 | 行 | tc | notc | notc-nosimd | native | notc/tc | tc/native | notc/native |
|---|---|---|---|---|---|---|---|---|
| small | 23 | 93.1 | 95.1 | 96.3 | 27.1 | +2.1% | 3.44x | 3.51x |
| medium | 307 | 700.7 | 805.6 | 795.3 | 160.9 | +15.0% | 4.35x | 5.01x |
| large | 1503 | 3798.9 | 4578.4 | 4574.8 | 922.1 | +20.5% | 4.12x | 4.97x |

- `WebAssembly.compile`（子进程、V8 懒编译）：tc 28–29 ms，notc 25–26 ms。
- notc-nosimd 与 notc 没有可测差别，符合"SIMD 实际上没去掉"。
- 共享 runner 上有噪声，看趋势：脚本越大差距越大，与 2026-09-21 的 `_start` 实测（Node 24 +13–16%）一致。

### Apple M3 Max（macOS 26.7，`bench-variants.mjs`，N=30，WARM=5）

Node 24.21：

| 脚本 | 行 | tc | notc | notc-nosimd | native | notc/tc | tc/native | notc/native |
|---|---|---|---|---|---|---|---|---|
| small | 23 | 39.7 | 42.6 | 43.0 | 22.1 | +7.3% | 1.80x | 1.93x |
| medium | 307 | 372.1 | 418.1 | 421.0 | 113.9 | +12.3% | 3.27x | 3.67x |
| large | 1503 | 2294.1 | 2656.6 | 2587.8 | 594.6 | +15.8% | 3.86x | 4.47x |

Node 22.23：

| 脚本 | 行 | tc | notc | notc-nosimd | native | notc/tc | tc/native | notc/native |
|---|---|---|---|---|---|---|---|---|
| small | 23 | 36.0 | 38.2 | 38.1 | 21.6 | +6.3% | 1.67x | 1.77x |
| medium | 307 | 370.8 | 392.4 | 389.4 | 106.6 | +5.8% | 3.48x | 3.68x |
| large | 1503 | 2343.5 | 2476.9 | 2482.5 | 568.9 | +5.7% | 4.12x | 4.35x |

- 与 2026-09-21 的 `_start` 实测一致：Node 24 从 tail call 得到的好处比 Node 22 大。
- 子进程编译耗时这次没测到（脚本 bug，已修）；进程内首次 `WebAssembly.compile`
  （`engine-check.mjs`）tc 13–15 ms、notc 13–14 ms，没有差别。

### 浏览器（Apple M3 Max，Playwright，medium 脚本约 500 行，WARM=3 后 15 轮中位数，ms/lint）

| 浏览器 | tc | notc | notc/tc | compileStreaming tc / notc | 首轮 4 个 case 合计 tc / notc |
|---|---|---|---|---|---|
| Chromium 153 | 694.5 | 786.0 | +13.2% | 41 / 38 ms | 913 / 940 ms |
| Firefox 155 | 775.9 | 778.6 | +0.3% | 83 / 55 ms | 1072 / 949 ms |
| WebKit 26.6 | 622.3 | 657.0 | +5.6% | 469 / 458 ms | 954 / 948 ms |

- Firefox 的 notc 与 tc 一样快。WebKit 只慢约 6%；如果将来 Host 为规避 iOS 上的 tail-call bug
  对 WebKit 一律用 notc，代价很小。
- WebKit 的 `compileStreaming` 要 450–470 ms（V8 和 SpiderMonkey 是懒编译，只要几十 ms），
  与是否用 tail call 无关。

## 复现

- 构建：`.github/workflows/research-non-tail-call.yml`（push 到本分支或手动触发）。产物
  `wasm-{tc,notc,notc-nosimd}`、诊断 `diag-*`（`summary.txt`、`simd-funcs.txt`）、`engine-node*`、`bench-node*`、`sizes`。
- 本地：`scripts/research/engine-check.mjs`、`bench-variants.mjs`、`browser-check.mjs`
  （头注释里有用法）。
- 特性核对：`wasm-tools validate --features wasm2,-reference-types,-multi-value[,tail-call|-simd] shellcheck.wasm`。

## 未验证

- WebKit 325447 是否影响本 Artifact（需要 iOS 27 真机）。
- vscode.dev 现在是否仍需 `?vscode-coi=on`。
- 真 Safari 16.4–18.1 上 notc 能否跑完 lint：Playwright 的 WebKit 17.4 构建里探测和编译都符合预期，但页面没有 `SharedArrayBuffer`，lint 没跑成。
- ghc-wasm-meta 提到的 "ios webkit webview crashes" 的原始报告（commit 无链接，可能在私聊里）。
