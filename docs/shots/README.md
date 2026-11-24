# 文档截图

README 里引用的截图都由 [`scripts/capture-shots.js`](../../scripts/capture-shots.js) 生成，跑一次：

```bash
npm run docs:shots
```

脚本起一个临时 Electron，用假会话日志喂数据，连 CDP 按固定视口 1180×860、`deviceScaleFactor: 2` 截图，写到本目录。明暗主题通过 `#theme-switch` 切换；用的是临时 `CODEX_HOME` 和假 token，不会碰到真实 `~/.codex` 数据。

| 文件 | 内容 | README 用处 |
| --- | --- | --- |
| `dashboard-light.png` | 完整看板 · 月之亮面 | Hero（亮色）、Features 图库 |
| `dashboard-dark.png` | 完整看板 · 月之暗面 | Hero 的 `<picture>` 暗色分支、Features 图库 |
| `popover.png` | 托盘弹窗：额度、今日用量、花费与签到入口 | Features 图库 |
| `dashboard-hours.png` | 活跃时段：24 小时 × 用量 / tok/s | Features 图库 |
| `auth-panel.png` | 实时额度 / OAuth 设备码授权面板 | Features 图库 |

这些图是随 UI 变化的产物：改了界面就重跑脚本更新，不要手工往这里塞图。打包前统一生成；仓库里不提交真实账号或真实用量截图。
