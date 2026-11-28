"use strict";

/**
 * CodexStore / aggregate —— 日桶、成本与 series / models / projects 聚合
 *
 * 所有函数显式接收 store（facade 实例）作为第一个参数，实例状态只留在
 * CodexStore 上；跨方法调用统一走 store.xxx()，与原 this.xxx() 完全等价。
 * 内部函数间调用也走 store 的公开方法，保证行为零变化。
 *
 * 领域知识（从原 codex-store.cjs 原样搬来）：
 *  - 快扫过渡期按天取大者；明细就绪后走「请求指纹全局去重 + 两边相加」
 *  - v3 起磁盘日志与历史基线按请求指纹全局去重，两边互补，逐小时相加
 */

const { zeroBucket, dayKeyOf, effectiveDetail } = require("./parse.cjs");
const { costOfModels, describeTable } = require("../pricing.cjs");

function mergedDay(store, key) {
  const logDay = store.daily.get(key) || null;
  const baseDay = store.baseline && store.baseline.days ? store.baseline.days[key] : null;
  if (!baseDay || !baseDay.totalTokens) return logDay;
  if (!logDay) return baseDay;
  return (baseDay.totalTokens || 0) > (logDay.totalTokens || 0) ? baseDay : logDay;
}

function mergedDayKeys(store) {
  const keys = new Set(store.daily.keys());
  if (store.baseline && store.baseline.days) {
    for (const key of Object.keys(store.baseline.days)) keys.add(key);
  }
  return keys;
}

function bucketsSince(store, days) {
  const out = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date(today);
    date.setDate(date.getDate() - offset);
    const key = dayKeyOf(date);
    const bucket = store.mergedDay(key) || zeroBucket();
    out.push({
      day: key,
      totalTokens: Math.max(0, bucket.totalTokens),
      inputTokens: Math.max(0, bucket.inputTokens),
      cachedInputTokens: Math.max(0, bucket.cachedInputTokens),
      outputTokens: Math.max(0, bucket.outputTokens),
      // 历史索引里没有推理 token 字段，缺失时按 0 处理
      reasoningOutputTokens: Math.max(0, bucket.reasoningOutputTokens || 0),
      records: Math.max(0, bucket.records)
    });
  }
  return out;
}

function totals(store) {
  const sum = zeroBucket();
  for (const key of store.mergedDayKeys()) {
    const bucket = store.mergedDay(key);
    if (!bucket) continue;
    for (const field of Object.keys(sum)) sum[field] += Math.max(0, bucket[field] || 0);
  }
  // 会话累计以 session 日志里的 total_token_usage 为准（更接近 Codex 内部口径）
  let sessionTotal = null;
  for (const entry of store.files.values()) {
    if (!entry.sessionTotal) continue;
    if (!sessionTotal) {
      sessionTotal = zeroBucket();
      sessionTotal.records = 0;
      delete sessionTotal.records;
    }
    sessionTotal.inputTokens += entry.sessionTotal.input_tokens || 0;
    sessionTotal.cachedInputTokens += entry.sessionTotal.cached_input_tokens || 0;
    sessionTotal.outputTokens += entry.sessionTotal.output_tokens || 0;
    sessionTotal.reasoningOutputTokens += entry.sessionTotal.reasoning_output_tokens || 0;
    sessionTotal.totalTokens += entry.sessionTotal.total_tokens || 0;
  }
  sessionTotal = sessionTotal || zeroBucket();
  return {
    totals: { ...sum, sessions: store.sessionCount },
    sessionTotals: sessionTotal
  };
}

function baselineMeta(store) {
  const baseline = store.baseline;
  if (!baseline || !baseline.days) return null;
  return {
    days: Object.keys(baseline.days).length,
    records: baseline.records || 0,
    totalTokens: baseline.totalTokens || 0,
    sessions: Object.keys(baseline.sessions || {}).length,
    builtAt: baseline.builtAt || null
  };
}

