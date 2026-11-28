# Changelog

All notable changes to this project will be documented in this file. Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), adheres to [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html).

2.x 及更早版本的完整记录见 [CHANGELOG-2x.md](./CHANGELOG-2x.md)。

## [Unreleased]

## [4.0.0] - 2026-11-28

**V4.0 架构级重塑：左侧边栏工作台 + 托盘直达完整看板 + 高对比度三色视觉体系**。

### Changed

- **全新左侧边栏工作台（Sidebar + Bento Workspace）**：告别传统单栏堆叠布局，引入固定左侧边栏（品牌区、带实时用量的垂直数据源导航、常驻额度微缩条、账号/签到/主题工具栏）与右侧自适应 Bento 画布，信息层次更清晰。
- **取消简略小窗拦截，点击托盘直达完整看板**：启动应用或点击系统托盘图标直接打开/切换完整看板大窗（`toggleWindow`），不再先弹出简略小窗再二次点击跳转。
- **高对比度 Agent 配色**：为三大平台重构高区分度专属色——Codex 靛紫（`#6366f1`）、Antigravity 琥珀金（`#f59e0b`）、WorkBuddy 翡翠绿（`#10b981`），多平台占比条一目了然。

## [3.5.0] - 2026-11-28

**V3.5 界面与交互全面升级**：围绕「图形化视觉密度 + 深度交互体验」重构看板视觉层，大幅提升图表丰富度、数据可读性与多维联动能力。

### Added

- **多 Agent 占比可视化条（总览专属）**：在「总览」顶部新增 Codex / Antigravity / WorkBuddy 三色比例构成条与品牌卡片，点击任一 Agent 卡片或色块即可直接跳转到对应数据源选项卡。
- **指标卡迷你趋势图（Sparklines）**：为「累计用量」「等价花费」「输出速度」等指标卡嵌入最近 14 天 SVG 面积折线图，配合额度卡环形仪表，实现全卡片图形化。
- **趋势图双模式切换**：新增「曲线 / 柱状（按新增输入 / 缓存 / 输出三色堆叠）」与「用量 / 花费（USD）」实时切换。
- **交互式环形分布图（Donut Chart）**：「模型分布」与「项目分布」顶部新增多色 SVG 环形图与图例，悬停高亮对应扇区，点击扇区或图例自动定位并展开下方明细行。
- **20 周贡献热力图**：在「活跃时段」新增「热力图」视图，按周 × 星期网格展示近 140 天活跃强度，悬停可查看每日 Token、花费与请求数。
- **会话实时搜索**：在「会话记录」右上角新增搜索框，支持按项目名、路径或模型名实时过滤会话。

### Changed

- **Bento 质感与氛围光效**：升级顶栏毛玻璃效果、环境径向光晕与卡片悬停微动效，整体视觉层次更通透立体。

## [3.3.0] - 2026-11-28

新增 **「总览」全平台聚合视图**、**项目内模型分布占比明细**，统一顶栏品牌区宽度与数据源对称布局，并升级 **Codex / Antigravity / WorkBuddy** 官方品牌矢量图标。

### Added

- **「总览」聚合选项卡**：顶栏新增「总览」作为默认入口（顺序：`总览`、`Codex`、`Antigravity`、`WorkBuddy`），合并展示三大平台的今日/累计用量、等价花费、输出速度、日趋势、模型/项目分布、活跃时段与会话明细，并同屏呈现 Codex 与 Antigravity 实时额度。
- **项目内模型占比明细**：在三大数据源聚合层新增 `projectModelDays` 维度；点击「项目分布」任一项目展开后，除四档 token 汇总外，还会展示该项目在当前时间区间内各模型的使用占比条、Token 数与花费。

### Fixed & Changed

- **顶栏对称与稳定性修复**：固定左侧品牌区宽度（`224px`）与统一三段式副标题格式（用量 · 花费 · 天数），彻底消除切换数据源时顶栏选项卡左右跳动的问题；四个数据源按钮采用等宽对称排版。
- **官方品牌图标升级**：将 Codex 替换为 OpenAI 六瓣结矢量图标，Antigravity 替换为官方 A 形拱门图标，WorkBuddy 替换为品牌圆角方标 W 图标，总览使用四宫格仪表图标。

## [3.2.1] - 2026-11-26

全面重塑桌面看板与托盘弹窗视觉及交互精简：去除冗长解释性文案，增加环形仪表、分段构成条与图标体系。

### Changed

