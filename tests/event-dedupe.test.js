"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { signatureOf, usageSignature, recordSignature } = require("../desktop/data/event-dedupe.cjs");
const { buildBaseline } = require("../desktop/data/history-baseline.cjs");
const { CodexStore } = require("../desktop/data/codex-store.cjs");

const DAY = "2026-07-24";

function ev(input, output, day = DAY, hour = 10, model = "gpt-5") {
  return {
    s: signatureOf(input, 0, output, input + output, 0),
    i: input,
    c: 0,
    o: output,
    r: 0,
    t: input + output,
    d: day,
    h: hour,
    m: model
  };
}

/** 伪造一份 createDetailBuilder 产出的 detail（events 由 effectiveDetail 重建聚合桶） */
function makeDetail(file, sessionId, firstAt, events) {
  return {
    file,
    sessionId,
    firstAt,
    lastAt: firstAt,
    project: "demo",
    cwd: null,
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

function storeWith(details, baseline = null) {
  const store = new CodexStore({ pricing: {}, baseline });
  details.forEach((detail, index) => {
    store.detailFiles.set(detail.file, { size: index + 1, mtimeMs: index + 1, detail });
  });
  return store;
}

function writeIndex(records) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-dedupe-"));
  const file = path.join(dir, "usage-index.json");
  fs.writeFileSync(file, JSON.stringify({ version: 21, records }, null, 2), "utf8");
  return { dir, file };
}

function record(input, output, overrides = {}) {
  return {
    timestamp: "2026-07-24T10:00:00.000Z",
    date: DAY,
    sessionId: "s1",
    model: "gpt-5",
    projectName: "demo",
    inputTokens: input,
    cachedInputTokens: 0,
    outputTokens: output,
    totalTokens: input + output,
    reasoningOutputTokens: 0,
    ...overrides
  };
}

test("磁盘日志与旧索引对同一请求算出同一个指纹", () => {
  const fromLog = usageSignature({
    input_tokens: 79695,
    cached_input_tokens: 77568,
    output_tokens: 184,
    total_tokens: 79879,
    reasoning_output_tokens: 54
  });
  const fromIndex = recordSignature({
    inputTokens: 79695,
    cachedInputTokens: 77568,
    outputTokens: 184,
    totalTokens: 79879,
    reasoningOutputTokens: 54
  });
  assert.equal(fromLog, fromIndex);
  assert.equal(fromLog, "79695:77568:184:79879:54");
});

test("历史基线按请求指纹去重，并留下签名集合供日志侧跳过", () => {
  const original = record(800, 200);
  const replay = record(800, 200, { sessionId: "s2", filePath: "fork-copy.jsonl", lineNumber: 99 });
  const fresh = record(400, 100);
  const { dir, file } = writeIndex([original, replay, fresh]);

  const baseline = buildBaseline(file);
  const day = baseline.days[DAY];

  assert.equal(day.totalTokens, 1500, "fork 重放的 1000 只算一次");
  assert.equal(day.records, 2);
  assert.equal(baseline.records, 2);
  assert.equal(baseline.scannedRecords, 3);
  assert.equal(baseline.duplicates, 1);
  assert.equal(baseline.duplicateTokens, 1000);
  assert.equal(baseline.signatures.length, 2);
  assert.ok(baseline.signatures.includes(recordSignature(original)));
  assert.equal(baseline.totalTokens, 1500);
  assert.equal(baseline.hourTokens, 1500);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("fork 的两个 rollout 文件共享前缀时，公共请求只计一次", () => {
  const original = ev(1000, 100);
  const second = ev(2000, 200);
  const forkNew = ev(3000, 300);

  const store = storeWith([
    makeDetail("b-fork.jsonl", "s2", "2026-07-24T12:00:00Z", [original, forkNew]),
    makeDetail("a-origin.jsonl", "s1", "2026-07-24T10:00:00Z", [original, second])
  ]);

  const snap = store.detailSnapshot();
  // 1100 + 2200 + 3300，重放的 original 不再重复
  assert.equal(snap.totals.totalTokens, 6600);
  assert.equal(snap.totals.records, 3);
  assert.equal(snap.series.find(item => item.day === DAY).totalTokens, 6600);
  assert.equal(snap.sessionList.length, 2);
});

test("基线已记过的请求，磁盘日志侧跳过，两边相加而非取大者", () => {
  const shared = ev(1000, 100);
  const diskOnly = ev(2000, 200);
  const bucket = {
    totalTokens: 1100,
    inputTokens: 1000,
    cachedInputTokens: 0,
    outputTokens: 100,
    reasoningOutputTokens: 0,
    records: 1
  };
  const baseline = {
    version: 3,
    records: 1,
    totalTokens: 1100,
    signatures: [shared.s],
    days: {
      [DAY]: {
        ...bucket,
        hours: new Array(24).fill(0),
        models: { "gpt-5": { ...bucket } },
        sessions: { legacy: { ...bucket, project: "历史索引", models: {} } }
      }
    },
    sessions: {
      legacy: { ...bucket, project: "历史索引", firstAt: null, lastAt: null, models: {} }
    },
    models: {}
  };

  const store = storeWith(
    [makeDetail("disk.jsonl", "s1", "2026-07-24T10:00:00Z", [shared, diskOnly])],
    baseline
  );
  const snap = store.detailSnapshot();

  // 1100（基线） + 2200（磁盘新增），不是 max(1100, 3300) 也不是 4400
  assert.equal(snap.totals.totalTokens, 3300);
  assert.equal(snap.series.find(item => item.day === DAY).totalTokens, 3300);
});

test("文件内相邻重复快照也只计一次", () => {
  const once = ev(1000, 100);
  const store = storeWith([
    makeDetail("dup.jsonl", "s1", "2026-07-24T10:00:00Z", [once, { ...once }])
  ]);
  // createDetailBuilder 产出的 events 已做文件内去重；这里再验证 effectiveDetail
  // 对残留的重复签名同样只保留一条
  assert.equal(store.detailSnapshot().totals.totalTokens, 1100);
});

test("源码不再用「按天取大者」覆盖历史，改为去重后相加", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "desktop", "data", "codex-store.cjs"),
    "utf8"
  );
  assert.match(source, /new Set\(\s*this\.baseline && Array\.isArray\(this\.baseline\.signatures\)/);
  assert.match(source, /effectiveDetail\(entry\.detail, globalSeen\)/);
  assert.match(source, /logDay\.totalTokens \+= baseDay\.totalTokens/);
  assert.doesNotMatch(source, /const useBaseline = !logDay/);
});

/** 造一份 v3 基线：一条已计入的请求 + 当天的模型 / 小时 / 会话桶 */
function baselineWith(signature) {
  const bucket = {
    totalTokens: 1100,
    inputTokens: 1000,
    cachedInputTokens: 0,
    outputTokens: 100,
    reasoningOutputTokens: 0,
    records: 1
  };
  return {
    version: 3,
    records: 1,
    totalTokens: 1100,
    signatures: [signature],
    days: {
      [DAY]: {
        ...bucket,
        hours: new Array(24).fill(0),
        models: { "gpt-5": { ...bucket } },
        sessions: {}
      }
    },
    sessions: {},
    models: {}
  };
}

test("明细就绪后弹窗与看板累计完全一致", () => {
  const shared = ev(1000, 100);
  const diskOnly = ev(2000, 200);
  const store = storeWith(
    [
      makeDetail("b-fork.jsonl", "s2", "2026-07-24T12:00:00Z", [shared]),
      makeDetail("a-origin.jsonl", "s1", "2026-07-24T10:00:00Z", [shared, diskOnly])
    ],
    baselineWith(shared.s)
  );

  const detail = store.detailSnapshot();
  const popover = store.snapshot();

  assert.equal(detail.totals.totalTokens, 3300);
  assert.equal(popover.totals.totalTokens, detail.totals.totalTokens);
  assert.equal(popover.totals.records, detail.totals.records);
  assert.equal(popover.series.length, 14, "弹窗的 14 天迷你柱图也取自同一份日聚合");
});

test("弹窗过渡花费也按请求指纹去重，与明细花费同口径", () => {
  const shared = ev(1000, 100);
  const diskOnly = ev(2000, 200);
  const baseline = baselineWith(shared.s);
  const store = storeWith(
    [
      makeDetail("b-fork.jsonl", "s2", "2026-07-24T12:00:00Z", [shared]),
      makeDetail("a-origin.jsonl", "s1", "2026-07-24T10:00:00Z", [shared, diskOnly])
    ],
    baseline
  );

  const transitional = store.costSummary();
  const detail = store.detailSnapshot();

  assert.ok(transitional && transitional.cny > 0);
  // 若过渡路径漏了去重，fork 的 1100 会再算一次，金额必然高于明细
  assert.ok(
    Math.abs(transitional.cny - detail.totals.cost) < 1e-6,
    `过渡花费 ${transitional.cny} 应等于明细花费 ${detail.totals.cost}`
  );
});
