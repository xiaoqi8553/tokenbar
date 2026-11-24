"use strict";

/**
 * CodexStore / scan —— 会话文件发现、增量解析与明细流式扫描
 *
 * 与 buildFast/buildFull 相互独立：那两条路径只为弹窗提供「今日常用」的
 * 聚合桶，信息粒度到天为止；完整看板需要按模型、按项目、按会话拆分，
 * 因此单独做一次全量流式扫描，结果按文件签名增量缓存。
 *
 * 版本/口径注释（从原 codex-store.cjs 搬来）：
 *  - v4：快扫路径也做相邻重复快照去重（v3 逐行累加）
 *  - v7：明细带请求指纹，合并时与历史基线全局去重（v6 按天取大者，会把 fork 重放算多遍）
 *
 * 所有函数显式接收 store（facade 实例），不持有模块级实例状态。
 */

const fsp = require("node:fs/promises");
const path = require("node:path");
const { usageSignature } = require("../event-dedupe.cjs");
const {
  TAIL_BYTES, SCAN_CHUNK_BYTES, EMPTY_BUCKET, zeroBucket,
  dayKeyOf, dayKeyFromTimestamp, parseTokenCountLine,
  normalizeRateLimits, projectNameOf, pad2, addToBucket
} = require("./parse.cjs");

// -- 文件枚举 ----------------------------------------------------------

async function listSessionFiles(store) {
  const output = [];
  const walk = async dir => {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        try {
          const stat = await fsp.stat(full);
          output.push({ path: full, size: stat.size, mtimeMs: stat.mtimeMs });
        } catch {
          /* 文件消失则跳过 */
        }
      }
    }
  };
  await walk(store.sessionsDir);
  output.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return output;
}

// -- 单文件增量解析 ----------------------------------------------------

async function ingestFile(store, info, options = {}) {
  const { full = false, tailBytes = TAIL_BYTES } = options;
  const existing = store.files.get(info.path);
  const priorFull = existing ? existing.full : false;
  const effectiveFull = full || priorFull;

  // 未变化：直接用缓存
  if (existing && existing.size === info.size && existing.mtimeMs === info.mtimeMs && existing.full === effectiveFull) {
    return false;
  }

  let startOffset = 0;
  let truncatedFromTail = false;
  if (effectiveFull && !priorFull) {
    // 从「尾部快照」升级到「全量」：必须从头重读。
    // 否则 offset 已指向文件末尾，会被下面的 size 判断直接跳过，
    // 文件前半段的用量将永远统计不到。
    startOffset = 0;
  } else if (existing && existing.offset && info.size >= existing.offset) {
    startOffset = existing.offset;
  } else if (!effectiveFull) {
    startOffset = Math.max(0, info.size - tailBytes);
    truncatedFromTail = startOffset > 0;
  }

  if (info.size <= startOffset) return false;

  let buffer;
  try {
    const handle = await fsp.open(info.path, "r");
    try {
      const length = info.size - startOffset;
      buffer = Buffer.allocUnsafe(length);
      await handle.read(buffer, 0, length, startOffset);
    } finally {
      await handle.close();
    }
  } catch {
    return false;
  }

  let text = buffer.toString("utf8");
  if (truncatedFromTail) {
    // 从尾部读时首行可能被截断，丢弃到第一个换行
    const firstBreak = text.indexOf("\n");
    text = firstBreak === -1 ? "" : text.slice(firstBreak + 1);
  }

  // 建立 / 重置该文件的日归集
  const entry = existing || {
    size: 0,
    mtimeMs: 0,
    offset: 0,
    sessionTotal: null,
    days: new Map(),
    full: false
  };

  if (effectiveFull && !priorFull) {
    // 首次全量：清掉该文件此前基于尾部的部分贡献
    for (const [day, bucket] of entry.days) {
      const globalBucket = store.daily.get(day);
      if (!globalBucket) continue;
      for (const key of Object.keys(EMPTY_BUCKET())) {
        globalBucket[key] -= bucket[key] || 0;
      }
      if (globalBucket.records <= 0) store.daily.delete(day);
    }
    entry.days.clear();
  }

  const lines = text.split("\n");
  let touched = false;
  /** 相邻重复快照：同一用量被连写两行时只算一次（CC Switch 的 duplicate_snapshot） */
  let previousSignature = null;
  for (const line of lines) {
    const event = parseTokenCountLine(line);
    if (!event) continue;
    touched = true;

    if (event.usage) {
      const signature = usageSignature(event.usage);
      const duplicate = signature === previousSignature;
      previousSignature = signature;
      if (!duplicate) {
        const day = dayKeyFromTimestamp(event.timestamp) || dayKeyOf(new Date());
        let fileBucket = entry.days.get(day);
        if (!fileBucket) {
          fileBucket = zeroBucket();
          entry.days.set(day, fileBucket);
        }
        addToBucket(fileBucket, event.usage, 1);

        let globalBucket = store.daily.get(day);
        if (!globalBucket) {
          globalBucket = zeroBucket();
          store.daily.set(day, globalBucket);
        }
        addToBucket(globalBucket, event.usage, 1);
      }
    }

    if (event.sessionTotal) entry.sessionTotal = event.sessionTotal;

    if (event.rateLimits) {
      const stamp = event.timestamp || null;
      const isNewer = !store.rateLimitsAt || !stamp || stamp >= store.rateLimitsAt;
      if (isNewer) {
        const normalized = normalizeRateLimits(event.rateLimits, stamp);
        if (normalized) {
          store.rateLimits = normalized;
          store.rateLimitsAt = stamp;
        }
      }
    }

    if (event.timestamp && (!store.lastEventAt || event.timestamp > store.lastEventAt)) {
      store.lastEventAt = event.timestamp;
    }
  }

  entry.size = info.size;
  entry.mtimeMs = info.mtimeMs;
  entry.offset = info.size;
  entry.full = effectiveFull || entry.full;
  store.files.set(info.path, entry);

  return touched || effectiveFull;
}

