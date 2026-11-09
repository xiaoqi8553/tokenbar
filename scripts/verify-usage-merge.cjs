#!/usr/bin/env node
"use strict";

/**
 * 校验「累计」口径：按请求指纹去重后，磁盘日志与历史索引的合并结果是否合理。
 *
 * v3 起历史索引自身先按请求指纹去重（fork/resume 的 replay 历史不再重复计入），
 * 明细扫描再以同一批签名打底，跳过磁盘上重复的那一份，两边相加得到最终累计。
 * 快扫 / 全量扫描只做相邻重复快照去重，与历史索引仍按天取大者，是明细就绪前
 * 的过渡口径，因此允许与明细有小额差额；明细才是界面最终显示的数字，且明细
 * 就绪后 snapshot() 会复用它的日聚合，弹窗与看板必须完全一致。
 *
 * 如果结果明显小于索引总量，说明合并没有生效（例如 baseline 读失败），
 * 界面上就会退回「只看磁盘日志」的偏小数字。
 *
 * 用法：
 *   node scripts/verify-usage-merge.cjs
 *   node scripts/verify-usage-merge.cjs --index <usage-index.json> --sessions <sessions 目录>
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const { CodexStore } = require(path.join(ROOT, "desktop", "data", "codex-store.cjs"));
const { buildBaseline } = require(path.join(ROOT, "desktop", "data", "history-baseline.cjs"));

function argOf(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  return process.argv[index + 1] || fallback;
}

function fmt(n) {
  const value = Number(n) || 0;
  if (value >= 1e9) return `${(value / 1e9).toFixed(3)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return String(Math.round(value));
}

async function main() {
  const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  const currentIndex = path.join(appData, "TokenBar", "data", "usage-index.json");
  const legacyIndex = path.join(appData, "codex-token-dashboard", "data", "usage-index.json");
  // v2.0.0 改名后 userData 迁到 TokenBar，旧目录只作为兼容回退
  const defaultIndex = fs.existsSync(currentIndex) ? currentIndex : legacyIndex;
  const indexPath = argOf("--index", defaultIndex);
  const sessionsDir = argOf("--sessions", path.join(os.homedir(), ".codex", "sessions"));

  if (!fs.existsSync(indexPath)) {
    console.error(`找不到旧版索引：${indexPath}`);
    console.error("如果这台机器没跑过旧版网页看板，合并不会生效，累计就只能反映磁盘上剩下的日志。");
    process.exit(2);
  }
  if (!fs.existsSync(sessionsDir)) {
    console.error(`找不到 sessions 目录：${sessionsDir}`);
    process.exit(2);
  }

  const startedAt = Date.now();
  const baseline = buildBaseline(indexPath);
  const baselineDays = Object.keys(baseline.days).length;
  const baselineSessions = Object.keys(baseline.sessions).length;
  console.log(`历史索引  ${fmt(baseline.totalTokens)}  ${baseline.records} 条 / ${baselineDays} 天 / ${baselineSessions} 会话`);
  if (baseline.duplicates) {
    console.log(`          请求去重：扫过 ${baseline.scannedRecords} 条，剔除 replay 重复 ${baseline.duplicates} 条 / ${fmt(baseline.duplicateTokens)}`);
  }
  console.log(`          ${indexPath}`);
  console.log(`          构建耗时 ${Date.now() - startedAt}ms`);

  const store = new CodexStore({
    sessionsDir,
    cacheFile: path.join(os.tmpdir(), "codex-verify-usage-cache.json"),
    detailCacheFile: path.join(os.tmpdir(), "codex-verify-usage-detail.json"),
    baseline
  });

  await store.init({ full: false });
  const fast = store.snapshot();
  console.log(`快速扫描  ${fmt(fast.totals.totalTokens)}  ${fast.totals.records} 条（只扫最近若干文件，启动瞬间用）`);

  const full = await store.buildFull();
  console.log(`全量扫描  ${fmt(full.totals.totalTokens)}  ${full.totals.records} 条（明细就绪前的过渡值，不参与断言）`);

  const detail = await store.buildDetail();
  console.log(`看板明细  ${fmt(detail.totals.totalTokens)}  ${detail.totals.records} 条 / ${detail.series.length} 天 / ${detail.sessions} 会话`);

  // 明细就绪后 snapshot() 会改用同一份日聚合，弹窗与看板必须显示同一个累计。
  const popover = store.snapshot();
  const delta = full.totals.totalTokens - baseline.totalTokens;
  const finalDelta = detail.totals.totalTokens - baseline.totalTokens;
  const transitional = Math.abs(full.totals.totalTokens - detail.totals.totalTokens);
  const diff = Math.abs(popover.totals.totalTokens - detail.totals.totalTokens);

  console.log("");
  console.log(`过渡扫描 - 索引 = ${fmt(delta)}（索引构建之后新增的用量，正常应为较小的正数）`);
  console.log(`明细 - 索引     = ${fmt(finalDelta)}（去重后磁盘日志相对基线的净新增）`);
  console.log(`过渡差额        = ${fmt(transitional)}（快扫按天取大者 / 只去相邻重复，允许与明细有小额差异）`);
  console.log(`弹窗 - 看板     = ${fmt(diff)}（明细就绪后两条路径共用同一份日聚合，必须为 0）`);

  const problems = [];
  if (full.totals.totalTokens < baseline.totalTokens) {
    problems.push("过渡扫描总量小于索引总量：baseline 未生效，首屏会显示偏小的数字");
  }
  if (delta > baseline.totalTokens * 0.5) {
    problems.push("过渡扫描比索引多出超过 50%：可能存在重复计入");
  }
  if (detail.totals.totalTokens < baseline.totalTokens) {
    problems.push("明细总量小于索引总量：历史基线没有并入，累计会偏小");
  }
  if (diff > 0) {
    problems.push("弹窗与看板口径不一致：明细就绪后 snapshot() 未复用明细的日聚合");
  }

  if (problems.length) {
    console.error("");
    for (const item of problems) console.error(`✗ ${item}`);
    process.exit(1);
  }
  console.log("");
  console.log("✓ 口径一致");
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