/** 从一份「天 → 桶」映射里取最近 N 天，用于让弹窗与看板共用同一份日聚合 */
function bucketsFromMap(store, map, days) {
  const out = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date(today);
    date.setDate(date.getDate() - offset);
    const key = dayKeyOf(date);
    const bucket = map.get(key) || zeroBucket();
    out.push({
      day: key,
      totalTokens: Math.max(0, bucket.totalTokens || 0),
      inputTokens: Math.max(0, bucket.inputTokens || 0),
      cachedInputTokens: Math.max(0, bucket.cachedInputTokens || 0),
      outputTokens: Math.max(0, bucket.outputTokens || 0),
      reasoningOutputTokens: Math.max(0, bucket.reasoningOutputTokens || 0),
      records: Math.max(0, bucket.records || 0)
    });
  }
  return out;
}

function snapshot(store) {
  // 明细扫描就绪后，弹窗也改用它的日聚合。
  // 否则弹窗走「快扫尾部」、看板走「全量明细」，同一时刻会显示两个今日用量。
  const detailDays = store._detailDays;
  let totalsValue;
  let series;
  if (detailDays) {
    const sum = zeroBucket();
    for (const bucket of detailDays.values()) {
      for (const key of Object.keys(sum)) sum[key] += Math.max(0, bucket[key] || 0);
    }
    totalsValue = { ...sum, sessions: store._detailSessions || store.sessionCount };
    series = store.bucketsFromMap(detailDays, 14);
  } else {
    totalsValue = store.totals().totals;
    series = store.bucketsSince(14);
  }
  const todayKey = dayKeyOf(new Date());
  const today = series.find(item => item.day === todayKey) || zeroBucket();
  const yesterdayDate = new Date();
  yesterdayDate.setDate(yesterdayDate.getDate() - 1);
  const yesterday = series.find(item => item.day === dayKeyOf(yesterdayDate)) || zeroBucket();

  const legacy = store.baselineMeta();

  return {
    ok: true,
    source: "codex-store",
    phase: store.phase,
    updatedAt: store.lastBuiltAt,
    lastEventAt: store.lastEventAt,
    // 会话数取「磁盘文件数」与「历史索引会话数」的较大者：
    // 索引里的 223 个会话覆盖了磁盘上已清理的那部分
    sessions: Math.max(store.sessionCount || 0, legacy ? legacy.sessions : 0),
    // 累计口径：按每轮 last_token_usage 逐条累加，并按请求指纹全局去重后
    // 与历史索引相加（明细路径）；快扫过渡期按天取大者。
    // 不能用各会话 total_token_usage 相加——续跑（resume）会生成新会话文件，
    // 其 total 携带了此前的累计值，相加会把历史用量重复计算。
    totals: {
      inputTokens: totalsValue.inputTokens,
      cachedInputTokens: totalsValue.cachedInputTokens,
      outputTokens: totalsValue.outputTokens,
      totalTokens: totalsValue.totalTokens,
      records: totalsValue.records
    },
    baseline: legacy,
    today,
    yesterday,
    series,
    quota: store.rateLimits ? { ...store.rateLimits, sampledAt: store.rateLimitsAt } : null,
    // 花费要按模型单价折算：明细扫描过就用明细的，否则用缓存里的文件聚合
    cost: store._detailCost || store.costSummary(),
    providers: [],
    scannedFiles: store.files.size
  };
}

/**
 * 花费摘要：只做聚合，不生成完整明细。
 * 弹窗在明细扫描之前也要能显示「等价花费」，所以单独给一条轻量路径；
 * 它同样按请求指纹全局去重，避免过渡期金额比明细高出一截。
 */
