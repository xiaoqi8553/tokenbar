"use strict";

/**
 * 请求级去重 —— 对齐 CC Switch v4 的计数口径。
 *
 * Codex 的 rollout 在 resume / fork 时会把此前整段历史「重放」写进新文件：
 * 本机 2026-07-24 的 4 个文件前 721～746 个 token_count 事件逐条完全相同，
 * 旧版索引按 filePath:lineNumber 逐行累加，等于把同一批请求算了 4 遍。
 * CC Switch 用 thread 内事件序号 + 用量签名跳过 replay 前缀，只计各分支新增。
 *
 * 我们的日志侧没有稳定的 request_id（token_count 事件里不带），因此统一用
 * 「本次请求用量五元组」作为请求指纹，让旧索引与磁盘日志能互相去重：
 *   input / cached_input / output / total / reasoning_output
 * 这五个值随上下文长度单调增长，两个不同请求撞出完全相同五元组的概率极低；
 * 实测旧索引 42151 条里识别出的 10607 条重复，与 CC 账本里已记账的
 * 7/14、7/15 原始会话 707/708 条签名一一对应，说明该指纹可靠。
 *
 * 注意：签名只用来判断「同一请求被写了几遍」，不是 token 计数本身。
 * 计数仍以 last_token_usage 逐条累加，绝不改用 total_token_usage 差分
 * （resume 文件首条的 total 已含历史累计，差分会凭空多算）。
 */

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** 五元组指纹。磁盘日志与旧索引必须调用同一个函数，才能跨来源互相去重。 */
function signatureOf(input, cached, output, total, reasoning) {
  return [num(input), num(cached), num(output), num(total), num(reasoning)].join(":");
}

/** 磁盘日志 payload.info.last_token_usage（snake_case） */
function usageSignature(usage) {
  if (!usage) return "";
  return signatureOf(
    usage.input_tokens,
    usage.cached_input_tokens,
    usage.output_tokens,
    usage.total_tokens,
    usage.reasoning_output_tokens
  );
}

/** 旧版 usage-index.json 的单条 record（camelCase） */
function recordSignature(record) {
  if (!record) return "";
  return signatureOf(
    record.inputTokens,
    record.cachedInputTokens,
    record.outputTokens,
    record.totalTokens,
    record.reasoningOutputTokens
  );
}

// ---------------------------------------------------------------------------
// 3.0 指纹升级（新能力，不改变 signatureOf 的任何既有输出）
// ---------------------------------------------------------------------------

const REQUEST_ID_FIELDS = ["request_id", "requestId", "id"];
const THREAD_FIELDS = ["thread_id", "threadId", "conversation_id", "conversationId", "session_id", "sessionId"];
const SEQ_FIELDS = ["seq", "sequence", "line_number", "lineNumber", "index"];
const TIME_FIELDS = ["timestamp", "ts", "time"];
const DAY_FIELDS = ["date", "day", "d"];
const HOUR_FIELDS = ["hour", "h"];
const MODEL_FIELDS = ["model", "m"];

