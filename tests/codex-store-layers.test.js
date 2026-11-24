"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const dataDir = path.join(__dirname, "..", "desktop", "data");
const { CodexStore } = require(path.join(dataDir, "codex-store.cjs"));
const parse = require(path.join(dataDir, "codex-store", "parse.cjs"));
const cache = require(path.join(dataDir, "codex-store", "cache.cjs"));
const scan = require(path.join(dataDir, "codex-store", "scan.cjs"));
const aggregate = require(path.join(dataDir, "codex-store", "aggregate.cjs"));
const builder = require(path.join(dataDir, "codex-store", "builder.cjs"));

const LAYERS = {
  parse: ["effectiveDetail", "normalizeRateLimits", "parseTokenCountLine", "zeroBucket"],
  cache: ["loadCache", "saveCache", "clearCache", "loadDetailCache", "saveDetailCache"],
  scan: ["listSessionFiles", "ingestFile", "scanFileDetail", "createDetailBuilder"],
  aggregate: ["mergedDay", "bucketsSince", "totals", "costSummary", "detailSnapshot", "snapshot"],
  builder: ["buildFast", "buildFull", "buildDetail", "init", "refresh"]
};

test("5 个分层模块齐备、职责函数齐全且不反向依赖 facade", () => {
  const modules = { parse, cache, scan, aggregate, builder };
  for (const [name, exports] of Object.entries(modules)) {
    for (const fn of LAYERS[name]) assert.equal(typeof exports[fn], "function", `${name}.${fn}`);
    const src = fs.readFileSync(path.join(dataDir, "codex-store", `${name}.cjs`), "utf8");
    assert.doesNotMatch(src, /require\(["']\.\.\/codex-store\.cjs["']\)/, `${name} 不得 require facade`);
  }
  // facade 重新导出的工具函数与常量必须来自 parse 层
  assert.equal(CodexStore.name, "CodexStore");
  assert.equal(parse.CACHE_VERSION, 4);
  assert.equal(parse.DETAIL_CACHE_VERSION, 7);
});

const TOKEN_LINE = JSON.stringify({
  timestamp: "2026-07-24T10:00:00.000Z",
  payload: {
    type: "token_count",
    info: { last_token_usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 } }
  }
});

test("createDetailBuilder 是独立工厂：多实例文件内去重互不串", () => {
  const a = scan.createDetailBuilder({}, "a.jsonl");
  const b = scan.createDetailBuilder({}, "b.jsonl");
  a.feed(TOKEN_LINE);
  b.feed(TOKEN_LINE);
  assert.equal(a.finish().events.length, 1);
  assert.equal(b.finish().events.length, 1);
});

function detailOf(totalTokens) {
  return {
    file: "x.jsonl",
    sessionId: "s-x",
    firstAt: "2026-07-24T10:00:00.000Z",
    lastAt: "2026-07-24T10:00:00.000Z",
    project: "demo",
    cwd: null,
    // effectiveDetail 会按 events 重建 tokens/models/modelDays/days/hours
    events: [{ s: `sig-${totalTokens}`, i: totalTokens, c: 0, o: 0, r: 0, t: totalTokens, d: "2026-07-24", h: 10, m: "model-a" }],
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

test("aggregate 函数显式接收 store：两个实例的明细状态完全隔离", () => {
  const a = new CodexStore({ pricing: {}, baseline: null });
  const b = new CodexStore({ pricing: {}, baseline: null });
  a.detailFiles.set("x.jsonl", { size: 1, mtimeMs: 1, detail: detailOf(150) });

  assert.equal(aggregate.detailSnapshot(a).totals.totalTokens, 150);
  assert.equal(a.detailSnapshot().totals.totalTokens, 150, "facade 委托结果与直接调用模块一致");
  assert.equal(aggregate.detailSnapshot(b).totals.totalTokens, 0, "另一实例不受影响");
  assert.notEqual(a._detailDays, b._detailDays);
});