function costSummary(store) {
  if (!store.detailFiles.size && !store.baseline) return null;

  /** 天 → { totalTokens, models: 模型 → 桶 } */
  const days = new Map();
  const baseline = store.baseline;
  // 与明细路径共用同一份请求指纹：基线已记过的请求在磁盘侧跳过，
  // 两边互补，成本才不会把 fork 重放的历史再算一遍。
  const globalSeen = new Set(
    baseline && Array.isArray(baseline.signatures) ? baseline.signatures : []
  );
  const entries = [...store.detailFiles.values()]
    .filter(entry => entry && entry.detail)
    .sort((a, b) => String(a.detail.firstAt || "").localeCompare(String(b.detail.firstAt || "")));

  for (const entry of entries) {
    const detail = effectiveDetail(entry.detail, globalSeen);
    for (const [day, byModel] of Object.entries(detail.modelDays || {})) {
      let cell = days.get(day);
      if (!cell) {
        cell = { totalTokens: 0, models: {} };
        days.set(day, cell);
      }
      for (const [model, bucket] of Object.entries(byModel)) {
        if (!cell.models[model]) cell.models[model] = zeroBucket();
        const target = cell.models[model];
        for (const key of Object.keys(zeroBucket())) target[key] += bucket[key] || 0;
        cell.totalTokens += bucket.totalTokens || 0;
      }
    }
  }

  // 基线里被 Codex 清理掉的旧 rollout 只在索引里，按天补进来（互补，不是取大者）
  if (baseline && baseline.days) {
    for (const [day, baseDay] of Object.entries(baseline.days)) {
      if (!baseDay || !baseDay.totalTokens) continue;
      let cell = days.get(day);
      if (!cell) {
        cell = { totalTokens: 0, models: {} };
        days.set(day, cell);
      }
      cell.totalTokens += baseDay.totalTokens;
      for (const [model, bucket] of Object.entries(baseDay.models || {})) {
        if (!cell.models[model]) cell.models[model] = zeroBucket();
        const target = cell.models[model];
        for (const key of Object.keys(zeroBucket())) target[key] += bucket[key] || 0;
      }
    }
  }

  const all = {};
  const todayKey = dayKeyOf(new Date());
  let todayCny = 0;
  for (const [day, cell] of days) {
    for (const [model, bucket] of Object.entries(cell.models)) {
      if (!all[model]) all[model] = zeroBucket();
      const target = all[model];
      for (const key of Object.keys(zeroBucket())) target[key] += bucket[key] || 0;
    }
    if (day === todayKey) todayCny = costOfModels(cell.models, store.pricing).cny;
  }

  const total = costOfModels(all, store.pricing);
  if (!total.cny) return null;
  return {
    cny: total.cny,
    usd: total.cny / store.pricing.usdCny,
    todayCny,
    estimatedTokens: total.estimatedTokens,
    rate: store.pricing.usdCny
  };
}

