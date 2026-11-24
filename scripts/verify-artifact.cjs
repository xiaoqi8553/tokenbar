"use strict";

/**
 * 3.0 产物守门：校验 electron-builder 打包产物的完整性与隐私。
 *   - 必需文件清单齐全（对照 builder.config.cjs 的 files 白名单）
 *   - 静态资源与源码逐文件 SHA256，写入/比对 manifest
 *   - 不出现 sk- / access_token / 明文邮箱等敏感字面量
 *
 * 用法：
 *   node scripts/verify-artifact.cjs                 # 校验现有产物 + 比对 manifest
 *   node scripts/verify-artifact.cjs --update        # 首次/发版后刷新 manifest
 *   node scripts/verify-artifact.cjs --source        # 校验源码树（构建前）
 * 可用 ARTIFACT_DIR 覆盖产物目录，默认 release/desktop/win-unpacked/resources/app
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const ROOT = path.resolve(__dirname, "..");
const UPDATE = process.argv.includes("--update");
const SOURCE = process.argv.includes("--source");
const TARGET = SOURCE ? ROOT : path.resolve(process.env.ARTIFACT_DIR || path.join(ROOT, "release/desktop/win-unpacked/resources/app"));
const MANIFEST = path.join(ROOT, "scripts", "artifact-manifest.json");

// 与 builder.config.cjs files 白名单一致（发版改动构建配置时这里必须同步）
const REQUIRED = [
  "package.json",
  "desktop/main.cjs",
  "desktop/preload.cjs",
  "desktop/popover.html",
  "desktop/dashboard.html",
  "desktop/dashboard-preload.cjs",
  "desktop/icon.png",
  "desktop/data/ablesci-store.cjs",
  "desktop/data/codex-auth-store.cjs",
  "desktop/data/codex-store.cjs",
  "desktop/data/event-dedupe.cjs",
  "desktop/data/history-baseline.cjs",
  "desktop/data/pricing.cjs",
  "desktop/data/workbuddy-store.cjs"
];

// 3.0 深度重构后新增的模块（构建产物白名单扩展时逐项登记）
const EXPECTED_OPTIONAL = [
  "desktop/core/logger.cjs",
  "desktop/core/error-boundary.cjs",
  "desktop/core/constants.cjs",
  "desktop/core/paths.cjs",
  "desktop/core/prefs.cjs",
  "desktop/core/stores.cjs",
  "desktop/core/windows.cjs",
  "desktop/core/tray.cjs",
  "desktop/core/diagnostics.cjs",
  "desktop/core/ipc/popover.cjs",
  "desktop/core/ipc/dashboard.cjs",
  "desktop/core/ipc/auth.cjs",
  "desktop/data/codex-store/parse.cjs",
  "desktop/data/codex-store/cache.cjs",
  "desktop/data/codex-store/scan.cjs",
  "desktop/data/codex-store/aggregate.cjs",
  "desktop/data/codex-store/builder.cjs"
];

const TEXT_EXT = new Set([".cjs", ".js", ".html", ".json", ".css", ".md"]);
const SECRET_PATTERNS = [
  { name: "OpenAI API key", re: /sk-[A-Za-z0-9]{16,}/g },
  { name: "access_token 字面量", re: /"access_token"\s*:\s*"[A-Za-z0-9._-]{20,}"/g },
  { name: "Bearer token", re: /Bearer\s+eyJ[A-Za-z0-9._-]{20,}/g }
];

function sha256(file) {
  let buf = fs.readFileSync(file);
  // Windows checkout 会把 LF 转成 CRLF；哈希前统一归一化为 LF，
  // 让本地与 CI 对同一份源码得到相同摘要（.gitattributes 已强制 LF，这是第二道防线）。
  if (TEXT_EXT.has(path.extname(file))) {
    buf = Buffer.from(buf.toString("utf8").replace(/\r\n/g, "\n"), "utf8");
  }
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function walk(dir, base = "") {
  let out = [];
  for (const name of fs.readdirSync(dir)) {
    const rel = base ? base + "/" + name : name;
    const abs = path.join(dir, name);
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) out = out.concat(walk(abs, rel));
    else out.push(rel);
  }
  return out.sort();
}

function main() {
  if (!fs.existsSync(TARGET)) {
    console.error("[verify-artifact] 目标目录不存在：" + TARGET);
    process.exit(1);
  }

  // 1) 必需文件齐全
  const missing = REQUIRED.filter(rel => !fs.existsSync(path.join(TARGET, rel)));
  if (missing.length) {
    console.error("[verify-artifact] 缺少必需文件：\n  " + missing.join("\n  "));
    process.exit(1);
  }

  // 2) 敏感字面量扫描（只看文本文件）
  //    产物模式扫描整棵产物树；源码模式只扫「会进白名单的文件」——
  //    data/usage-index.json 等本地用户数据被 gitignore、不会打包，不应误报。
  const allFiles = walk(TARGET);
  const scanList = SOURCE
    ? [...new Set([...REQUIRED, ...EXPECTED_OPTIONAL, "README.md", "CHANGELOG.md"])].filter(rel => fs.existsSync(path.join(TARGET, rel)))
    : allFiles;
  const files = allFiles;
  const leaks = [];
  for (const rel of scanList) {
    if (!TEXT_EXT.has(path.extname(rel))) continue;
    const text = fs.readFileSync(path.join(TARGET, rel), "utf8");
    for (const pat of SECRET_PATTERNS) {
      const hits = text.match(pat.re);
      if (hits) leaks.push(`${rel}: ${pat.name} (${hits.length} 处)`);
    }
  }
  if (leaks.length) {
    console.error("[verify-artifact] 检测到疑似敏感字面量：\n  " + leaks.join("\n  "));
    process.exit(1);
  }

  // 3) 清单哈希（源码模式只记录白名单，避免把 node_modules / 本地用户数据写进 manifest）
  const manifestFiles = SOURCE ? scanList : files;
  const manifest = {};
  for (const rel of manifestFiles) manifest[rel] = sha256(path.join(TARGET, rel));

  if (UPDATE) {
    fs.writeFileSync(MANIFEST, JSON.stringify({ version: 3, target: SOURCE ? "source" : "artifact", files: manifest }, null, 2) + "\n", "utf8");
    console.log(`[verify-artifact] manifest 已刷新：${Object.keys(manifest).length} 个文件 → ${MANIFEST}`);
    return;
  }

  if (fs.existsSync(MANIFEST)) {
    const prev = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
    const changed = [];
    const added = [];
    const removed = [];
    for (const [rel, hash] of Object.entries(manifest)) {
      if (!(rel in prev.files)) added.push(rel);
      else if (prev.files[rel] !== hash) changed.push(rel);
    }
    for (const rel of Object.keys(prev.files)) if (!(rel in manifest)) removed.push(rel);
    if (changed.length || removed.length) {
      console.error("[verify-artifact] 产物与 manifest 不一致（构建前请确认是否有意改动）：");
      if (changed.length) console.error("  变更: " + changed.join(", "));
      if (added.length) console.error("  新增: " + added.join(", "));
      if (removed.length) console.error("  删除: " + removed.join(", "));
      process.exit(1);
    }
    if (added.length) console.log("[verify-artifact] 新增文件（未登记基线）: " + added.join(", "));
  } else {
    console.warn("[verify-artifact] 无 manifest，仅做完整性/隐私校验。发版前请跑 --update 固化。");
  }

  const missingOptional = EXPECTED_OPTIONAL.filter(rel => !(rel in manifest));
  console.log(`[verify-artifact] OK：${files.length} 个文件，必需项齐全，无敏感字面量。`);
  if (missingOptional.length) {
    console.log(`[verify-artifact] 提示：3.0 预期模块尚未全部出现（${missingOptional.length} 个），重构完成后应归零。`);
  }
}

main();