- **视觉与图形化升级**：
  - **看板指标卡**：额度卡（Codex 5h / 7 天与 Antigravity Gemini / Claude）新增 SVG 环形进度仪表；今日用量 / 累计用量增加「新增输入 / 缓存 / 输出」三色分段构成条与昨日对比涨跌胶囊；所有卡片标题与顶栏数据源按钮、模块标题统一配备 SVG 图标。
  - **分布条**：模型与项目分布由单色条升级为三段比例构成条，直观展示输入、缓存命中与输出构成。
  - **托盘弹窗**：Codex 额度改版为双列并排环形仪表卡片，精简文案与倒计时格式（`4h 23m` / `剩余% · 正常`）。
  - **文案去冗余**：清理卡片、弹窗、空态、提示语与模态框中的解释性长句，突出关键数值与图标状态。

## [3.2.0] - 2026-11-26

新增 **Antigravity 官方实时额度查询与展示**（对齐 CC Switch `agy_account` 口径），支持 Gemini 与 Claude / GPT 双额度池、5 小时 / 每周 / Argon 窗口与套餐档位显示，单元测试扩展到 **120** 个。

### Added

- **Antigravity 凭据读取与额度查询**：新增 `desktop/data/antigravity-quota-store.cjs`，只读读取系统钥匙串 `gemini:antigravity`（Windows 凭据管理器 / macOS Keychain）及 `~/.cc-switch/agy_accounts.json`，按 CC Switch 协议请求 `https://daily-cloudcode-pa.googleapis.com/v1internal`（`:loadCodeAssist` + `:retrieveUserQuotaSummary`），支持提取套餐（`AI Pro`、`AI Ultra 5x/20x`、`Free`、`Paid`）以及 `gemini-5h`、`gemini-weekly`、`gemini-argon-wtu-weekly`、`3p-5h`、`3p-weekly` 五个官方额度桶。
- **令牌无损续期缓存**：`access_token` 临近过期或返回 401 时使用 Antigravity OAuth 客户端静默续期，续期副本仅缓存在 `%APPDATA%/TokenBar/data/antigravity-quota-cache.json`，绝不回写系统钥匙串或 CC Switch 原文件。
- **桌面全链路额度展示**：
  - **看板 Antigravity 标签**：新增 `Gemini 额度` 与 `Claude / GPT 额度` 两张实时进度卡，展示最紧张窗口占比、剩余百分比、重置时刻、消费节奏与另一窗口余量。
  - **托盘弹窗与右键菜单**：弹窗显示 `Antigravity 额度` 双进度条与套餐徽标，托盘右键菜单同步显示 Gemini / Claude 剩余百分比。
  - **实时额度管理弹窗**：新增 `antigravity-auth:*` IPC 通道，在「实时额度」面板展示 Antigravity 账号脱敏邮箱、套餐与各窗口详情并支持点击手动刷新。

### Fixed

- 修正看板顶栏「实时额度」「科研通签到」按钮在三数据源并排时的换行问题（补充 `white-space: nowrap`）。

## [3.1.0] - 2026-11-26

新增 **Antigravity** 数据源完整支持（对齐 CC Switch 计算口径），零新增生产依赖，单元测试扩展到 **115** 个。

### Added

- **Antigravity 多根目录日志扫描**：新增 `desktop/data/antigravity-store.cjs`，自动扫描 `~/.gemini/antigravity-cli`、`~/.gemini/antigravity`、`~/.gemini/antigravity-acp`、`~/.cc-switch/agy/*/antigravity-cli` 与 `~/.t3/{userdata,dev}/providers/antigravity/*/antigravity-acp`（支持 `ANTIGRAVITY_HOME` / `AGY_HOME` 覆盖），按会话 ID 与文件大小/修改时间跨目录去重并支持增量缓存。
- **零依赖 SQLite + Protobuf 伴生解码**：新增 `desktop/data/antigravity-native.cjs`，通过 Node / Electron 内置 `node:sqlite` 以只读方式读取 `conversations/<id>.db` 与 `conversation_summaries.db`，并内置轻量 Protobuf Wire 解析器提取真实模型 / `-tiered` 档位（field `19` / `21`）、`first_token` 首字延迟（TTFT）与 `streaming` 耗时，准确识别 Orchestrator 与 Worker 子代理调用。
- **CC Switch 同口径定价与模型归一化**：在 `desktop/data/pricing.cjs` 补充 Google Gemini 4 / 3.x / 2.x 与 Anthropic Claude USD 单价及 `cacheWrite` 分档计费，支持 `models/` / 厂商前缀、`claude-*` 命名规整、`-thinking` / 档位后缀裁剪、`-tiered` 精确回退与 `-flash-lite` 防误匹配。
- **三数据源桌面看板与弹窗联动**：主进程（`ctx.agyStore`、30 秒定时刷新）、托盘弹窗（`#d-agy` 行与合算美元花费 `#d-cost`）、看板顶栏三数据源切换（`Codex | WorkBuddy | Antigravity`）、首字延迟（TTFT 中位数）指标展示与 `dashboard:antigravity-*` IPC 通道全面接入。
- **自动化测试与冒烟验证**：新增 7 项 `tests/antigravity-store.test.js` 单元测试，并在 `scripts/desktop-smoke.js` 加入三源切换与 Antigravity 用量渲染端到端验证。