/**
 * 流式读取单个会话文件，提取明细。
 * 分块读取 + 保留未完结行的 Buffer，避免大文件整块进内存，也避免
 * 多字节字符被块边界切断。
 */
async function scanFileDetail(store, filePath, size, onLine) {
  const handle = await fsp.open(filePath, "r");
  try {
    let remainder = Buffer.alloc(0);
    let position = 0;
    while (position < size) {
      const length = Math.min(SCAN_CHUNK_BYTES, size - position);
      const chunk = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(chunk, 0, length, position);
      if (!bytesRead) break;
      position += bytesRead;

      const joined = remainder.length ? Buffer.concat([remainder, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
      const lastBreak = joined.lastIndexOf(0x0a);
      if (lastBreak === -1) {
        remainder = Buffer.from(joined);
        continue;
      }
      const body = joined.subarray(0, lastBreak);
      remainder = Buffer.from(joined.subarray(lastBreak + 1));
      onLine(body.toString("utf8"));
    }
    if (remainder.length) onLine(remainder.toString("utf8"));
  } finally {
    await handle.close();
  }
}

/** 创建单文件明细累加器：feeds 分块文本，finish() 返回结果 */
function createDetailBuilder(store, filePath) {
  const detail = {
    file: filePath,
    sessionId: null,
    cwd: null,
    project: null,
    source: null,
    originator: null,
    cliVersion: null,
    firstAt: null,
    lastAt: null,
    tokens: zeroBucket(),
    /**
     * 文件内去重后的请求事件（精简五元组 + 归属维度）。
     * detailSnapshot 会用它做跨文件 / 跨基线去重后重建聚合桶。
     */
    events: [],
    /** Codex 自己维护的线程累计（total_token_usage 的最大值） */
    sessionTotal: 0,
    models: {},
    modelDays: {},
    days: {},
    hours: {},
    /** turn_id -> 该轮 output tokens（取 turn_token_usage 的累计值） */
    turnOutput: new Map(),
    /** turn_id -> task_complete 的耗时与首字延迟 */
    turnDone: new Map(),
    /** turn_id -> 该轮用的模型，速度要按模型拆开看 */
    turnModel: new Map(),
    quota: null
  };
  let currentModel = null;
  /** 单文件内已计入的请求指纹（相邻重复快照、文件内 replay） */
  const fileSeen = new Set();

  const feed = text => {
    for (const line of text.split("\n")) {
      if (line.length < 24) continue;

      if (line.indexOf('"session_meta"') !== -1) {
        try {
          const payload = JSON.parse(line).payload;
          if (payload) {
            detail.sessionId = payload.session_id || payload.id || detail.sessionId;
            detail.cwd = payload.cwd || detail.cwd;
            detail.source = payload.source || detail.source;
            detail.originator = payload.originator || detail.originator;
            detail.cliVersion = payload.cli_version || detail.cliVersion;
            if (!detail.firstAt && payload.timestamp) detail.firstAt = payload.timestamp;
          }
        } catch {
          /* 单行损坏跳过 */
        }
        continue;
      }

      if (line.indexOf('"turn_context"') !== -1) {
        try {
          const payload = JSON.parse(line).payload;
          const settings = payload && payload.collaboration_mode && payload.collaboration_mode.settings;
          const model = payload && (payload.model || (settings && settings.model));
          if (model) currentModel = model;
          if (payload && payload.cwd && !detail.cwd) detail.cwd = payload.cwd;
        } catch {
          /* ignore */
        }
        continue;
      }

      // 输出速度：task_complete 给了每轮的 duration_ms，token_usage_record 给了每轮的
      // output tokens，两者按 turn_id 配对就能算出真实的完成轮吞吐（tokens/s）。
      // 注意这是「整轮耗时」口径：包含了工具调用与等待，不是纯流式解码速度。
      if (line.indexOf('"task_complete"') !== -1) {
        try {
          const event = JSON.parse(line);
          const payload = event && event.payload;
          const duration = Number(payload && payload.duration_ms);
          if (payload && payload.type === "task_complete" && payload.turn_id && duration > 0) {
            const completedMs = Number(payload.completed_at) > 0
              ? Number(payload.completed_at) * 1000
              : Date.parse(event.timestamp || "");
            const ttft = Number(payload.time_to_first_token_ms);
            detail.turnDone.set(payload.turn_id, {
              durationMs: duration,
              ttftMs: Number.isFinite(ttft) && ttft >= 0 && ttft <= duration ? ttft : null,
              completedAt: Number.isFinite(completedMs) ? new Date(completedMs).toISOString() : null
            });
          }
        } catch {
          /* ignore */
        }
        continue;
      }

      if (line.indexOf('"token_usage_record"') !== -1) {
        try {
          const payload = JSON.parse(line).payload;
          const turnId = payload && payload.turn_id;
          if (turnId) {
            const usage = payload.turn_token_usage || payload.usage || {};
            const output = Number(usage.output_tokens) || 0;
            // turn_token_usage 是轮内累计值，取最大值可避免续跑时重复文件把它叠高
            if (output > (detail.turnOutput.get(turnId) || 0)) detail.turnOutput.set(turnId, output);
            if (!detail.turnModel.has(turnId)) detail.turnModel.set(turnId, payload.model || currentModel || "unknown");
          }
        } catch {
          /* ignore */
        }
        continue;
      }

      if (line.indexOf("token_count") === -1) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      const payload = event.payload;
      if (!payload || payload.type !== "token_count") continue;

      const stamp = event.timestamp || payload.timestamp || null;
      if (stamp) {
        if (!detail.firstAt || stamp < detail.firstAt) detail.firstAt = stamp;
        if (!detail.lastAt || stamp > detail.lastAt) detail.lastAt = stamp;
      }

      if (payload.info && payload.info.last_token_usage) {
        const usage = payload.info.last_token_usage;

        // 线程累计与去重无关，始终更新（resume 文件的 total 自带历史累计）
        const runningTotal = payload.info.total_token_usage && Number(payload.info.total_token_usage.total_tokens);
        if (runningTotal && runningTotal > detail.sessionTotal) detail.sessionTotal = runningTotal;

        // 请求指纹：文件内先去重一次，跨文件/跨基线由 effectiveDetail 再裁一遍
        const signature = usageSignature(usage);
        if (!fileSeen.has(signature)) {
          fileSeen.add(signature);

          const model = currentModel || "unknown";
          const date = stamp ? new Date(stamp) : new Date();
          const valid = !Number.isNaN(date.getTime());
          const day = valid ? dayKeyOf(date) : dayKeyOf(new Date());
          const hour = valid ? date.getHours() : new Date().getHours();

          detail.events.push({
            s: signature,
            i: Number(usage.input_tokens) || 0,
            c: Number(usage.cached_input_tokens) || 0,
            o: Number(usage.output_tokens) || 0,
            r: Number(usage.reasoning_output_tokens) || 0,
            t: Number(usage.total_tokens) || 0,
            d: day,
            h: hour,
            m: model
          });

          addToBucket(detail.tokens, usage, 1);

          if (!detail.models[model]) detail.models[model] = zeroBucket();
          addToBucket(detail.models[model], usage, 1);

          if (!detail.days[day]) detail.days[day] = zeroBucket();
          addToBucket(detail.days[day], usage, 1);

          // 按天×模型留一份，供看板切换时间范围时重算模型占比
          if (!detail.modelDays[day]) detail.modelDays[day] = {};
          if (!detail.modelDays[day][model]) detail.modelDays[day][model] = zeroBucket();
          addToBucket(detail.modelDays[day][model], usage, 1);

          // 全天候保留小时桶：活跃时段图要跟着 7/14/30/全部 区间切换
          const hourKey = `${day}T${pad2(hour)}`;
          detail.hours[hourKey] = (detail.hours[hourKey] || 0) + (usage.total_tokens || 0);
        }
      }

      if (payload.rate_limits) {
        const normalized = normalizeRateLimits(payload.rate_limits, stamp);
        if (normalized && (!detail.quota || !stamp || !detail.quota.sampledAt || stamp >= detail.quota.sampledAt)) {
          detail.quota = normalized;
        }
      }
    }
  };

  return {
    feed,
    finish() {
      detail.project = projectNameOf(detail.cwd);

      // 输出速度：把每轮的 output tokens 与 task_complete 的耗时配对。
      // 同时按「天」「模型」「小时」各留一份，界面才能回答
      // 「哪个模型快」「什么时段快」，而不只是一个总数。
      const throughput = { turns: 0, outputTokens: 0, durationMs: 0, ttft: [], days: {}, models: {}, hours: {}, dayHours: {}, modelDays: {} };
      const cellOf = (target, key) => {
        if (!target[key]) target[key] = { turns: 0, outputTokens: 0, durationMs: 0, ttft: [] };
        return target[key];
      };
      for (const [turnId, done] of detail.turnDone) {
        const output = detail.turnOutput.get(turnId) || 0;
        if (!output || !done.durationMs) continue;
        throughput.turns += 1;
        throughput.outputTokens += output;
        throughput.durationMs += done.durationMs;
        if (done.ttftMs !== null) throughput.ttft.push(done.ttftMs);

        const model = detail.turnModel.get(turnId) || "unknown";
        const cells = [cellOf(throughput.models, model)];
        if (done.completedAt) {
          // 按本地日期归集：completedAt 是 ISO(UTC)，直接 slice 会在时区边界错一天
          const completedAt = new Date(done.completedAt);
          const day = dayKeyOf(completedAt);
          cells.push(cellOf(throughput.days, day));
          if (!throughput.modelDays[day]) throughput.modelDays[day] = {};
          cells.push(cellOf(throughput.modelDays[day], model));
          const hour = completedAt.getHours();
          if (Number.isFinite(hour)) {
            cells.push(cellOf(throughput.hours, String(hour)));
            if (!throughput.dayHours[day]) throughput.dayHours[day] = {};
            cells.push(cellOf(throughput.dayHours[day], String(hour)));
          }
        }
        for (const cell of cells) {
          cell.turns += 1;
          cell.outputTokens += output;
          cell.durationMs += done.durationMs;
          if (done.ttftMs !== null) cell.ttft.push(done.ttftMs);
        }
      }
      detail.turnOutput = null;
      detail.turnDone = null;
      detail.turnModel = null;
      detail.throughput = throughput;
      return detail;
    }
  };
}

module.exports = {
  listSessionFiles,
  ingestFile,
  scanFileDetail,
  createDetailBuilder
};
