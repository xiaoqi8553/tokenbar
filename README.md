# TokenBar

**Windows tray app for token usage.** How much Codex and WorkBuddy used, what it would cost, how fast it ran — one click on the tray icon.

Windows 托盘里的 token 用量看板。Codex 和 WorkBuddy 用了多少、折多少钱、跑得多快，点一下图标就能看到。

Reads local logs only. No network, no login, no upload.

只读本地日志。不联网、不登录、不上传。

## What it shows / 看什么

**Popover** — left-click the tray icon

**托盘弹窗** — 左键点图标

- 5-hour and 7-day quota windows: used %, remaining, reset time. The bar marks how much of the window has elapsed, so you can see if you're burning faster than time.
- 5 小时 / 7 天额度窗口：已用百分比、剩余、重置时刻。进度条上标着时间走到哪了，花得比时间快还是慢一眼能看出来。
- Today's tokens, request count, cache hit rate, plus a 14-day sparkline.
- 今日用量、请求数、缓存命中率，右边一条 14 天迷你柱图。
- WorkBuddy today / total / credits.
- WorkBuddy 今日、累计、积分。
- Equivalent cost, Codex + WorkBuddy combined.
- 等价花费，Codex 与 WorkBuddy 合计。

**Dashboard** — double-click the tray icon

**完整看板** — 双击图标

- Six metric cards: quota windows, today, total, cost, output speed, cache hit.
- 六张指标卡：额度窗口、今日用量、累计用量、等价花费、输出速度、缓存命中。
- Usage trend by day, switchable between 7 / 14 / 30 days and all time. Zero-token days keep their slot on the calendar, so the line falls back to the baseline instead of skipping the gap; the subtitle counts them. The Y axis ignores one-off spikes so ordinary days stay readable; days above the ceiling are marked and keep their real value in the tooltip. Below it: range total, range cost, daily average, peak day, period-over-period.
- 用量趋势按天，可切 7 / 14 / 30 天与全部。0 token 的日子照样占着日历上的一格，曲线自己落回基线，缺口不会凭空消失；空白天数写在副标题里。纵轴不受单日尖峰牵着走，超出上限的日子有标记、真实值留在 tooltip 里。下面一行给出区间用量、区间花费、日均、单日峰值、环比。
- Model and project split, recalculated per range, with cost and output speed on each row.
- 模型 / 项目分布，跟着区间重算，行尾都带金额与输出速度。
- Active hours: 24 hours × tokens, or switch to tok/s to see output speed per hour.
- 活跃时段：24 小时 × 用量，或切到 tok/s 看每个整点的输出速度。
- Sessions table: project, model, tokens, requests, speed, cost.
- 会话表：项目、模型、用量、请求数、速度、花费。

The top bar switches between `Codex` and `WorkBuddy`; both reuse the same charts.

顶栏切换 `Codex` / `WorkBuddy`，两套复用同一套图表。

## Data sources / 数据来源

| Source | Path |
|---|---|
| Codex sessions | `~/.codex/sessions/**/*.jsonl` |
| Codex history index | `%APPDATA%/TokenBar/data/usage-index.json` |
| WorkBuddy international | `~/.workbuddy-ai/projects/**/*.jsonl` |
| WorkBuddy China | `~/.workbuddy/projects/**/*.jsonl` |

WorkBuddy has two installs with different log directories. They often hold the same sessions, because the international build copies the old directory over on first launch. Files are deduplicated by session id, keeping the larger one, so nothing is counted twice.

WorkBuddy 国际版和国内版写日志的目录不同。两边的会话经常是同一批 —— 国际版首次启动会把旧目录整份搬过去。扫描时按会话 id 去重，只留体积更大的那份，不会重复计。

### What is NOT counted / 不计入的部分

TokenBar only reads `token_count` events from **local rollout files**. Codex Desktop also lists **cloud threads**: in `~/.codex/sqlite/codex.db` (`local_thread_catalog`) they have `source_kind = 'chatgpt'`, a `chatgpt:<account>` host, no `cwd`, and no rollout on disk. They do consume ChatGPT subscription quota, but the machine keeps only their title and timestamps — no token detail. Neither TokenBar nor CC Switch can reconstruct their token counts locally: CC Switch's `proxy_request_logs` is likewise filled by parsing local rollouts unless the local proxy is enabled. To get a session counted, run it as a local Codex session (VS Code extension / CLI / Desktop local mode), or route it through CC Switch's local proxy so the requests are logged.

TokenBar 只统计**本地 rollout** 里的 `token_count` 事件。Codex Desktop 里还有一类**云端线程**：在 `~/.codex/sqlite/codex.db` 的 `local_thread_catalog` 中，它们 `source_kind = 'chatgpt'`、host 是 `chatgpt:<账号>`、没有 `cwd`，磁盘上也不写 rollout。这类会话照样扣 ChatGPT 订阅额度，但本机只留下标题和时间，**没有 token 明细**，TokenBar 和 CC Switch 都无法从本地补算（CC Switch 的 `proxy_request_logs` 默认也是解析本地 rollout 得来的，除非开启本地代理）。想让用量进看板，要么用本地 Codex 会话（VS Code 扩展 / CLI / Desktop 的 local 模式），要么让请求经过 CC Switch 本地代理被记账。

