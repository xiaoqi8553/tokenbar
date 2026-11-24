"use strict";

/**
 * CodexStore / parse —— 解析与基础工具层
 *
 * 本层是叶子模块：除常量外不持有任何实例状态，可被多实例共享。
 * 原 codex-store.cjs 顶部的关键版本注释与领域知识一并搬迁至此：
 */

// v4：快扫路径也做相邻重复快照去重（v3 逐行累加）
const CACHE_VERSION = 4;
// v7：明细带请求指纹，合并时与历史基线全局去重（v6 按天取大者，会把 fork 重放算多遍）
const DETAIL_CACHE_VERSION = 7;
const TAIL_BYTES = 8 * 1024 * 1024;
const FAST_FILE_COUNT = 3;
/** 明细扫描的分块大小：大文件流式读，不整块进内存 */
const SCAN_CHUNK_BYTES = 8 * 1024 * 1024;
/** 小时分布的统计窗口（天），避免缓存文件无限膨胀 */
const HOUR_WINDOW_DAYS = 13;
const EMPTY_BUCKET = () => ({
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
  totalTokens: 0,
  records: 0
});

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function pad2(value) {
  return String(value).padStart(2, "0");
}

function dayKeyOf(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function dayKeyFromTimestamp(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return dayKeyOf(date);
}

/** 从工作目录推断项目名（取最后一段路径） */
function projectNameOf(cwd) {
  if (!cwd) return null;
  const parts = String(cwd).split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : null;
}

function addToBucket(bucket, usage, sign) {
  if (!usage) return;
  bucket.inputTokens += sign * (usage.input_tokens || 0);
  bucket.cachedInputTokens += sign * (usage.cached_input_tokens || 0);
  bucket.outputTokens += sign * (usage.output_tokens || 0);
  bucket.reasoningOutputTokens += sign * (usage.reasoning_output_tokens || 0);
  bucket.totalTokens += sign * (usage.total_tokens || 0);
  bucket.records += sign * 1;
}

function zeroBucket() {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    records: 0
  };
}

/**
 * 跨文件请求去重后，重建单份日志的聚合桶。
 *
 * createDetailBuilder 已经做过「文件内」去重；但 fork/resume 会让同一批请求
 * 出现在多个 rollout 文件里，且历史基线里可能也存着同一批请求。这里按文件
 * 时间从早到晚依次处理，用调用方传入的全局指纹集合只保留首次出现的请求，
 * 再把通过的事件重新聚合成与原 detail 完全同构的桶。
 *
 * 这样 detailSnapshot 后面的会话 / 模型 / 项目 / 小时聚合无需改动即可自动
 * 得到「按请求行去重后累加」的结果，与 CC Switch v4 一致。
 */
function effectiveDetail(detail, globalSeen) {
  const events = detail && detail.events;
  if (!Array.isArray(events) || !events.length) return detail;

  const tokens = zeroBucket();
  const models = {};
  const modelDays = {};
  const days = {};
  const hours = {};

  for (const ev of events) {
    if (globalSeen.has(ev.s)) continue;
    globalSeen.add(ev.s);

    const usage = {
      input_tokens: ev.i,
      cached_input_tokens: ev.c,
      output_tokens: ev.o,
      reasoning_output_tokens: ev.r,
      total_tokens: ev.t
    };
    addToBucket(tokens, usage, 1);

    const model = ev.m || "unknown";
    if (!models[model]) models[model] = zeroBucket();
    addToBucket(models[model], usage, 1);

    const day = ev.d;
    if (!days[day]) days[day] = zeroBucket();
    addToBucket(days[day], usage, 1);

    if (!modelDays[day]) modelDays[day] = {};
    if (!modelDays[day][model]) modelDays[day][model] = zeroBucket();
    addToBucket(modelDays[day][model], usage, 1);

    const hourKey = `${day}T${pad2(ev.h)}`;
    hours[hourKey] = (hours[hourKey] || 0) + usage.total_tokens;
  }

  return { ...detail, tokens, models, modelDays, days, hours };
}

function normalizeRateLimits(raw, timestamp) {
  if (!raw || typeof raw !== "object") return null;
  const pick = window => {
    if (!window || typeof window !== "object") return null;
    const usedPercent = Number(window.used_percent);
    if (!Number.isFinite(usedPercent)) return null;
    return {
      usedPercent: Math.max(0, Math.min(100, usedPercent)),
      remainingPercent: Math.max(0, Math.min(100, 100 - usedPercent)),
      windowMinutes: Number(window.window_minutes) || null,
      resetsAt: Number(window.resets_at) || null
    };
  };
  const primary = pick(raw.primary);
  const secondary = pick(raw.secondary);
  if (!primary && !secondary) return null;
  return {
    session: primary,
    weekly: secondary,
    credits: raw.credits && typeof raw.credits === "object"
      ? {
        hasCredits: Boolean(raw.credits.has_credits),
        unlimited: Boolean(raw.credits.unlimited),
        balance: raw.credits.balance != null ? String(raw.credits.balance) : null
      }
      : null,
    planType: raw.plan_type || null,
    limitReached: Boolean(raw.rate_limit_reached_type),
    sampledAt: timestamp || null
  };
}

// ---------------------------------------------------------------------------
// 单行解析：只对疑似 token_count 的行做 JSON.parse
// ---------------------------------------------------------------------------

function parseTokenCountLine(line) {
  if (line.length < 32) return null;
  if (line.indexOf("token_count") === -1) return null;
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  const payload = parsed && parsed.payload;
  if (!payload || payload.type !== "token_count") return null;
  return {
    timestamp: parsed.timestamp || payload.timestamp || null,
    usage: payload.info && payload.info.last_token_usage ? payload.info.last_token_usage : null,
    sessionTotal: payload.info && payload.info.total_token_usage ? payload.info.total_token_usage : null,
    rateLimits: payload.rate_limits || null
  };
}

module.exports = {
  CACHE_VERSION,
  DETAIL_CACHE_VERSION,
  TAIL_BYTES,
  FAST_FILE_COUNT,
  SCAN_CHUNK_BYTES,
  HOUR_WINDOW_DAYS,
  EMPTY_BUCKET,
  pad2,
  dayKeyOf,
  dayKeyFromTimestamp,
  projectNameOf,
  addToBucket,
  zeroBucket,
  effectiveDetail,
  normalizeRateLimits,
  parseTokenCountLine
};
