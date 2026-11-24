"use strict";

/**
 * 3.0 W4 A-E2E：产物清单、构建白名单与隐私守门。
 * 与 scripts/verify-artifact.cjs 互补：这里从测试侧再锁一次，防止守门脚本被绕过。
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const assert = require("node:assert/strict");
const { test } = require("node:test");

const root = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "scripts/artifact-manifest.json"), "utf8"));
const sha256 = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

function walk(dir, base = "") {
  let out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? base + "/" + entry.name : entry.name;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out = out.concat(walk(abs, rel));
    else if (/\.(cjs|html)$/.test(entry.name)) out.push(rel);
  }
  return out;
}

test("artifact-manifest version 3，必需文件齐全且哈希均非空", () => {
  assert.equal(manifest.version, 3);
  assert.equal(manifest.target, "source");
  assert.ok(manifest.files && typeof manifest.files === "object");

  const required = [
    "package.json", "desktop/main.cjs", "desktop/preload.cjs",
    "desktop/popover.html", "desktop/dashboard.html", "desktop/dashboard-preload.cjs",
    "desktop/data/codex-store.cjs", "desktop/data/codex-auth-store.cjs",
    "desktop/data/event-dedupe.cjs", "desktop/core/logger.cjs",
    "desktop/core/error-boundary.cjs", "desktop/core/windows.cjs",
    "desktop/core/ipc/popover.cjs", "desktop/core/ipc/dashboard.cjs",
    "desktop/core/ipc/auth.cjs", "README.md", "CHANGELOG.md"
  ];
  for (const file of required) {
    assert.ok(file in manifest.files, "清单缺少必需文件：" + file);
  }
  assert.ok(Object.keys(manifest.files).length >= 16);

  for (const [file, hash] of Object.entries(manifest.files)) {
    assert.equal(typeof hash, "string", file + " 的哈希不是字符串");
    assert.notEqual(hash.trim(), "", file + " 的哈希不能为空");
    assert.match(hash, /^[0-9a-f]{64}$/, file + " 的哈希不是 sha256");
  }
});

test("manifest 每个哈希与当前源码逐文件一致", () => {
  for (const [rel, expected] of Object.entries(manifest.files)) {
    const abs = path.join(root, rel);
    assert.ok(fs.existsSync(abs), "清单登记的文件不存在：" + rel);
    assert.equal(sha256(abs), expected, "清单哈希与实际源码不符：" + rel);
  }
});

test("verify-artifact.cjs --source 退出码 0 且输出 OK", () => {
  const result = spawnSync(process.execPath,
    [path.join(root, "scripts/verify-artifact.cjs"), "--source"],
    { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0,
    "verify-artifact 失败：" + (result.stderr || result.stdout).slice(0, 600));
  assert.match(result.stdout, /\[verify-artifact\] OK/);
  assert.doesNotMatch(result.stderr, /缺少必需文件|敏感字面量|manifest 不一致/);
});

test("desktop 生产源码不含明文 API key / Bearer token / 真实邮箱", () => {
  const files = walk(path.join(root, "desktop"));
  assert.ok(files.length >= 20, "扫描范围异常：" + files.length);

  const apiKey = /sk-[A-Za-z0-9]{16,}/;
  const bearer = /Bearer\s+eyJ[A-Za-z0-9._-]{20,}/;
  const email = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

  for (const rel of files) {
    const text = fs.readFileSync(path.join(root, "desktop", rel), "utf8");
    assert.equal(apiKey.test(text), false, rel + " 含明文 OpenAI API key");
    assert.equal(bearer.test(text), false, rel + " 含明文 Bearer token");

    const realEmails = (text.match(email) || [])
      .filter(value => !/@(example\.(com|net|org)|test\.(com|net|org))$/i.test(value));
    assert.deepEqual(realEmails, [], rel + " 含非 fixture 邮箱：" + realEmails.join(", "));
  }
});

test("builder.config.cjs 打包白名单包含 3.0 core/** 与 data/**", () => {
  const config = require("../desktop/builder.config.cjs");
  assert.ok(Array.isArray(config.files));
  for (const entry of [
    "desktop/main.cjs", "desktop/core/**", "desktop/preload.cjs",
    "desktop/popover.html", "desktop/dashboard.html", "desktop/dashboard-preload.cjs",
    "desktop/data/**", "package.json"
  ]) {
    assert.ok(config.files.includes(entry), "打包白名单缺少 " + entry);
  }
  assert.equal(config.asar, false, "3.0 继续用非 asar 目录布局");
});
