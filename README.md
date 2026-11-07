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
- Usage trend by day, switchable between 7 / 14 / 30 days and all time. Zero-token days are drawn too: hollow dots on the baseline and a gap count in the subtitle. The Y axis ignores one-off spikes so ordinary days stay readable; days above the ceiling are marked and keep their real value in the tooltip. Below it: range total, range cost, daily average, peak day, period-over-period.
- 用量趋势按天，可切 7 / 14 / 30 天与全部。0 token 的日子也画在图上，基线空心点加副标题里的空白天数。纵轴不受单日尖峰牵着走，超出上限的日子有标记、真实值留在 tooltip 里。下面一行给出区间用量、区间花费、日均、单日峰值、环比。
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

## Accounting / 口径

### Total / 累计

Two different numbers live in the logs, and mixing them gives absurd totals. The total is disk logs ∪ history index, taking the larger value per day, then summed.

日志里有两套数字，混用会算出离谱的总量。累计 = 磁盘日志 ∪ 历史索引，**按天取大者**后再求和。

| Approach | Result on this machine | Verdict |
|---|---|---|
| Disk logs ∪ index, larger per day | **5.8B** over 135 days | what the UI shows |
| Disk logs only | 2.4B | early rollouts were cleaned up, misses more than half |
| Sum each file's last `total` | 3.78B | wrong, resumed sessions double count |
| Max `total_token_usage` per session, summed | 6.1B | wrong, resumed sessions carry old totals |

Two traps pull in opposite directions: `resume` splits one session into several rollout files, each carrying the previous running total; and Codex deletes old rollouts, so disk only holds the recent stretch. So you accumulate per turn *and* backfill the deleted history from the old index.

Per-day larger-of works only where both sides cover the same day: overlapping days take the larger, missing days come from the index. It is not addition, so nothing is counted twice.

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

Portable build:

```text
release/desktop/win-unpacked/TokenBar.exe
```

Runs on double-click, sits in the tray, closing the window doesn't quit.

免安装版双击就跑，托盘常驻，关窗口不退。

```bash
npm install
npm run desktop:build      # NSIS installer → release/desktop/TokenBar-Setup-<version>.exe
npm run desktop:dir        # portable folder only, for debugging
npm run desktop:shortcut   # desktop shortcut
```

## Develop / 开发

```bash
npm install
npm start                  # Electron in dev mode
npm test                   # data layer + UI assertions
npm run usage:audit        # compare the total-accounting approaches
npm run usage:verify       # check merged totals against the raw index
npm run desktop:smoke      # startup, tray, window lifecycle
```

```text
desktop/
  main.cjs                    main process: tray, popover, dashboard window, IPC
  popover.html                tray popover
  dashboard.html              full dashboard (single file, no build step)
  data/codex-store.cjs        Codex: scan, per-day merge, speed, cost
  data/workbuddy-store.cjs    WorkBuddy: two roots, dedupe by session id, speed
  data/history-baseline.cjs   old index → per-day summary (with hourly buckets)
  data/pricing.cjs            price table and conversion
tests/                        data layer and UI assertions
```

Caches live in `%APPDATA%/TokenBar/data/`. Deleting them only forces a rescan.

缓存都在 `%APPDATA%/TokenBar/data/`，删掉只会重扫，不影响正确性。

## License

MIT
