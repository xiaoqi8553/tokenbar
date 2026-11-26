"use strict";

/**
 * antigravity-native.cjs — Antigravity 原生 SQLite + Protobuf 读取层（对齐 CC Switch）
 *
 * 对应 CC Switch：
 *   - src-tauri/src/services/session_usage_agy/native_models.rs
 *   - src-tauri/src/session_manager/providers/agy.rs
 *
 * 仅以只读方式读取本地文件，绝不创建或改写 Antigravity 的任何数据库：
 *   1. conversations/<id>.db 中的 steps(step_type=15).metadata -> field 20 -> field 3 (generation index)
 *      与 gen_metadata.data -> field 1 (response):
 *        - field 19: base model（如 gemini-4-hydrogen / gemini-pro-orchestrator / gemini-flash-worker-agy）
 *        - field 21: tiered / display model（如 Gemini 4 Hydrogen (XHigh) / gemini-4-argon-high）
 *        - field 11: first_token Duration { seconds, nanos }
 *        - field 12: streaming Duration { seconds, nanos }
 *   2. conversation_summaries.db 中的 workspace_uris / title / nesting_depth / agent_name / parent_conversation_id
 */

const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL, fileURLToPath } = require("node:url");

let cachedSqlite = undefined;
function getSqlite() {
  if (cachedSqlite !== undefined) return cachedSqlite;
  try {
    cachedSqlite = require("node:sqlite").DatabaseSync;
  } catch {
    cachedSqlite = null;
  }
  return cachedSqlite;
}

/**
 * agy 记下的显示名（`Gemini 3.8 Flash (High)`）换成模型 ID（`gemini-3.8-flash-high`）。
 * 已经是 ID（不含空格）的原样返回。
 */