function detailSnapshot(store) {
  /** 按 session_id 合并：续跑会为同一会话生成多个 rollout 文件 */
  const sessionsById = new Map();
  const models = new Map();
  const projects = new Map();
  const days = new Map();
  /** @type {Record<string, Record<string, object>>} 天 → 模型 → 桶 */
  const modelDays = {};
  /** @type {Record<string, Record<string, object>>} 天 → 项目 → 桶 */
  const projectDays = {};
  /** @type {Record<string, Record<string, Record<string, object>>>} 天 → 项目 → 模型 → 桶 */
  const projectModelDays = {};
  const hours = new Array(24).fill(0);
  /** @type {Record<string, number[]>} 天 → 24 小时桶，用于「昨日同期」这类对比 */
  const dailyHours = {};
  const sum = zeroBucket();
  /** 输出速度汇总：turns/outputTokens/durationMs 三项累加后算加权 tps */
  // 天 → 项目 → 速度桶：项目分布要显示 tok/s，必须把每份日志的速度归到它自己的项目
  const speed = { turns: 0, outputTokens: 0, durationMs: 0, ttft: [], days: {}, models: {}, hours: {}, dayHours: {}, modelDays: {}, projectDays: {}, projects: {} };

  const todayKey = dayKeyOf(new Date());
  const hourFloor = Date.now() - 7 * 24 * 60 * 60 * 1000;

  // 历史基线里已计入的请求先占位：磁盘上若还留着同一批 rollout，
  // 这些请求会被跳过，磁盘与基线变成互补关系，后面可以直接相加。
  const globalSeen = new Set(
    store.baseline && Array.isArray(store.baseline.signatures) ? store.baseline.signatures : []
  );
  const entries = [...store.detailFiles.values()]
    .filter(entry => entry && entry.detail)
    // 时间从早到晚：fork/replay 的公共前缀归到最早的原始会话，而不是新文件
    .sort((a, b) => String(a.detail.firstAt || "").localeCompare(String(b.detail.firstAt || "")));

  for (const entry of entries) {
    const detail = effectiveDetail(entry.detail, globalSeen);

    const projectKey = detail.project || "未标注";
    const sessionKey = detail.sessionId || detail.file;
    let session = sessionsById.get(sessionKey);
    if (!session) {
      session = {
        id: sessionKey,
        sessionId: detail.sessionId,
        project: detail.project || "未标注",
        cwd: detail.cwd,
        source: detail.source,
        firstAt: detail.firstAt,
        lastAt: detail.lastAt,
        totalTokens: 0,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        records: 0,
        files: 0,
        sessionTotal: 0,
        modelSet: new Set(),
        /** 会话内「模型 → 桶」：各家单价不同，成本必须按模型分别折算 */
        modelBuckets: {},
        quota: null
      };
      sessionsById.set(sessionKey, session);
    }
    session.files += 1;
    if ((detail.sessionTotal || 0) > session.sessionTotal) session.sessionTotal = detail.sessionTotal || 0;
    session.totalTokens += detail.tokens.totalTokens;
    session.inputTokens += detail.tokens.inputTokens;
    session.cachedInputTokens += detail.tokens.cachedInputTokens;
    session.outputTokens += detail.tokens.outputTokens;
    session.records += detail.tokens.records;
    for (const [name, bucket] of Object.entries(detail.models)) {
      session.modelSet.add(name);
      if (!session.modelBuckets[name]) session.modelBuckets[name] = zeroBucket();
      const dest = session.modelBuckets[name];
      for (const key of Object.keys(zeroBucket())) dest[key] += bucket[key] || 0;
    }

    // 输出速度：会话级也留一份，会话表里能直接看每轮快慢
    const fileSpeed = detail.throughput;
    if (fileSpeed && fileSpeed.turns) {
      session.speedTurns = (session.speedTurns || 0) + fileSpeed.turns;
      session.speedOutput = (session.speedOutput || 0) + fileSpeed.outputTokens;
      session.speedDuration = (session.speedDuration || 0) + fileSpeed.durationMs;
      speed.turns += fileSpeed.turns;
      speed.outputTokens += fileSpeed.outputTokens;
      speed.durationMs += fileSpeed.durationMs;
      if (fileSpeed.ttft) for (const value of fileSpeed.ttft) speed.ttft.push(value);
      const mergeSpeedCell = (target, key, cell) => {
        const dest = target[key] || (target[key] = { turns: 0, outputTokens: 0, durationMs: 0, ttft: [] });
        dest.turns += cell.turns;
        dest.outputTokens += cell.outputTokens;
        dest.durationMs += cell.durationMs;
        if (cell.ttft) for (const value of cell.ttft) dest.ttft.push(value);
      };
      for (const [day, cell] of Object.entries(fileSpeed.days || {})) mergeSpeedCell(speed.days, day, cell);
      for (const [model, cell] of Object.entries(fileSpeed.models || {})) mergeSpeedCell(speed.models, model, cell);
      for (const [hour, cell] of Object.entries(fileSpeed.hours || {})) mergeSpeedCell(speed.hours, hour, cell);
      for (const [day, hours] of Object.entries(fileSpeed.dayHours || {})) {
        if (!speed.dayHours[day]) speed.dayHours[day] = {};
        for (const [hour, cell] of Object.entries(hours)) mergeSpeedCell(speed.dayHours[day], hour, cell);
      }
      for (const [day, byModel] of Object.entries(fileSpeed.modelDays || {})) {
        if (!speed.modelDays[day]) speed.modelDays[day] = {};
        for (const [model, cell] of Object.entries(byModel)) mergeSpeedCell(speed.modelDays[day], model, cell);
      }
      // 一份日志只属于一个项目，按天摊到「天 → 项目」和「项目」两个维度
      for (const [day, cell] of Object.entries(fileSpeed.days || {})) {
        if (!speed.projectDays[day]) speed.projectDays[day] = {};
        mergeSpeedCell(speed.projectDays[day], projectKey, cell);
        mergeSpeedCell(speed.projects, projectKey, cell);
      }
    }
    if (detail.firstAt && (!session.firstAt || detail.firstAt < session.firstAt)) session.firstAt = detail.firstAt;
    if (detail.lastAt && (!session.lastAt || detail.lastAt > session.lastAt)) session.lastAt = detail.lastAt;
    if (detail.quota && (!session.quota || String(detail.quota.sampledAt || "") > String(session.quota.sampledAt || ""))) {
      session.quota = detail.quota;
    }

    for (const [name, bucket] of Object.entries(detail.models)) {
      let target = models.get(name);
      if (!target) {
        target = { model: name, ...zeroBucket() };
        models.set(name, target);
      }
      for (const key of Object.keys(zeroBucket())) target[key] += bucket[key] || 0;
    }

    let project = projects.get(projectKey);
    if (!project) {
      project = { project: projectKey, cwd: detail.cwd, ...zeroBucket(), sessions: 0 };
      projects.set(projectKey, project);
    }
    for (const key of Object.keys(zeroBucket())) project[key] += detail.tokens[key] || 0;
    project.sessions += 1;

    for (const [day, bucket] of Object.entries(detail.days)) {
      let target = days.get(day);
      if (!target) {
        target = { day, ...zeroBucket() };
        days.set(day, target);
      }
      for (const key of Object.keys(zeroBucket())) target[key] += bucket[key] || 0;

      // 项目维度没有跨会话混合，可直接按该会话的日桶归属
      if (!projectDays[day]) projectDays[day] = {};
      if (!projectDays[day][projectKey]) projectDays[day][projectKey] = zeroBucket();
      for (const key of Object.keys(zeroBucket())) projectDays[day][projectKey][key] += bucket[key] || 0;
    }

    for (const [day, byModel] of Object.entries(detail.modelDays || {})) {
      if (!modelDays[day]) modelDays[day] = {};
      if (!projectModelDays[day]) projectModelDays[day] = {};
      if (!projectModelDays[day][projectKey]) projectModelDays[day][projectKey] = {};
      for (const [model, bucket] of Object.entries(byModel)) {
        if (!modelDays[day][model]) modelDays[day][model] = zeroBucket();
        for (const key of Object.keys(zeroBucket())) modelDays[day][model][key] += bucket[key] || 0;
        if (!projectModelDays[day][projectKey][model]) projectModelDays[day][projectKey][model] = zeroBucket();
        for (const key of Object.keys(zeroBucket())) projectModelDays[day][projectKey][model][key] += bucket[key] || 0;
      }
    }

    for (const [hourKey, tokens] of Object.entries(detail.hours)) {
      const [dayPart, hourPart] = hourKey.split("T");
      // 全量落进 dailyHours，前端按 7/14/30/全部 现算，不再写死 7 天
      if (!dailyHours[dayPart]) dailyHours[dayPart] = new Array(24).fill(0);
      dailyHours[dayPart][Number(hourPart)] += tokens;

      const stamp = new Date(`${hourKey}:00:00`).getTime();
      if (Number.isNaN(stamp) || stamp < hourFloor) continue;
      hours[new Date(stamp).getHours()] += tokens;
    }

    for (const key of Object.keys(zeroBucket())) sum[key] += detail.tokens[key] || 0;
  }

  // ------------------------------------------------------------------
  // 与历史基线合并
  //
  // Codex 会清理/压缩旧的 rollout，磁盘上的日志往往只有最近一段。
  // 旧版索引把历史上扫到过的请求都留了下来，且 v3 已按请求指纹去重。
  //
  // 关键：上面的 globalSeen 以 baseline.signatures 打底，磁盘日志里凡是
  // 基线已记过的请求都被跳过，因此两边不再重叠、而是互补。这里按天**相加**，
  // 与 CC Switch v4 的 SUM(去重后的请求行) 同口径。旧版「按天取大者」是
  // 在无法区分同一请求时的近似，会把 fork 重放的历史整段算多遍，已废弃。
  // ------------------------------------------------------------------
  const baseline = store.baseline;
  if (baseline && baseline.days) {
    for (const [day, baseDay] of Object.entries(baseline.days)) {
      if (!baseDay || !baseDay.totalTokens) continue;

      let logDay = days.get(day);
      if (!logDay) {
        logDay = { day, ...zeroBucket() };
        days.set(day, logDay);
      }
      logDay.totalTokens += baseDay.totalTokens || 0;
      logDay.inputTokens += baseDay.inputTokens || 0;
      logDay.cachedInputTokens += baseDay.cachedInputTokens || 0;
      logDay.outputTokens += baseDay.outputTokens || 0;
      logDay.records += baseDay.records || 0;

      // 模型维度：同一天两边互补，逐个相加
      if (!modelDays[day]) modelDays[day] = {};
      for (const [model, bucket] of Object.entries(baseDay.models || {})) {
        if (!modelDays[day][model]) modelDays[day][model] = zeroBucket();
        const target = modelDays[day][model];
        for (const key of Object.keys(zeroBucket())) target[key] += bucket[key] || 0;
      }

      // 项目维度同理
      if (!projectDays[day]) projectDays[day] = {};
      if (!projectModelDays[day]) projectModelDays[day] = {};
      for (const cell of Object.values(baseDay.sessions || {})) {
        const project = cell.project || "历史索引";
        if (!projectDays[day][project]) projectDays[day][project] = zeroBucket();
        const target = projectDays[day][project];
        target.totalTokens += cell.totalTokens || 0;
        target.inputTokens += cell.inputTokens || 0;
        target.cachedInputTokens += cell.cachedInputTokens || 0;
        target.outputTokens += cell.outputTokens || 0;
        target.records += cell.records || 0;

        if (!projectModelDays[day][project]) projectModelDays[day][project] = {};
        for (const [model, mBucket] of Object.entries(cell.models || {})) {
          if (!projectModelDays[day][project][model]) projectModelDays[day][project][model] = zeroBucket();
          const mTarget = projectModelDays[day][project][model];
          for (const key of Object.keys(zeroBucket())) mTarget[key] += mBucket[key] || 0;
        }
      }

      // 小时分布：两边互补，逐小时相加而不是让基线整天覆盖日志
      if (Array.isArray(baseDay.hours) && baseDay.hours.length === 24) {
        if (!dailyHours[day]) dailyHours[day] = new Array(24).fill(0);
        for (let hour = 0; hour < 24; hour += 1) dailyHours[day][hour] += baseDay.hours[hour] || 0;
      }
    }

    // 只存在于历史索引里的会话补进会话列表
    for (const [sessionId, baseSession] of Object.entries(baseline.sessions || {})) {
      if (sessionsById.has(sessionId)) continue;
      sessionsById.set(sessionId, {
        id: sessionId,
        sessionId,
        project: baseSession.project || "历史索引",
        cwd: null,
        source: "legacy-index",
        firstAt: baseSession.firstAt,
        lastAt: baseSession.lastAt,
        totalTokens: baseSession.totalTokens,
        inputTokens: baseSession.inputTokens,
        cachedInputTokens: baseSession.cachedInputTokens,
        outputTokens: baseSession.outputTokens,
        records: baseSession.records,
        files: 0,
        sessionTotal: baseSession.totalTokens,
        modelSet: new Set(Object.keys(baseSession.models || {})),
        modelBuckets: Object.fromEntries(
          Object.entries(baseSession.models || {}).map(([name, bucket]) => [name, { ...zeroBucket(), ...bucket }])
        ),
        quota: null
      });
    }
  }

  // 合并后按天重算总量与各维度，避免新旧口径混在一起
  const merged = zeroBucket();
  for (const bucket of days.values()) {
    merged.totalTokens += bucket.totalTokens || 0;
    merged.inputTokens += bucket.inputTokens || 0;
    merged.cachedInputTokens += bucket.cachedInputTokens || 0;
    merged.outputTokens += bucket.outputTokens || 0;
    merged.records += bucket.records || 0;
  }

  const priceTable = store.pricing;

  const sessions = [...sessionsById.values()]
    .map(item => {
      const { modelSet, modelBuckets, speedTurns, speedOutput, speedDuration, ...rest } = item;
      const buckets = modelBuckets || {};
      const modelCost = costOfModels(buckets, priceTable);
      // 会话日志要能按「模型逐行」展开：模型名、四档 token、请求数、花费都要完整
      // 带出去，前端才不用把多模型折叠成 +N（对齐 CC Switch 请求日志的可查明细）。
      const modelDetails = Object.entries(buckets)
        .map(([model, bucket]) => ({
          model,
          inputTokens: bucket.inputTokens || 0,
          cachedInputTokens: bucket.cachedInputTokens || 0,
          outputTokens: bucket.outputTokens || 0,
          totalTokens: bucket.totalTokens || 0,
          records: bucket.records || 0,
          cost: (modelCost.perModel[model] || {}).cny || 0,
          estimated: Boolean((modelCost.perModel[model] || {}).estimated)
        }))
        .sort((a, b) => b.totalTokens - a.totalTokens);
      return {
        ...rest,
        // 按用量降序，会话表里第一个 chip 就是该会话的主要模型
        models: modelDetails.map(entry => entry.model),
        modelDetails,
        turns: speedTurns || 0,
        // 会话成本：按会话内各模型各自的单价折算
        cost: modelCost.cny,
        // 会话级加权速度：总输出 ÷ 总耗时，避免被单个极快/极慢的轮次带偏
        tps: speedDuration > 0 ? (speedOutput || 0) * 1000 / speedDuration : null
      };
    })
    .sort((a, b) => String(b.lastAt || "").localeCompare(String(a.lastAt || "")));

  const series = [...days.values()]
    .map(item => ({
      day: item.day,
      totalTokens: item.totalTokens,
      inputTokens: item.inputTokens,
      cachedInputTokens: item.cachedInputTokens,
      outputTokens: item.outputTokens,
      records: item.records
    }))
    .sort((a, b) => a.day.localeCompare(b.day));

  // 每天花费：按「天 → 模型」的桶各自单价折算，这样区间花费能跟着筛选重算
  for (const item of series) {
    item.cost = costOfModels(modelDays[item.day] || {}, priceTable).cny;
  }

  const modelList = Object.entries(modelDays).reduce((acc, [, byModel]) => {
    for (const [model, bucket] of Object.entries(byModel)) {
      if (!acc[model]) acc[model] = { model, ...zeroBucket() };
      const target = acc[model];
      target.totalTokens += bucket.totalTokens || 0;
      target.inputTokens += bucket.inputTokens || 0;
      target.cachedInputTokens += bucket.cachedInputTokens || 0;
      target.outputTokens += bucket.outputTokens || 0;
      target.records += bucket.records || 0;
    }
    return acc;
  }, {});

  const modelCost = costOfModels(modelList, priceTable);
  const modelListArray = Object.values(modelList)
    .map(item => {
      const cell = modelCost.perModel[item.model] || {};
      return {
        ...item,
        share: merged.totalTokens ? item.totalTokens / merged.totalTokens : 0,
        cost: cell.unit ? cell.cny : null,
        unit: cell.unit || null,
        estimated: Boolean(cell.estimated)
      };
    })
    .sort((a, b) => b.totalTokens - a.totalTokens);

  const projectTotals = Object.entries(projectDays).reduce((acc, [, byProject]) => {
    for (const [project, bucket] of Object.entries(byProject)) {
      if (!acc[project]) acc[project] = { project, ...zeroBucket(), sessions: 0 };
      const target = acc[project];
      target.totalTokens += bucket.totalTokens || 0;
      target.inputTokens += bucket.inputTokens || 0;
      target.cachedInputTokens += bucket.cachedInputTokens || 0;
      target.outputTokens += bucket.outputTokens || 0;
      target.records += bucket.records || 0;
    }
    return acc;
  }, {});

  const projectList = Object.values(projectTotals)
    .map(item => ({ ...item, share: merged.totalTokens ? item.totalTokens / merged.totalTokens : 0 }))
    .sort((a, b) => b.totalTokens - a.totalTokens);

  // 累计口径 = 磁盘日志 ∪ 历史索引，按请求指纹全局去重后相加。
  // 这就是「总共用了多少」，不需要再叠加任何线程计数器。
  const legacy = store.baselineMeta();

  /** 中位数：比平均值更抗单次卡顿 */
  const median = list => {
    if (!list.length) return null;
    const sorted = [...list].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  };

  const speedCell = cell => ({
    turns: cell.turns,
    outputTokens: cell.outputTokens,
    durationMs: cell.durationMs,
    tps: cell.durationMs > 0 ? cell.outputTokens * 1000 / cell.durationMs : null,
    ttftMs: median(cell.ttft || [])
  });

  const throughput = speed.durationMs > 0
    ? {
      turns: speed.turns,
      outputTokens: speed.outputTokens,
      durationMs: speed.durationMs,
      tps: speed.outputTokens * 1000 / speed.durationMs,
      ttftMs: median(speed.ttft),
      days: Object.fromEntries(Object.entries(speed.days).map(([day, cell]) => [day, speedCell(cell)])),
      models: Object.entries(speed.models)
        .map(([model, cell]) => ({ model, ...speedCell(cell) }))
        .sort((a, b) => b.turns - a.turns),
      hours: Array.from({ length: 24 }, (_, hour) => {
        const cell = speed.hours[String(hour)];
        return cell ? speedCell(cell) : { turns: 0, outputTokens: 0, durationMs: 0, tps: null, ttftMs: null };
      }),
      dayHours: Object.fromEntries(Object.entries(speed.dayHours).map(([day, byHour]) => [
        day,
        Array.from({ length: 24 }, (_, hour) => {
          const cell = byHour[String(hour)];
          return cell ? speedCell(cell) : null;
        })
      ])),
      modelDays: Object.fromEntries(Object.entries(speed.modelDays).map(([day, byModel]) => [
        day,
        Object.fromEntries(Object.entries(byModel).map(([model, cell]) => [model, speedCell(cell)]))
      ])),
      projects: Object.entries(speed.projects)
        .map(([project, cell]) => ({ project, ...speedCell(cell) }))
        .sort((a, b) => b.turns - a.turns),
      projectDays: Object.fromEntries(Object.entries(speed.projectDays).map(([day, byProject]) => [
        day,
        Object.fromEntries(Object.entries(byProject).map(([project, cell]) => [project, speedCell(cell)]))
      ]))
    }
    : null;

  // 供 snapshot() 复用：弹窗与看板从此共用这一份日聚合
  store._detailDays = days;
  store._detailSessions = sessions.length;
  store._detailCost = {
    cny: modelCost.cny,
    usd: modelCost.cny / priceTable.usdCny,
    todayCny: (series.find(item => item.day === todayKey) || {}).cost || 0,
    rate: priceTable.usdCny
  };

  return {
    ok: true,
    builtAt: store.detailBuiltAt || null,
    sessions: sessions.length,
    scannedFiles: store.detailFiles.size,
    baseline: legacy,
    throughput,
    totals: {
      inputTokens: merged.inputTokens,
      cachedInputTokens: merged.cachedInputTokens,
      outputTokens: merged.outputTokens,
      totalTokens: merged.totalTokens,
      records: merged.records,
      sessions: sessions.length,
      cost: modelCost.cny
    },
    cost: {
      cny: modelCost.cny,
      usd: modelCost.cny / priceTable.usdCny,
      todayCny: (series.find(item => item.day === todayKey) || {}).cost || 0,
      estimatedTokens: modelCost.estimatedTokens,
      rate: priceTable.usdCny,
      updatedAt: priceTable.updatedAt,
      note: priceTable.note,
      sources: priceTable.sources
    },
    pricing: describeTable(priceTable, modelListArray.map(item => item.model)),
    series,
    models: modelListArray,
    projects: projectList,
    modelDays,
    projectDays,
    projectModelDays,
    hourly: hours,
    dailyHours,
    sessionList: sessions,
    today: series.find(item => item.day === todayKey) || null
  };
}

module.exports = {
  mergedDay,
  mergedDayKeys,
  bucketsSince,
  totals,
  baselineMeta,
  bucketsFromMap,
  snapshot,
  costSummary,
  detailSnapshot
};