### Changed

- **Antigravity 原生 Token 口径转换**：兼容 Antigravity 原生 `transcript_full.jsonl`（`input_tokens` 为不含缓存的新增输入、`output_tokens` 已含 thinking、`PLANNER_RESPONSE` + `DONE` 过滤、`step_index` 覆写取末条与 `agy:<session>:<step>` 去重），入库映射为 `inputTokens = rawInput + cacheRead`，使看板各卡片与费用估算严格对齐 CC Switch 且不重复扣减。
- **文档与构建产物更新**：同步更新 `README.md`、`package.json` 描述、`scripts/verify-artifact.cjs` 白名单、`scripts/artifact-manifest.json` 与 `docs/shots/` 截图。

## [3.0.0] - 2026-11-24

品质升级波次：数据层、UI 构建、授权流程、去重口径、可观测性与发布工程一起收口。测试 **108** 个，生产依赖 **0** 个。

### Added

- **README 图文重塑，去掉 AI 腔。** 用户原话：「GitHub 页面现在丑、文字一看就是 AI 写的。」按成熟开源项目的句式骨架重写，主文中文、金额一律 `$`；补上明暗双图与截图目录说明，新增 `scripts/capture-shots.js`（`npm run docs:shots`）生成 `docs/shots/` 下五张图。
- **UI 构建注入**：看板 / 弹窗的静态资源改为构建期注入，版本与资源引用不再靠手改 HTML 保持一致。
- **OAuth 状态机**：设备码授权从散落的状态判断收敛成显式状态机（申请 → 待确认 → 成功 / 取消 / 过期），流程可追踪、可取消。
- **可观测性**：主进程关键路径补上结构化日志与状态快照，额度刷新、去重重建、签到结果都能从日志里还原。
- **CI / Release**：main 分支 CI 与 Release 工作流接入，徽章进 README；构建产物清单校验纳入发布流程。

### Changed

- **数据层分层**：扫描、请求指纹去重、速度、成本各自成层，Codex 与 WorkBuddy 两条数据链路结构同构，缓存版本各自失效重建。
- **去重指纹**：请求指纹五元组 `(input, cached_input, output, total, reasoning_output)` 贯穿历史索引与磁盘日志，累计口径固定为「磁盘 ∪ 索引，去重后相加」。
- **30 秒刷新**：实时额度与两源用量共用一个刷新节拍；主题定名为「月之亮面 / 月之暗面」两个具名标签，取代旧的三态循环。

### Fixed

- **跨源重复计数收口**：fork / resume 重放前缀在统一指纹下只记一次；历史索引与磁盘日志互补相加，弹窗与看板累计一致。
- **金额展示统一**：界面不再出现 `¥`，人民币刊例价只在展示边界按 `usdCny` 折算成 `$`，Codex 与 WorkBuddy 可同栏相加。
- **刷新边界**：WorkBuddy 增量重扫纳入 30 秒节拍，两源摘要不再停在启动那一刻的快照。

### Security

- **token 不出主进程**：授权 token 只留在 Electron 主进程内存，不进渲染进程、日志与命令行参数；界面只出现脱敏邮箱。
- **隐藏不等于删除**：用户问「这些玩意怎么清除啊」——隐藏账号只写 TokenBar 自己的配置，`~/.codex` 授权文件一个字节不碰；科研通密码仍走 `safeStorage`（Windows DPAPI）→ AES-256-GCM 降级，密文只存本机 `userData`。
- **凭证零入库**：全量扫描历史与工作区，API Key / token / 真实邮箱均未进入仓库；测试一律使用 `alice@example.com` 等假邮箱。

[3.2.1]: https://github.com/xiaoqi8553/tokenbar/compare/v3.2.0...v3.2.1
[3.2.0]: https://github.com/xiaoqi8553/tokenbar/compare/v3.1.0...v3.2.0
[3.1.0]: https://github.com/xiaoqi8553/tokenbar/compare/v3.0.0...v3.1.0
[3.0.0]: https://github.com/xiaoqi8553/tokenbar/compare/v2.6.1...v3.0.0
[Unreleased]: https://github.com/xiaoqi8553/tokenbar/compare/v3.2.1...HEAD
