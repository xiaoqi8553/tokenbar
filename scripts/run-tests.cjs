"use strict";

/**
 * 跨平台测试入口：显式枚举 tests/*.test.js 后交给 node --test。
 *
 * 为什么需要它：package.json 原来写的是 `node --test tests/*.test.js`，
 * 通配符依赖 shell 展开。本地 Git Bash 会展开，但 GitHub Actions 的 Windows
 * runner 默认用 PowerShell —— 它不展开 glob，Node 收到字面量
 * "tests/*.test.js"，于是整条 CI 在「Run unit tests」步骤直接失败。
 * 这里用 Node 自己枚举文件，任何 shell 下行为完全一致。
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const testsDir = path.join(root, "tests");
const files = fs.readdirSync(testsDir)
  .filter(name => name.endsWith(".test.js"))
  .sort()
  .map(name => path.join(testsDir, name));

if (!files.length) {
  console.error("[run-tests] tests/ 下没有找到任何 .test.js");
  process.exit(1);
}

const result = spawnSync(process.execPath, ["--test", ...files], {
  cwd: root,
  stdio: "inherit"
});

if (result.error) {
  console.error("[run-tests] 启动测试进程失败：", result.error);
  process.exit(1);
}
process.exit(result.status === null ? 1 : result.status);