function modelIdOf(display) {
  const text = String(display || "");
  if (!text.includes(" ")) return text;
  return text
    .toLowerCase()
    .replace(/ \(/g, "-")
    .replace(/[()]/g, "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .join("-");
}

function orchestratorMode(model) {
  switch (modelIdOf(String(model || "").trim()).toLowerCase()) {
    case "orchestrator-carbon":
    case "gemini-pro-orchestrator":
      return "carbon";
    case "orchestrator-argon":
    case "gemini-pro-orchestrator-argon":
    case "gemini-pro-orchestrator-g1-pro":
      return "argon";
    case "orchestrator-neon":
    case "gemini-pro-orchestrator-neon":
      return "neon";
    default:
      return null;
  }
}

function isOrchestrator(model) {
  return orchestratorMode(model) !== null;
}

function isOrchestratorWorker(model) {
  return modelIdOf(String(model || "").trim()).toLowerCase() === "gemini-flash-worker-agy";
}

function isUnresolvedWorkerTarget(model) {
  const id = modelIdOf(String(model || "").trim()).toLowerCase();
  return !id
    || id === "unknown"
    || isOrchestrator(id)
    || isOrchestratorWorker(id)
    || id === "gemini-flash";
}

/**
 * 从 `USER_INPUT` 正文中解析最近一次模型切换事件：
 *   `changed setting \`Model Selection\` from X to Y`
 */
function modelFromSettingsChange(content) {
  if (typeof content !== "string" || !content) return null;
  const start = content.indexOf("Model Selection");
  if (start === -1) return null;
  const rest = content.slice(start);
  const toIndex = rest.indexOf(" to ");
  if (toIndex === -1) return null;
  const tail = rest.slice(toIndex + 4);
  const candidates = [tail.indexOf(". "), tail.indexOf("\n"), tail.indexOf("`")].filter(idx => idx !== -1);
  const end = candidates.length ? Math.min(...candidates) : tail.length;
  const model = tail.slice(0, end).trim().replace(/^\.+|\.+$/g, "").trim();
  if (!model || model.toLowerCase() === "none") return null;
  return model;
}

// ---------------------------------------------------------------------------
// 极简 Protobuf wire 解析器（容忍损坏字节、未知字段与错误 wire type）
// ---------------------------------------------------------------------------

function readVarint(buf, pos) {
  let val = 0n;
  let shift = 0n;
  let cursor = pos;
  while (cursor < buf.length && shift <= 63n) {
    const byte = buf[cursor++];
    val |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return [val, cursor];
    shift += 7n;
  }
  return null;
}

function iterProtoFields(buf) {
  if (!buf || !buf.length) return [];
  const fields = [];
  let pos = 0;
  while (pos < buf.length) {
    const tagRes = readVarint(buf, pos);
    if (!tagRes) break;
    const tag = Number(tagRes[0]);
    pos = tagRes[1];
    const field = tag >>> 3;
    const wire = tag & 7;
    if (field <= 0) break;
    if (wire === 0) {
      const valRes = readVarint(buf, pos);
      if (!valRes) break;
      fields.push({ field, wire, val: valRes[0] });
      pos = valRes[1];
    } else if (wire === 1) {
      if (pos + 8 > buf.length) break;
      pos += 8;
    } else if (wire === 2) {
      const lenRes = readVarint(buf, pos);
      if (!lenRes) break;
      const len = Number(lenRes[0]);
      pos = lenRes[1];
      if (!Number.isFinite(len) || len < 0 || pos + len > buf.length) break;
      fields.push({ field, wire, buf: buf.subarray(pos, pos + len) });
      pos += len;
    } else if (wire === 5) {
      if (pos + 4 > buf.length) break;
      pos += 4;
    } else {
      break;
    }
  }
  return fields;
}

function decodeStepGenerationIndex(rawBytes) {
  if (!rawBytes || !rawBytes.length) return null;
  const buf = Buffer.isBuffer(rawBytes) ? rawBytes : Buffer.from(rawBytes);
  const f20 = iterProtoFields(buf).find(item => item.field === 20 && item.wire === 2);
  if (!f20) return null;
  const f3 = iterProtoFields(f20.buf).find(item => item.field === 3 && item.wire === 0);
  // proto3 省略标量 0：有 field 20 但没有 field 3 时索引就是 0
  return f3 ? Number(f3.val) : 0;
}

function decodeDurationMs(buf) {
  if (!buf || !buf.length) return null;
  let seconds = 0n;
  let nanos = 0n;
  for (const item of iterProtoFields(buf)) {
    if (item.wire !== 0) continue;
    if (item.field === 1) seconds = BigInt.asIntN(64, item.val);
    else if (item.field === 2) nanos = BigInt.asIntN(32, item.val);
  }
  const ms = Number(seconds * 1000n + nanos / 1_000_000n);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

function decodeGenerationMetadata(rawBytes) {
  if (!rawBytes || !rawBytes.length) return null;
  const buf = Buffer.isBuffer(rawBytes) ? rawBytes : Buffer.from(rawBytes);
  const f1 = iterProtoFields(buf).find(item => item.field === 1 && item.wire === 2);
  if (!f1) return null;
  const responseFields = iterProtoFields(f1.buf);
  let base = null;
  let tiered = null;
  let firstTokenMs = null;
  let streamingMs = null;
  for (const item of responseFields) {
    if (item.wire !== 2) continue;
    if (item.field === 19) base = item.buf.toString("utf8");
    else if (item.field === 21) tiered = item.buf.toString("utf8");
    else if (item.field === 11) firstTokenMs = decodeDurationMs(item.buf);
    else if (item.field === 12) streamingMs = decodeDurationMs(item.buf);
  }

  let orchestratorModel = null;
  switch (base) {
    case "gemini-pro-orchestrator":
      orchestratorModel = "gemini-4-carbon";
      break;
    case "gemini-pro-orchestrator-argon":
    case "gemini-pro-orchestrator-g1-pro":
      orchestratorModel = "gemini-4-argon";
      break;
    case "gemini-pro-orchestrator-neon":
      orchestratorModel = "gemini-4-neon";
      break;
    case "gemini-flash-worker-agy":
      orchestratorModel = "gemini-4-hydrogen";
      break;
    default:
      break;
  }

  let effectiveTiered = tiered;
  if (effectiveTiered && orchestratorModel) {
    const id = modelIdOf(effectiveTiered).toLowerCase();
    if (isOrchestrator(id) || id === "gemini-flash" || id === "gemini-flash-worker-agy") {
      effectiveTiered = null;
    }
  }

  const model = [effectiveTiered, orchestratorModel, base]
    .filter(v => typeof v === "string")
    .map(v => v.trim())
    .find(v => v && v.toLowerCase() !== "unknown") || null;

  let timing = null;
  if (firstTokenMs !== null && streamingMs !== null) {
    const latencyMs = firstTokenMs + streamingMs;
    if (latencyMs > 0) timing = { latencyMs, firstTokenMs };
  }

  if (!model && !timing) return null;
  return { model, timing };
}

// ---------------------------------------------------------------------------
// 伴生 SQLite 定位与只读查询
// ---------------------------------------------------------------------------

function isWithinDir(targetPath, baseDir) {
  const resolvedTarget = path.resolve(targetPath);
  const resolvedBase = path.resolve(baseDir);
  if (process.platform === "win32") {
    return resolvedTarget.toLowerCase().startsWith(resolvedBase.toLowerCase() + path.sep)
      || resolvedTarget.toLowerCase() === resolvedBase.toLowerCase();
  }
  return resolvedTarget.startsWith(resolvedBase + path.sep) || resolvedTarget === resolvedBase;
}

function nativeDatabasePath(transcriptPath) {
  try {
    // <root>/brain/<id>/.system_generated/logs/transcript_full.jsonl
    const logsDir = path.dirname(transcriptPath);
    const sysDir = path.dirname(logsDir);
    const sessionDir = path.dirname(sysDir);
    const brainDir = path.dirname(sessionDir);
    if (path.basename(brainDir) !== "brain") return null;
    const rootDir = path.dirname(brainDir);
    const sessionId = path.basename(sessionDir);
    const dbPath = path.join(rootDir, "conversations", `${sessionId}.db`);
    if (!fs.existsSync(dbPath) || !fs.statSync(dbPath).isFile()) return null;
    const realRoot = fs.realpathSync(rootDir);
    const realDb = fs.realpathSync(dbPath);
    if (!isWithinDir(realDb, realRoot)) return null;
    return realDb;
  } catch {
    return null;
  }
}

function fileSig(targetPath) {
  try {
    const stat = fs.statSync(targetPath);
    return `${Math.trunc(stat.mtimeMs)}:${stat.size}`;
  } catch {
    return "0:0";
  }
}

function nativeStateFingerprint(transcriptPath) {
  const dbPath = nativeDatabasePath(transcriptPath);
  if (!dbPath) return "none";
  return `${fileSig(dbPath)}:${fileSig(dbPath + "-wal")}`;
}

function openReadOnlySqlite(dbPath) {
  const DatabaseSync = getSqlite();
  if (!DatabaseSync) return null;
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      db.exec("PRAGMA busy_timeout = 0;");
    } catch {
      /* read-only pragma ignore */
    }
    return db;
  } catch {
    return null;
  }
}

function readGenerationsForTranscript(transcriptPath, steps) {
  const out = new Map();
  if (!steps || !steps.length) return out;
  const dbPath = nativeDatabasePath(transcriptPath);
  if (!dbPath) return out;
  const db = openReadOnlySqlite(dbPath);
  if (!db) return out;
  try {
    const stepStmt = db.prepare("SELECT metadata FROM steps WHERE idx = ? AND step_type = 15");
    const genStmt = db.prepare("SELECT data FROM gen_metadata WHERE idx = ?");
    for (const step of steps) {
      let stepRow;
      try {
        stepRow = stepStmt.get(step);
      } catch {
        break;
      }
      if (!stepRow || !stepRow.metadata) continue;
      const genIndex = decodeStepGenerationIndex(stepRow.metadata);
      if (genIndex === null || !Number.isSafeInteger(genIndex)) continue;
      let genRow;
      try {
        genRow = genStmt.get(genIndex);
      } catch {
        break;
      }
      if (!genRow || !genRow.data) continue;
      const decoded = decodeGenerationMetadata(genRow.data);
      if (decoded) out.set(step, decoded);
    }
  } catch {
    /* 原生库忙或结构不兼容时优雅降级 */
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
  return out;
}

function parseWorkspaceDir(rawUris) {
  if (!rawUris) return null;
  let first = null;
  const text = String(rawUris).trim();
  if (!text) return null;
  if (text.startsWith("[")) {
    try {
      const list = JSON.parse(text);
      if (Array.isArray(list) && list.length) first = list[0];
    } catch {
      return null;
    }
  } else {
    first = text;
  }
  if (!first || typeof first !== "string") return null;
  if (/^file:\/\//i.test(first)) {
    try {
      return fileURLToPath(first);
    } catch {
      return null;
    }
  }
  return first;
}

/**
 * 读取根目录下的 conversation_summaries.db（只读）：
 * 获取会话的工作区目录（cwd）与父子会话归属。
 */
function readSummariesIndex(rootDir) {
  const map = new Map();
  const dbPath = path.join(rootDir, "conversation_summaries.db");
  if (!fs.existsSync(dbPath)) return map;
  const db = openReadOnlySqlite(dbPath);
  if (!db) return map;
  try {
    let rows;
    try {
      rows = db.prepare(
        "SELECT conversation_id, title, workspace_uris, last_modified_time, nesting_depth, agent_name, parent_conversation_id FROM conversation_summaries"
      ).all();
    } catch {
      rows = db.prepare(
        "SELECT conversation_id, title, workspace_uris, last_modified_time, 0 AS nesting_depth, '' AS agent_name, '' AS parent_conversation_id FROM conversation_summaries"
      ).all();
    }
    for (const row of rows) {
      if (!row || !row.conversation_id) continue;
      map.set(row.conversation_id, {
        title: (row.title || "").trim() || null,
        cwd: parseWorkspaceDir(row.workspace_uris),
        lastModifiedAt: row.last_modified_time || null,
        nestingDepth: Number(row.nesting_depth) || 0,
        agentName: (row.agent_name || "").trim() || null,
        parentId: (row.parent_conversation_id || "").trim() || null
      });
    }
    // 子代理往往继承父会话工作区
    for (const entry of map.values()) {
      if (!entry.cwd && entry.parentId && map.has(entry.parentId)) {
        entry.cwd = map.get(entry.parentId).cwd || null;
      }
    }
  } catch {
    /* 索引不可读时跳过，transcript 照常统计 */
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
  return map;
}

module.exports = {
  modelIdOf,
  orchestratorMode,
  isOrchestrator,
  isOrchestratorWorker,
  isUnresolvedWorkerTarget,
  modelFromSettingsChange,
  decodeStepGenerationIndex,
  decodeGenerationMetadata,
  nativeDatabasePath,
  nativeStateFingerprint,
  readGenerationsForTranscript,
  readSummariesIndex,
  parseWorkspaceDir,
  isWithinDir,
  pathToFileURL
};