function pickField(source, names) {
  if (!source || typeof source !== "object") return null;
  for (const name of names) {
    const value = source[name];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return null;
}

/** 从 usage / record / 聚合事件里取五元组，统一交给 signatureOf 生成 base */
function baseSignatureOf(input) {
  if (!input || typeof input !== "object") return signatureOf(0, 0, 0, 0, 0);
  const fromUsage = input.usage && typeof input.usage === "object" ? input.usage : null;
  const src = fromUsage || input;
  if (src.input_tokens !== undefined || src.cached_input_tokens !== undefined) {
    return signatureOf(
      src.input_tokens, src.cached_input_tokens, src.output_tokens,
      src.total_tokens, src.reasoning_output_tokens
    );
  }
  if (src.inputTokens !== undefined || src.cachedInputTokens !== undefined) {
    return signatureOf(
      src.inputTokens, src.cachedInputTokens, src.outputTokens,
      src.totalTokens, src.reasoningOutputTokens
    );
  }
  return signatureOf(src.i, src.c, src.o, src.t, src.r);
}

/** 碰撞计数：同一五元组被不同请求复用时保留计数并给出告警文本 */
const collisionCounts = new Map();
const seenIdentities = new Map(); // base 五元组 -> 上一次见到的稳定身份
const SEEN_IDENTITY_LIMIT = 10_000;

function noteCollision(key) {
  const collisionKey = key == null ? "*" : String(key);
  const count = (collisionCounts.get(collisionKey) || 0) + 1;
  collisionCounts.set(collisionKey, count);
  return {
    key: collisionKey,
    count,
    warning: `疑似指纹碰撞：五元组 ${collisionKey} 已对应不同请求（第 ${count} 次）`
  };
}

function collisionStats() {
  const keys = {};
  let total = 0;
  for (const [key, count] of collisionCounts) {
    keys[key] = count;
    total += count;
  }
  return { total, keys };
}

function resetCollisionStats() {
  collisionCounts.clear();
  seenIdentities.clear();
}

/** 同一个 base 五元组被另一路请求身份复用 → 计数 + 告警；纯查询不影响返回指纹 */
function noteSuspectedCollision(base, identity) {
  if (!identity) return false;
  const previous = seenIdentities.get(base);
  if (previous === undefined) {
    if (seenIdentities.size >= SEEN_IDENTITY_LIMIT) seenIdentities.clear();
    seenIdentities.set(base, identity);
    return false;
  }
  if (previous === identity) return false;
  noteCollision(base);
  return true;
}

/**
 * 请求级指纹（新能力）：
 *  - 有稳定 request_id（request_id / requestId / id）时直接用它，五元组相同的两条请求也能区分；
 *  - 否则回退到 base 五元组，并拼上真实日志/记录里存在的 thread id、序号、时间戳、日/时/模型；
 *  - 不臆造字段，缺的就不拼；疑似碰撞时记录计数（见 collisionStats）并保留不同指纹。
 */
function fingerprintOf(eventOrRecord, context = {}) {
  const ctx = context && typeof context === "object" ? context : {};
  const base = baseSignatureOf(eventOrRecord);
  const pick = names => pickField(eventOrRecord, names) ?? pickField(ctx, names);

  const requestId = pick(REQUEST_ID_FIELDS);
  if (requestId !== null) {
    const identity = "request_id:" + String(requestId);
    noteSuspectedCollision(base, identity);
    return "rid:" + String(requestId);
  }

  const extra = [];
  const identityParts = [];
  const thread = pick(THREAD_FIELDS);
  if (thread !== null) { extra.push("thread=" + String(thread)); identityParts.push("t:" + String(thread)); }
  const seq = pick(SEQ_FIELDS);
  if (seq !== null) { extra.push("seq=" + String(seq)); identityParts.push("n:" + String(seq)); }
  const time = pick(TIME_FIELDS);
  if (time !== null) { extra.push("ts=" + String(time)); identityParts.push("ts:" + String(time)); }
  const day = pick(DAY_FIELDS);
  if (day !== null) extra.push("d=" + String(day));
  const hour = pick(HOUR_FIELDS);
  if (hour !== null) extra.push("h=" + String(hour));
  const model = pick(MODEL_FIELDS);
  if (model !== null) extra.push("m=" + String(model));

  // 只有稳定身份（thread + seq，或显式时间戳）才做碰撞判定，避免仅因日/时不同误报
  const identity = identityParts.length >= 2 ? identityParts.join("|") : null;
  noteSuspectedCollision(base, identity);
  return ["sig:" + base, ...extra].join("|");
}

module.exports = {
  signatureOf,
  usageSignature,
  recordSignature,
  fingerprintOf,
  noteCollision,
  collisionStats,
  resetCollisionStats
};