## Accounting / 口径

### Total / 累计

Two different numbers live in the logs, and mixing them gives absurd totals. **The total is disk logs ∪ history index, deduplicated by request fingerprint, then summed.**

日志里有两套数字，混用会算出离谱的总量。**累计 = 磁盘日志 ∪ 历史索引，按请求指纹全局去重后相加**（v2.3.0 起）。

A request's fingerprint is its usage quintuple `(input, cached_input, output, total, reasoning_output)`. Both the old index records and the on-disk `token_count` events go through the same `event-dedupe.cjs`, so a request already stored in the history index is skipped when the same rollout is still on disk. The two sides become complementary and can simply be added.

请求指纹是这条请求的用量五元组 `(input, cached_input, output, total, reasoning_output)`。旧索引记录与磁盘上的 `token_count` 事件共用 `event-dedupe.cjs`：历史索引里已记过的请求，磁盘上若还留着同一份 rollout 就会跳过。两边因此互补，可以直接相加。

| Approach | Result on this machine | Verdict |
|---|---|---|
| Dedupe by request fingerprint, add disk + index | **5.13B** over 144 days | what the UI shows |
| Old: larger per day over an un-deduped index | 6.58B | **1.36B too high** — fork replay counted up to 4× |
| Disk logs only (net new after dedupe) | 0.50B | early rollouts were cleaned up |
| Sum each file's last `total` | 3.78B | wrong, resumed sessions double count |
| Max `total_token_usage` per session, summed | 6.1B | wrong, resumed sessions carry old totals |

Two traps pull in opposite directions: `resume` / `fork` replays the whole earlier conversation into a new rollout file, so counting by `file:line` charges the same request many times; and Codex deletes old rollouts, so disk only holds the recent stretch. On 2026-07-24 four rollout files shared a **721–746 event common prefix** — all four summed to 365.8M, but only 94.7M were distinct requests.

两个坑方向相反：`resume` / `fork` 会把此前整段会话重放进新的 rollout 文件，按 `file:line` 累加就把同一批请求算了很多遍；而 Codex 又会清理旧 rollout，磁盘上只剩最近一段。本机 2026-07-24 的四个 rollout 文件有 **721～746 轮完全相同的公共前缀**，四份全加是 365.8M，按签名去重后只有 94.7M。

The old "larger value per day" was an approximation for when identical requests couldn't be told apart. Rebuilding the v3 baseline removed **10,607 replay records / 1.357B** from 42,151 indexed rows; the resulting Codex total dropped from 6.58B to 5.13B. For reference, CC Switch v4 reports 4.87B Codex-only on this machine: from August onward the two agree day by day, and the remaining ~0.26B is history from `.zst` / `archived_sessions` that CC Switch never imported — real requests, not double counting. WorkBuddy adds another 0.45B; don't compare its combined number against CC Switch's Codex-only figure.

旧的「按天取大者」是在无法区分同一请求时的近似。重建 v3 基线后，从 42,151 条索引记录里剔掉 **10,607 条 replay / 1.357B**，Codex 累计从 6.58B 降到 5.13B。作为参照，CC Switch v4 在这台机器上显示 4.87B（只含 Codex）：8 月以后两边逐日吻合，剩下的约 0.26B 是 CC Switch 从未导入过的 `.zst` / `archived_sessions` 历史请求，是真实用量而不是重复计算。WorkBuddy 另加约 0.45B；不要把两边合计拿去跟 CC Switch 的 Codex 单源数字对比。

Baseline version 3, usage cache version 4 and detail cache version 7 all invalidate their predecessors, so the first launch after upgrading rebuilds once (about 1.5s on this machine). Nothing in `userData` is rewritten by hand — deleting the caches only forces a rescan.

基线版本 3、用量缓存版本 4、明细缓存版本 7 都会让旧缓存自动失效，升级后首次启动会重建一次（本机约 1.5 秒）。不会手工改写 `userData` 里的原始文件，删缓存也只会触发重扫。

### Cost / 花费

The money shown is **list-price equivalent**, not what you were charged. Plus / Max is a flat subscription; these tokens weren't billed per unit. The number answers "what would this cost on the API".

看板上的金额是按 API 刊例价折算的等价金额，不是订阅实扣。Plus / Max 是包月，这些 token 并没有逐笔付钱。这个数字回答的是「如果走 API 要花多少」。

```text
cost = new input / 1e6 × input price
     + cache hit / 1e6 × cached price
     + output    / 1e6 × output price

new input = inputTokens - cachedInputTokens
```

Three ways to get this wrong:

- **Don't multiply `inputTokens` by the input price.** Both vendors include cached tokens in `inputTokens`, and cache hits are usually 95%+. Multiplying directly inflates cost several times over.
- **Don't bill reasoning separately.** Every vendor already counts it in `output_tokens`.
- **Convert USD entries.** Models priced in USD are converted at `usdCny` (default 7.2) before summing, so Codex and WorkBuddy money can be added together.

