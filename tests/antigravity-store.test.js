"use strict";

/**
 * AntigravityStore + Antigravity 定价单元测试（全面对齐 CC Switch `session_usage_agy.rs` / `native_models.rs`）
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { pathToFileURL } = require("node:url");

const { AntigravityStore } = require("../desktop/data/antigravity-store.cjs");
const {
  modelIdOf,
  modelFromSettingsChange,
  decodeStepGenerationIndex,
  decodeGenerationMetadata,
  readGenerationsForTranscript,
  readSummariesIndex
} = require("../desktop/data/antigravity-native.cjs");
const pricing = require("../desktop/data/pricing.cjs");

// ---------------------------------------------------------------------------
// 极简 Protobuf 编码辅助（仅测试造假库用，对照 native_models.rs wire 格式）
// ---------------------------------------------------------------------------

function encodeVarint(value) {
  let v = BigInt(value);
  const bytes = [];
  while (v >= 0x80n) {
    bytes.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  bytes.push(Number(v));
  return Buffer.from(bytes);
}

function encodeFieldBytes(fieldNum, buf) {
  return Buffer.concat([encodeVarint((fieldNum << 3) | 2), encodeVarint(buf.length), buf]);
}

function encodeFieldString(fieldNum, text) {
  return encodeFieldBytes(fieldNum, Buffer.from(String(text), "utf8"));
}

function encodeFieldVarint(fieldNum, value) {
  return Buffer.concat([encodeVarint((fieldNum << 3) | 0), encodeVarint(value)]);
}

function encodeDuration(ms) {
  const sec = Math.floor(ms / 1000);
  const nanos = (ms % 1000) * 1_000_000;
  return Buffer.concat([
    sec ? encodeFieldVarint(1, sec) : Buffer.alloc(0),
    nanos ? encodeFieldVarint(2, nanos) : Buffer.alloc(0)
  ]);
}

function encodeStepMeta(generationIndex) {
  const ref = generationIndex === 0 ? Buffer.alloc(0) : encodeFieldVarint(3, generationIndex);
  return encodeFieldBytes(20, ref);
}

function encodeGenData({ base, tiered, firstTokenMs, streamingMs }) {
  const parts = [];
  if (base) parts.push(encodeFieldString(19, base));
  if (tiered) parts.push(encodeFieldString(21, tiered));
  if (firstTokenMs != null) parts.push(encodeFieldBytes(11, encodeDuration(firstTokenMs)));
  if (streamingMs != null) parts.push(encodeFieldBytes(12, encodeDuration(streamingMs)));
  return encodeFieldBytes(1, Buffer.concat(parts));
}

function writeTranscript(root, sessionId, rows) {
  const logDir = path.join(root, "brain", sessionId, ".system_generated", "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const file = path.join(logDir, "transcript_full.jsonl");
  fs.writeFileSync(file, rows.map(r => (typeof r === "string" ? r : JSON.stringify(r))).join("\n") + "\n", "utf8");
  return file;
}

function createConvDb(root, sessionId, entries) {
  const { DatabaseSync } = require("node:sqlite");
  const convDir = path.join(root, "conversations");
  fs.mkdirSync(convDir, { recursive: true });
  const dbPath = path.join(convDir, `${sessionId}.db`);
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, metadata BLOB);
    CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);
  `);
  const insStep = db.prepare("INSERT INTO steps (idx, step_type, metadata) VALUES (?, 15, ?)");
  const insGen = db.prepare("INSERT INTO gen_metadata (idx, data) VALUES (?, ?)");
  for (const e of entries) {
    insStep.run(e.step, encodeStepMeta(e.gen));
    insGen.run(e.gen, encodeGenData(e));
  }
  db.close();
  return dbPath;
}

function createSummariesDb(root, rows) {
  const { DatabaseSync } = require("node:sqlite");
  fs.mkdirSync(root, { recursive: true });
  const dbPath = path.join(root, "conversation_summaries.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE conversation_summaries (
      conversation_id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      workspace_uris TEXT NOT NULL DEFAULT '',
      last_modified_time TEXT NOT NULL DEFAULT '',
      nesting_depth INTEGER NOT NULL DEFAULT 0,
      agent_name TEXT NOT NULL DEFAULT '',
      parent_conversation_id TEXT NOT NULL DEFAULT ''
    );
  `);
  const ins = db.prepare("INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?, ?)");
  for (const r of rows) {
    ins.run(r.id, r.title || "", r.uris || "", r.modified || "", r.depth || 0, r.agent || "", r.parent || "");
  }
  db.close();
  return dbPath;
}

test("modelIdOf 与 modelFromSettingsChange 对齐 CC Switch 规则", () => {
  assert.equal(modelIdOf("Gemini 3.8 Flash (High)"), "gemini-3.8-flash-high");
  assert.equal(modelIdOf("Gemini 4 Argon (Low)"), "gemini-4-argon-low");
  assert.equal(modelIdOf("Gemini 4 Hydrogen (XHigh)"), "gemini-4-hydrogen-xhigh");
  assert.equal(modelIdOf("Claude Opus 4.6 (Thinking)"), "claude-opus-4.6-thinking");
  assert.equal(modelIdOf("gemini-3.8-flash"), "gemini-3.8-flash");
  assert.equal(modelIdOf("unknown"), "unknown");

  assert.equal(
    modelFromSettingsChange("The user changed setting `Model Selection` from None to Gemini 3.8 Flash (High). No need to comment"),
    "Gemini 3.8 Flash (High)"
  );
  assert.equal(
    modelFromSettingsChange("changed setting `Model Selection` from Gemini 4 Argon (Low) to None. Bye"),
    null
  );
  assert.equal(
    modelFromSettingsChange("changed setting `Model Selection` from None to Gemini 4 Hydrogen (XHigh)\nnext line"),
    "Gemini 4 Hydrogen (XHigh)"
  );
});

test("原生 Token 语义：input 不含 cache，output 已含 thinking，映射到 TokenBar 不重复扣减", async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokenbar-agy-sem-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const now = new Date();
  const iso = now.toISOString();
  // 完全对齐 CC Switch tests/fixtures/sessions/agy.jsonl：
  // 真实 prompt=100, cache=20, answer=5, thinking=7 -> agy 导出 input=80, cache_read=20, output=12
  writeTranscript(tmp, "fixture-1", [
    { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: iso, content: "Say fixture reply only" },
    { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: iso, model: "gemini-4-hydrogen-xhigh", input_tokens: 80, cache_read_tokens: 20, output_tokens: 12 }
  ]);

  const store = new AntigravityStore({ roots: [tmp] });
  const snap = await store.build();

  assert.equal(snap.source, "antigravity");
  assert.equal(snap.sessions, 1);
  assert.equal(snap.totals.records, 1);
  assert.equal(snap.totals.cachedInputTokens, 20);
  // TokenBar 内部 inputTokens 含缓存，因此 80 + 20 = 100；新增输入 = 100 - 20 = 80
  assert.equal(snap.totals.inputTokens, 100);
  assert.equal(snap.totals.inputTokens - snap.totals.cachedInputTokens, 80);
  assert.equal(snap.totals.outputTokens, 12);
  assert.equal(snap.totals.totalTokens, 112);

  // 成本验证（gemini-4-hydrogen: input $1.5/M, cached $0.075/M, output $7.5/M，汇率 7.2）
  const expectedUsd = (80 * 1.5 + 20 * 0.075 + 12 * 7.5) / 1e6;
  assert.ok(Math.abs(snap.cost.usd - expectedUsd) < 1e-12, `expected ${expectedUsd}, got ${snap.cost.usd}`);
  assert.equal(snap.models[0].estimated, false);
});

test("step_index 覆写取最后一条，未完成 RUNNING 步骤不计入，损坏行容忍", async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokenbar-agy-rewrite-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const iso = new Date().toISOString();
  writeTranscript(tmp, "s-rewrite", [
    { step_index: 0, type: "USER_INPUT", content: "changed setting `Model Selection` from None to Gemini 3.8 Flash (High). No need to comment" },
    { step_index: 1, type: "PLANNER_RESPONSE", status: "RUNNING", created_at: iso, input_tokens: 50, output_tokens: 5 },
    { step_index: 1, type: "PLANNER_RESPONSE", status: "DONE", created_at: iso, input_tokens: 100, cache_read_tokens: 50, output_tokens: 20 },
    { step_index: 2, type: "PLANNER_RESPONSE", status: "RUNNING", created_at: iso, input_tokens: 999, output_tokens: 999 },
    "{broken trailing json"
  ]);

  const store = new AntigravityStore({ roots: [tmp] });
  const snap = await store.build();

  assert.equal(snap.totals.records, 1);
  assert.equal(snap.totals.inputTokens, 150);
  assert.equal(snap.totals.cachedInputTokens, 50);
  assert.equal(snap.totals.outputTokens, 20);
  assert.equal(snap.totals.totalTokens, 170);
  assert.equal(snap.models[0].model, "gemini-3.8-flash-high");
});

test("伴生 SQLite + Protobuf 解码：还原 Orchestrator / 子代理模型与耗时 / TTFT", async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokenbar-agy-native-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const wsPath = path.join(tmp, "my-workspace");
  fs.mkdirSync(wsPath, { recursive: true });
  const uri = pathToFileURL(wsPath).href;

  const iso = new Date().toISOString();
  const tf = writeTranscript(tmp, "orch-1", [
    { step_index: 0, type: "USER_INPUT", created_at: iso, content: "changed setting `Model Selection` from None to Orchestrator (Carbon). No need" },
    { step_index: 1, type: "PLANNER_RESPONSE", status: "DONE", created_at: iso, input_tokens: 1_000_000, cache_read_tokens: 1_000_000, output_tokens: 100_000 },
    { step_index: 3, type: "PLANNER_RESPONSE", status: "DONE", created_at: iso, model: "gemini-flash-worker-agy", input_tokens: 1_000_000, cache_read_tokens: 1_000_000, output_tokens: 100_000 },
    { step_index: 5, type: "PLANNER_RESPONSE", status: "DONE", created_at: iso, model: "gemini-4-carbon-high", input_tokens: 1_000_000, cache_read_tokens: 0, output_tokens: 0 }
  ]);

  const dbPath = createConvDb(tmp, "orch-1", [
    { step: 1, gen: 0, base: "gemini-pro-orchestrator", tiered: "Orchestrator (Carbon)", firstTokenMs: 1200, streamingMs: 800 },
    { step: 3, gen: 7, base: "gemini-flash-worker-agy", tiered: "Gemini 4 Hydrogen (Orchestrator)", firstTokenMs: 500, streamingMs: 1500 },
    { step: 5, gen: 2, base: "gemini-4-carbon", tiered: "gemini-4-carbon-high", firstTokenMs: 400, streamingMs: 600 }
  ]);
  createSummariesDb(tmp, [
    { id: "orch-1", title: "Orchestrator session", uris: JSON.stringify([uri]), depth: 0 }
  ]);

  const gens = readGenerationsForTranscript(tf, [1, 3, 5]);
  assert.equal(gens.get(1).model, "gemini-4-carbon");
  assert.deepEqual(gens.get(1).timing, { latencyMs: 2000, firstTokenMs: 1200 });
  assert.equal(gens.get(3).model, "Gemini 4 Hydrogen (Orchestrator)");
  assert.deepEqual(gens.get(3).timing, { latencyMs: 2000, firstTokenMs: 500 });

  const summaries = readSummariesIndex(tmp);
  assert.equal(summaries.get("orch-1").cwd, wsPath);

  const cacheFile = path.join(tmp, "agy-cache.json");
  const store = new AntigravityStore({ roots: [tmp], cacheFile });
  const snap = await store.build();

  assert.equal(snap.projects[0].project, "my-workspace");
  assert.equal(snap.sessions, 1);
  assert.equal(snap.totals.records, 3);

  const carbon = snap.models.find(m => m.model === "gemini-4-carbon");
  const hydrogen = snap.models.find(m => m.model === "gemini-4-hydrogen-orchestrator");
  const carbonHigh = snap.models.find(m => m.model === "gemini-4-carbon-high");
  assert.ok(carbon && hydrogen && carbonHigh, "三个模型应各自归位");

  // 成本验证（1M fresh + 1M cached + 100k output）：
  // carbon: 1*2.0 + 1*0.1 + 0.1*10 = $3.1
  // hydrogen: 1*1.5 + 1*0.075 + 0.1*7.5 = $2.325
  // carbon-high: 1*2.0 = $2.0 -> total = $7.425
  assert.ok(Math.abs(snap.cost.usd - 7.425) < 1e-9, `expected $7.425, got $${snap.cost.usd}`);

  // 速度验证：step 1 (100k / 2s) + step 3 (100k / 2s) = 200k / 4s = 50,000 tok/s；step 5 output=0 不计入
  assert.ok(snap.throughput, "应算出 throughput");
  assert.equal(snap.throughput.turns, 2);
  assert.equal(snap.throughput.outputTokens, 200_000);
  assert.equal(snap.throughput.durationMs, 4000);
  assert.equal(snap.throughput.tps, 50_000);
  assert.equal(snap.throughput.ttftMs, 850); // median([500, 1200]) = 850

  // 若伴生库后来损坏/表缺失，重扫时应保留已恢复的模型名称与计时
  const { DatabaseSync } = require("node:sqlite");
  const mutDb = new DatabaseSync(dbPath);
  mutDb.exec("DROP TABLE gen_metadata;");
  mutDb.close();
  // 模拟 transcript 追加一行（触发重扫，且保留 step 1/3 的旧恢复值）
  const nextSnap = await store.build({ force: true });
  assert.ok(nextSnap.models.find(m => m.model === "gemini-4-carbon"));
  assert.ok(nextSnap.models.find(m => m.model === "gemini-4-hydrogen-orchestrator"));
  assert.equal(nextSnap.throughput.turns, 2);
});

test("多根目录扫描与同会话 ID 去重，且容忍无伴生库的纯 CLI/子代理会话", async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokenbar-agy-multi-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const cliRoot = path.join(tmp, "antigravity-cli");
  const ideRoot = path.join(tmp, "antigravity");
  const iso = new Date().toISOString();

  // 同一个 sessionId 在 CLI 只有 1 条，在 IDE 续写到 2 条
  writeTranscript(cliRoot, "shared-1", [
    { step_index: 1, type: "PLANNER_RESPONSE", status: "DONE", created_at: iso, model: "gemini-4-argon", input_tokens: 100, output_tokens: 10 }
  ]);
  writeTranscript(ideRoot, "shared-1", [
    { step_index: 1, type: "PLANNER_RESPONSE", status: "DONE", created_at: iso, model: "gemini-4-argon", input_tokens: 100, output_tokens: 10 },
    { step_index: 2, type: "PLANNER_RESPONSE", status: "DONE", created_at: iso, model: "gemini-4-argon", input_tokens: 200, output_tokens: 20 }
  ]);
  // 无伴生库的 worker 子代理会话：gemini-flash-worker-agy 直接归入 gemini-4-hydrogen
  writeTranscript(cliRoot, "subagent-1", [
    { step_index: 1, type: "PLANNER_RESPONSE", status: "DONE", created_at: iso, model: "gemini-flash-worker-agy", input_tokens: 500, output_tokens: 50 }
  ]);

  const store = new AntigravityStore({ roots: [cliRoot, ideRoot] });
  const snap = await store.build();

  assert.equal(snap.sessions, 2);
  assert.equal(snap.totals.records, 3);
  assert.equal(snap.totals.totalTokens, (100 + 10) + (200 + 20) + (500 + 50));
  assert.ok(snap.models.find(m => m.model === "gemini-4-hydrogen"), "无原生库时 worker alias 也应归入 gemini-4-hydrogen");
});

test("Antigravity 型号定价归一化：-tiered / -thinking / 档位后缀与防误匹配", () => {
  const table = pricing.normalizeTable({});

  // Flash -tiered 精确回退到基础 Flash，不会匹配到 -flash-lite
  assert.equal(pricing.priceEntry("gemini-3.8-flash-tiered", table).match, "gemini-3.8-flash");
  assert.equal(pricing.priceEntry("models/gemini-3.7-flash-tiered", table).match, "gemini-3.7-flash");
  assert.equal(pricing.priceEntry("gemini-3.1-flash-tiered", table), null);

  // Hydrogen 各种变体
  assert.equal(pricing.priceEntry("gemini-4-hydrogen-tiered-high", table).match, "gemini-4-hydrogen");
  assert.equal(pricing.priceEntry("gemini-4-hydrogen-orchestrator", table).match, "gemini-4-hydrogen");
  assert.equal(pricing.priceEntry("gemini-flash-worker-agy", table).match, "gemini-4-hydrogen");

  // Claude 点号与 -thinking 归一化
  assert.equal(pricing.priceEntry("Claude Opus 4.6 (Thinking)", table).match, "claude-opus-4-6");
  assert.equal(pricing.priceEntry("claude-opus-4.6-thinking", table).match, "claude-opus-4-6");

  // 未解决的 Orchestrator 占位名绝不误匹配到具体模型
  assert.equal(pricing.priceEntry("orchestrator-carbon", table), null);
  assert.equal(pricing.priceEntry("gemini-pro-orchestrator", table), null);
});

test("Protobuf 损坏/缺失字段优雅降级，不影响其他有效字段读取", () => {
  // field 20 存在但 field 3 省略 -> proto3 默认 index 0
  assert.equal(decodeStepGenerationIndex(encodeStepMeta(0)), 0);
  assert.equal(decodeStepGenerationIndex(encodeStepMeta(7)), 7);
  assert.equal(decodeStepGenerationIndex(Buffer.from([0x80])), null);

  // field 21 为错线型 varint 时不能遮蔽 field 19
  const badField21 = Buffer.concat([
    encodeFieldString(19, "gemini-4-argon"),
    Buffer.from([0xa8, 0x01, 0x07]) // tag 21 wire 0 varint 7
  ]);
  const wrapped = encodeFieldBytes(1, badField21);
  const decoded = decodeGenerationMetadata(wrapped);
  assert.equal(decoded.model, "gemini-4-argon");
  assert.equal(decoded.timing, null);
});
