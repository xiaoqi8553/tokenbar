# Changelog

All notable changes to this project will be documented in this file. Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), adheres to [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html).

2.x 及更早版本的完整记录见 [CHANGELOG-2x.md](./CHANGELOG-2x.md)。

## [Unreleased]

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

[3.0.0]: https://github.com/xiaoqi8553/tokenbar/compare/v2.6.1...v3.0.0
[Unreleased]: https://github.com/xiaoqi8553/tokenbar/compare/v3.0.0...HEAD