Model names match by longest prefix: `glm-5.3-flashx` wins over `glm-5.3-flash`, which wins over `glm-5.3`. Unknown models fall back to a default rate and are labelled "estimated" — better an estimate than a zero.

模型名用最长前缀匹配：`glm-5.3-flashx` 优先命中自己，其次 `glm-5.3-flash`，最后 `glm-5.3`。表里没有的型号按兜底价估算并标「估算」—— 宁可估，不记 0。

Price data lives at `%APPDATA%/TokenBar/data/pricing.json`. Edit it and reopen the dashboard to apply.

单价数据在 `%APPDATA%/TokenBar/data/pricing.json`，改完重开看板生效。

### WorkBuddy

Each model call carries a usage block: `inputTokens` (includes cache), `outputTokens`, `cached_tokens`, `reasoning_tokens`, `rawUsage.credit`.

每条模型调用在 `providerData` 里带一份 usage：`inputTokens`（含缓存）、`outputTokens`、`cached_tokens`、`reasoning_tokens`、`rawUsage.credit`。

- **Don't deduplicate by `conversationRequestId`.** One request is split into a dozen steps, each a separate model call with its own usage. Deduplicating by request id collapsed 985 calls into 27 on this machine. The key is `traceId|stepSeq`.
- 不能按 `conversationRequestId` 去重。一次请求会拆成十几个 step，每个 step 都是一次独立调用、各带一份 usage。按请求 ID 去重会把 985 次压成 27 次。去重键是 `traceId|stepSeq`。
- **Input includes cache.** `new input = input - cached`. Cache hit rate here is 98%, so the two buckets need to be read separately.
- 输入含缓存，`新增输入 = input - cached`。本机缓存命中率 98%，两档要分开看。
- **Speed comes from timestamps, not a duration field.** Codex logs `duration_ms` per turn; WorkBuddy doesn't. But `function_call` and `function_call_result` each carry a `timestamp`, and the gap between them is that turn's wall time. Pairing them by `parentId` gives the same number Codex reports.
- 速度不是现成字段，是两个时间戳相减出来的。Codex 日志直接给 `duration_ms`，WorkBuddy 没有，但 `function_call` 和 `function_call_result` 各带一个 `timestamp`，两者之差就是这一轮的墙钟耗时，按 `parentId` 配对即可，口径与 Codex 一致。

### Speed / 速度

`tps = output tokens ÷ turn duration`. This is **whole-turn throughput**, not raw streaming decode speed — it includes tool calls and waiting, so a session that spends 30s running a shell command looks slow even if the model replied instantly.

`tps = 输出 tokens ÷ 轮耗时`。这是**整轮吞吐**，不是纯流式解码速度 —— 里面包含了工具调用和等待，所以一轮里跑了 30 秒 shell 命令的会话会显得慢，哪怕模型本身秒回。

| Source | Where the duration comes from |
|---|---|
| Codex | `task_complete.duration_ms` per turn, paired with `token_usage_record` by `turn_id` |
| WorkBuddy | `function_call_result.timestamp − function_call.timestamp`, paired by `parentId` |

Sessions without a matched pair are excluded rather than counted as zero — that keeps the average honest.

配不上的轮次直接不计入，不会当成 0 拉低平均。

Sessions table shows `tok/s` for both sources. A WorkBuddy session with no matched turns falls back to showing its credits, so the column is never blank.

会话表两个数据源都显示 `tok/s`。WorkBuddy 会话如果一轮都配不上，就退回显示它的积分，这一列不会空着。

## Install / 安装

This repo is source only — there is no exe to download. Build it once:

仓库里只有源码，没有可直接下载的 exe。先构建一次：

```bash
npm install
npm run desktop:dir        # portable folder → release/desktop/win-unpacked/TokenBar.exe
npm run desktop:build      # NSIS installer → release/desktop/TokenBar-Setup-<version>.exe
npm run desktop:shortcut   # desktop shortcut
```

Runs on double-click, sits in the tray, closing the window doesn't quit.

免安装版双击就跑，托盘常驻，关窗口不退。

## Develop / 开发

```bash
npm install
npm start                  # Electron in dev mode
npm test                   # data layer + UI assertions
npm run usage:audit        # compare the total-accounting approaches
npm run usage:verify       # verify the deduplicated total against the raw index
npm run desktop:smoke      # startup, tray, window lifecycle
```

```text
desktop/
  main.cjs                    main process: tray, popover, dashboard window, IPC
  popover.html                tray popover
  dashboard.html              full dashboard (single file, no build step)
  data/codex-store.cjs        Codex: scan, per-request dedupe, speed, cost
  data/event-dedupe.cjs       request fingerprint shared by index and disk logs
  data/workbuddy-store.cjs    WorkBuddy: two roots, dedupe by session id, speed
  data/history-baseline.cjs   old index → per-day summary (v3: deduplicated)
  data/pricing.cjs            price table and conversion
tests/                        data layer and UI assertions
```

Caches live in `%APPDATA%/TokenBar/data/`. Deleting them only forces a rescan.

缓存都在 `%APPDATA%/TokenBar/data/`，删掉只会重扫，不影响正确性。

## License

MIT
