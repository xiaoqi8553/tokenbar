"use strict";

/**
 * 3.0 M1 基线守护：把 detailSnapshot()/snapshot() 的全量输出冻结为黄金快照。
 * 深度重构（codex-store 分层、main/dashboard 拆分）前后用同一份假日志对比，
 * 保证「同样的数字」——任何 token / 成本 / 分布口径的变化都会让这个测试失败。
 *
 * 有意更新基线：GOLDEN_UPDATE=1 node --test tests/baseline-golden.test.js
 * 正常校验：直接 npm test（只读对比，不写文件）。
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { CodexStore } = require("../desktop/data/codex-store.cjs");
const { signatureOf } = require("../desktop/data/event-dedupe.cjs");

const GOLDEN_FILE = path.join(__dirname, "fixtures", "golden-snapshot.json");

function ev(input, output, model, day, hour = 10, cached = 0, reasoning = 0) {
  return {
    s: signatureOf(input, cached, output, input + output, reasoning),
    i: input,
    c: cached,
    o: output,
    r: reasoning,
    t: input + output,
    d: day,
    h: hour,
    m: model
  };
}

function makeDetail(file, sessionId, project, events) {
  const firstAt = "2026-07-23T08:00:00.000Z";
  return {
    file,
    sessionId,
    firstAt,
    lastAt: "2026-07-25T18:00:00.000Z",
    project,
    cwd: "E:/proj/" + project,
    source: null,
    events,
    tokens: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0, records: 0 },
    models: {},
    modelDays: {},
    days: {},
    hours: {},
    sessionTotal: 0,
    throughput: null,
    quota: null
  };
}

function buildFixtureStore() {
  const store = new CodexStore({ pricing: {}, baseline: null });
  // 三个会话、三个模型、三天；含缓存命中、reasoning、以及一条跨会话重复签名用于验证去重口径
  store.detailFiles.set("s1.jsonl", {
    size: 1, mtimeMs: 1,
    detail: makeDetail("s1.jsonl", "s1", "thesis", [
      ev(800, 200, "gpt-5.5", "2026-07-23", 8),
      ev(300, 100, "gpt-6.1-sol", "2026-07-24", 10, 100, 20),
      ev(100, 20, "gpt-5.5", "2026-07-25", 11)
    ])
  });
  store.detailFiles.set("s2.jsonl", {
    size: 2, mtimeMs: 2,
    detail: makeDetail("s2.jsonl", "s2", "codex", [
      ev(500, 150, "o3", "2026-07-24", 14, 50),
      ev(800, 200, "gpt-5.5", "2026-07-23", 8) // 与 s1 第一条重复 → 全局去重应吞掉
    ])
  });
  store.detailFiles.set("s3.jsonl", {
    size: 3, mtimeMs: 3,
    detail: makeDetail("s3.jsonl", "s3", "demo", [
      ev(50, 30, "gpt-6.1-sol", "2026-07-25", 16, 10, 5)
    ])
  });
  return store;
}

function goldenPayload() {
  const store = buildFixtureStore();
  return {
    detail: store.detailSnapshot(),
    fast: store.snapshot()
  };
}

test("3.0 M1 数据口径黄金快照：深度重构前后输出必须逐字段一致", () => {
  const actual = goldenPayload();

  if (process.env.GOLDEN_UPDATE === "1") {
    fs.mkdirSync(path.dirname(GOLDEN_FILE), { recursive: true });
    fs.writeFileSync(GOLDEN_FILE, JSON.stringify(actual, null, 2) + "\n", "utf8");
  }

  assert.ok(fs.existsSync(GOLDEN_FILE), "黄金快照文件必须存在（GOLDEN_UPDATE=1 首次生成）");
  const expected = JSON.parse(fs.readFileSync(GOLDEN_FILE, "utf8"));
  assert.deepStrictEqual(actual, expected, "数据口径发生变化：token/成本/分布/会话任何字段都不允许在零功能重构中改变");
});

test("3.0 M1 黄金快照自身稳定：同一输入两次构造结果一致（无时间戳抖动）", () => {
  assert.deepStrictEqual(goldenPayload(), goldenPayload());
});
