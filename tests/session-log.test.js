"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = file => fs.readFileSync(path.join(root, file), "utf8");
const dashboard = read("desktop/dashboard.html");
const codexStore = read("desktop/data/codex-store.cjs");
const workbuddyStore = read("desktop/data/workbuddy-store.cjs");
const { CodexStore } = require(path.join(root, "desktop", "data", "codex-store.cjs"));
const { WorkBuddyStore } = require(path.join(root, "desktop", "data", "workbuddy-store.cjs"));
const { signatureOf } = require(path.join(root, "desktop", "data", "event-dedupe.cjs"));

const DAY = "2026-07-24";

function ev(input, output, model, hour = 10, cached = 0) {
  return {
    s: signatureOf(input, cached, output, input + output, 0),
    i: input,
    c: cached,
    o: output,
    r: 0,
    t: input + output,
    d: DAY,
    h: hour,
    m: model
  };
}

/** 伪造 createDetailBuilder 产出的 detail，events 会由 effectiveDetail 重建聚合桶 */
function makeDetail(file, sessionId, events) {
  const firstAt = "2026-07-24T10:00:00.000Z";
  return {
    file,
    sessionId,
    firstAt,
    lastAt: firstAt,
    project: "demo",
    cwd: "E:/论文/demo",
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

test("2.3.2 Codex 会话按模型逐行输出完整明细，成本与用量都能对上", () => {
  const store = new CodexStore({ pricing: {}, baseline: null });
  store.detailFiles.set("a.jsonl", {
    size: 1,
    mtimeMs: 1,
    detail: makeDetail("a.jsonl", "s1", [
      ev(800, 200, "gpt-5.5"),                 // 1000
      ev(300, 100, "gpt-6.1-sol", 10, 100),   // 400，含 100 缓存命中
      ev(100, 20, "gpt-6.1-sol", 11)          // 120，同模型第二条
    ])
  });

  const snap = store.detailSnapshot();
  const session = snap.sessionList.find(item => item.sessionId === "s1");
  assert.ok(session, "找到会话");
  assert.equal(session.modelDetails.length, 2);
  // 按用量降序：会话表里第一个 chip 就是主要模型
  assert.deepEqual(session.models, ["gpt-5.5", "gpt-6.1-sol"]);
  assert.equal(session.modelDetails[0].totalTokens, 1000);
  assert.equal(session.modelDetails[0].records, 1);
  assert.equal(session.modelDetails[1].totalTokens, 520);
  assert.equal(session.modelDetails[1].records, 2);
  assert.equal(session.modelDetails[1].cachedInputTokens, 100);

  const tokenSum = session.modelDetails.reduce((acc, item) => acc + item.totalTokens, 0);
  assert.equal(tokenSum, session.totalTokens, "模型行合计 = 会话用量");
  const costSum = session.modelDetails.reduce((acc, item) => acc + item.cost, 0);
  assert.ok(Math.abs(costSum - session.cost) < 1e-9, "模型行花费合计 = 会话花费");
});

test("2.3.2 WorkBuddy 会话同样带模型逐行明细", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tokenbar-session-log-"));
  const dir = path.join(home, "projects", "ws");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date(2026, 9, 30, 10, 0, 0).getTime();
  const line = (model, input, output, trace) => JSON.stringify({
    type: "message",
    timestamp: stamp,
    cwd: "E:/论文/ws",
    sessionId: "wb-1",
    providerData: {
      traceId: trace,
      stepSeq: 1,
      model,
      usage: { inputTokens: input, outputTokens: output, totalTokens: input + output }
    }
  });
  fs.writeFileSync(
    path.join(dir, "wb-1.jsonl"),
    [line("model-a", 900, 100, "t1"), line("model-b", 200, 50, "t2"), line("model-b", 100, 20, "t3")].join("\n") + "\n"
  );

  const snap = await new WorkBuddyStore({ roots: [home] }).build();
  const session = snap.sessionList[0];
  assert.equal(session.modelDetails.length, 2);
  assert.deepEqual(session.models, ["model-a", "model-b"]);
  assert.equal(session.modelDetails[1].records, 2);
  assert.equal(
    session.modelDetails.reduce((acc, item) => acc + item.totalTokens, 0),
    session.totalTokens
  );

  fs.rmSync(home, { recursive: true, force: true });
});

test("2.3.2 会话表不再折叠模型，新增 CC Switch 式请求明细视图", () => {
  // 旧写法：只显示第一个模型 + 「+N」，正是这次要去掉的
  assert.doesNotMatch(dashboard, /models\.length > 1 \? ' <span class="muted">\+'/);
  assert.doesNotMatch(dashboard, /models\.length - 1/);
  assert.match(dashboard, /class="model-chips"/);
  assert.match(dashboard, /td\.model-cell, th\.model-col \{ white-space: normal; \}/);
  assert.match(dashboard, /width: 230px">模型/);

  // 两个视图 + 行内展开
  assert.match(dashboard, /id="session-tabs"/);
  assert.match(dashboard, /data-view="requests"/);
  assert.match(dashboard, /id="log-table"/);
  assert.match(dashboard, /function renderLog\(\)/);
  assert.match(dashboard, /function sessionDetailHtml\(/);
  assert.match(dashboard, /tr\.session-row/);
  assert.match(dashboard, /新增输入/);
  assert.match(dashboard, /缓存命中/);
  assert.match(dashboard, /logView: localStorage\.getItem\("codex\.logView"\)/);

  assert.match(codexStore, /modelDetails/);
  assert.match(workbuddyStore, /modelDetails/);
});
