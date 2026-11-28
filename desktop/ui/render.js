  // ---------------------------------------------------------------------
  // 渲染：额度
  // ---------------------------------------------------------------------
  function quotaPace(window_) {
    if (!window_ || !window_.windowMinutes || !window_.resetsAt) return null;
    const totalMs = window_.windowMinutes * 60 * 1000;
    const resetAt = window_.resetsAt * 1000;
    const elapsedMs = totalMs - (resetAt - Date.now());
    const elapsedPercent = Math.max(0, Math.min(100, (elapsedMs / totalMs) * 100));
    const delta = window_.usedPercent - elapsedPercent;
    let tone = "muted";
    let text = "节奏正常";
    if (delta > 5) {
      tone = "warn";
      text = "快于进度 " + Math.round(delta) + "%";
    } else if (delta < -5) {
      tone = "ok";
      text = "慢于进度 " + Math.round(-delta) + "%";
    }
    return { tone, text, remaining: resetAt - Date.now() };
  }

  function meterLevel(percent) {
    if (percent >= 95) return "full";
    if (percent >= 75) return "high";
    return "ok";
  }

  /** 某个时间窗口内实际消耗的 tokens：用小时桶累加，避免再扫一遍日志 */
  function windowTokens(startMs, endMs) {
    const hours = state.detail && state.detail.dailyHours;
    if (!hours || !Number.isFinite(startMs)) return null;
    const end = Number.isFinite(endMs) ? endMs : Date.now();
    const cursor = new Date(startMs);
    cursor.setMinutes(0, 0, 0);
    let total = 0;
    let seen = false;
    while (cursor.getTime() <= end) {
      const row = hours[localDayKey(cursor)];
      if (row) {
        total += row[cursor.getHours()] || 0;
        seen = true;
      }
      cursor.setHours(cursor.getHours() + 1);
    }
    return seen ? total : null;
  }

  function fmtClock(stamp) {
    const date = new Date(stamp);
    if (Number.isNaN(date.getTime())) return "—";
    const pad = value => String(value).padStart(2, "0");
    const clock = pad(date.getHours()) + ":" + pad(date.getMinutes());
    if (localDayKey(date) === localDayKey(new Date())) return clock;
    return (date.getMonth() + 1) + "/" + date.getDate() + " " + clock;
  }

  /**
   * 额度卡：已用百分比 + 剩余 + 本窗口真实消耗 + 重置时刻 + 节奏。
   * 只给一个百分比太单薄，看不出「这个窗口里到底花了多少」。
   */
  function statIconSvg(kind) {
    switch (kind) {
      case "quota": return '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="8" cy="8" r="5.5"/><path d="M8 4.8V8l2.2 1.2"/></svg>';
      case "today": return '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 2 4.5 9h3.8L7 14l4.5-7H7.7Z"/></svg>';
      case "total": return '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 5.5 8 2.5l5.5 3L8 8.5ZM2.5 8.5 8 11.5l5.5-3M2.5 11.5 8 14.5l5.5-3"/></svg>';
      case "cost": return '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="5.8"/><path d="M8 4.4v7.2M9.8 6.2c0-.7-.8-1.1-1.8-1.1s-1.8.4-1.8 1.1c0 .8.8 1.1 1.8 1.3 1 .2 1.8.5 1.8 1.3s-.8 1.2-1.8 1.2-1.8-.5-1.8-1.2"/></svg>';
      case "speed": return '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M3 11.5a5.5 5.5 0 1 1 10 0"/><path d="M8 8.8 10.6 6.2"/><circle cx="8" cy="9.2" r=".9" fill="currentColor"/></svg>';
      default: return '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="8" cy="8" r="5.5"/><path d="M5.5 8.2 7.2 9.9 10.7 6.4"/></svg>';
    }
  }

  function svgRingGauge(percent, level) {
    const pct = Math.max(0, Math.min(100, Number(percent) || 0));
    const r = 14;
    const c = 2 * Math.PI * r;
    const offset = c * (1 - pct / 100);
    return '<svg class="stat-ring" viewBox="0 0 36 36" aria-hidden="true">' +
      '<circle class="ring-bg" cx="18" cy="18" r="' + r + '"/>' +
      '<circle class="ring-fg" data-level="' + escapeHtml(level || "ok") + '" cx="18" cy="18" r="' + r + '" ' +
      'stroke-dasharray="' + c.toFixed(1) + '" stroke-dashoffset="' + offset.toFixed(1) + '" transform="rotate(-90 18 18)"/>' +
      '</svg>';
  }

  function segBarHtml(inputTokens, cachedInputTokens, outputTokens) {
    const input = Math.max(0, Number(inputTokens) || 0);
    const cached = Math.min(input, Math.max(0, Number(cachedInputTokens) || 0));
    const fresh = Math.max(0, input - cached);
    const out = Math.max(0, Number(outputTokens) || 0);
    const sum = fresh + cached + out;
    if (!sum) return "";
    const pIn = (fresh / sum) * 100;
    const pCache = (cached / sum) * 100;
    const pOut = (out / sum) * 100;
    return '<div class="seg-meter" title="新增输入 ' + fmtTokens(fresh) + ' · 缓存 ' + fmtTokens(cached) + ' · 输出 ' + fmtTokens(out) + '">' +
      (pIn > 0 ? '<i class="seg-in" style="width:' + pIn.toFixed(1) + '%"></i>' : '') +
      (pCache > 0 ? '<i class="seg-cache" style="width:' + pCache.toFixed(1) + '%"></i>' : '') +
      (pOut > 0 ? '<i class="seg-out" style="width:' + pOut.toFixed(1) + '%"></i>' : '') +
      '</div>';
  }

  function svgSparkline(values, color, uid) {
    const list = (values || []).map(v => Math.max(0, Number(v) || 0));
    if (list.length < 2 || list.every(v => v === 0)) return "";
    const w = 60, h = 28, pad = 3;
    const max = Math.max.apply(null, list) || 1;
    const min = Math.min.apply(null, list);
    const span = max - min || max || 1;
    const pts = list.map((v, i) => ({
      x: (i / (list.length - 1)) * (w - pad * 2) + pad,
      y: h - pad - ((v - min) / span) * (h - pad * 2)
    }));
    const d = pts.map((p, i) => (i === 0 ? "M " : "L ") + p.x.toFixed(1) + " " + p.y.toFixed(1)).join(" ");
    const area = d + " L " + pts[pts.length - 1].x.toFixed(1) + " " + (h - 1) + " L " + pts[0].x.toFixed(1) + " " + (h - 1) + " Z";
    const last = pts[pts.length - 1];
    const gid = "sp-" + uid;
    return '<svg class="stat-spark" viewBox="0 0 ' + w + ' ' + h + '" aria-hidden="true">' +
      '<defs><linearGradient id="' + gid + '" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0%" stop-color="' + color + '" stop-opacity="0.34"/>' +
      '<stop offset="100%" stop-color="' + color + '" stop-opacity="0.02"/>' +
      '</linearGradient></defs>' +
      '<path d="' + area + '" fill="url(#' + gid + ')"/>' +
      '<path d="' + d + '" fill="none" stroke="' + color + '" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<circle cx="' + last.x.toFixed(1) + '" cy="' + last.y.toFixed(1) + '" r="2.2" fill="' + color + '"/>' +
      '</svg>';
  }

  function recentSeriesValues(pick) {
    const detail = state.detail;
    const s = detail && detail.series;
    if (!s || !s.length) return [];
    return s.slice(-14).map(pick);
  }

  function quotaCard(title, fallbackWindow, quotaWindow) {
    const windowLabel = quotaWindow && quotaWindow.windowMinutes
      ? (quotaWindow.windowMinutes >= 1440
        ? Math.round(quotaWindow.windowMinutes / 1440) + " 天"
        : Math.round(quotaWindow.windowMinutes / 60) + " 小时")
      : fallbackWindow;

    if (!quotaWindow) {
      return {
        icon: "quota",
        label: title,
        window: windowLabel,
        num: "—",
        unit: "",
        hideMeter: true,
        foot: "暂无快照",
        hints: []
      };
    }

    const used = Math.max(0, Math.min(100, quotaWindow.usedPercent));
    const remaining = Math.max(0, 100 - used);
    const pace = quotaPace(quotaWindow);
    const totalMs = quotaWindow.windowMinutes ? quotaWindow.windowMinutes * 60000 : 0;
    const resetMs = quotaWindow.resetsAt ? quotaWindow.resetsAt * 1000 : null;
    const startMs = resetMs && totalMs ? resetMs - totalMs : null;
    const tokens = startMs ? windowTokens(startMs, Date.now()) : null;
    const elapsedPercent = startMs && resetMs
      ? Math.max(0, Math.min(100, ((totalMs - (resetMs - Date.now())) / totalMs) * 100))
      : null;

    const hints = [];
    if (tokens !== null) hints.push("窗口 " + fmtTokens(tokens));
    if (resetMs) hints.push(fmtClock(resetMs) + " 重置");

    return {
      icon: "quota",
      ring: true,
      label: title,
      window: windowLabel,
      num: fmtPercent(used),
      unit: "已用",
      percent: used,
      pace: elapsedPercent,
      foot: [
        '<span class="dot" data-tone="' + (pace ? pace.tone : "muted") + '"></span>',
        "剩余 <b>" + fmtPercent(remaining) + "</b>",
        pace ? " · " + escapeHtml(pace.text) : ""
      ].join(""),
      hints
    };
  }

  function todayCard() {
    const detail = state.detail;
    const today = detail && detail.today ? detail.today : null;
    const total = today ? today.totalTokens : 0;
    const cacheRate = today && today.inputTokens ? (today.cachedInputTokens / today.inputTokens) * 100 : 0;

    // 用「昨日同一时刻之前」的用量做基准：今天还没过完，拿全天比会严重失真
    const nowHour = new Date().getHours();
    const yesterdayHours = detail && detail.dailyHours ? detail.dailyHours[previousDayKey()] : null;
    const yesterdaySameTime = Array.isArray(yesterdayHours)
      ? yesterdayHours.slice(0, nowHour + 1).reduce((acc, value) => acc + (value || 0), 0)
      : 0;
    let deltaBadge = "";
    let deltaText = "";
    if (yesterdaySameTime > 0) {
      const delta = ((total - yesterdaySameTime) / yesterdaySameTime) * 100;
      const rounded = Math.round(delta);
      deltaText = "较昨日 " + (rounded >= 0 ? "+" : "") + rounded + "%";
      deltaBadge = '<span class="stat-delta ' + (rounded > 5 ? "up" : rounded < -5 ? "down" : "") + '">' +
        (rounded >= 0 ? "↑ " : "↓ ") + Math.abs(rounded) + "%</span>";
    }

    const freshInput = today ? Math.max(0, today.inputTokens - today.cachedInputTokens) : 0;
    return {
      icon: "today",
      label: "今日用量",
      window: "00:00+",
      num: today ? fmtTokens(total) : "—",
      unit: "tokens",
      rightHtml: deltaBadge,
      seg: today ? segBarHtml(today.inputTokens, today.cachedInputTokens, today.outputTokens) : "",
      hideMeter: true,
      foot: today
        ? "<b>" + fmtCount(today.records) + "</b> 请求 · 命中 <b>" + fmtPercent(cacheRate) + "</b>"
        : "暂无记录",
      hints: today
        ? ["新增输入 " + fmtTokens(freshInput) + " · 输出 " + fmtTokens(today.outputTokens), deltaText]
        : []
    };
  }

  /** 累计用量卡：跟 WorkBuddy 那边对称，两边都六张卡 */
  function totalCard() {
    const detail = state.detail;
    const totals = detail && detail.totals ? detail.totals : null;
    if (!totals) {
      return {
        icon: "total",
        label: "累计用量",
        window: "全部",
        num: "—",
        unit: "tokens",
        hideMeter: true,
        foot: "暂无数据",
        hints: []
      };
    }
    const days = detail.series ? detail.series.length : 0;
    const cacheRate = totals.inputTokens ? (totals.cachedInputTokens / totals.inputTokens) * 100 : 0;
    return {
      icon: "total",
      label: "累计用量",
      window: days + " 天",
      num: fmtTokens(totals.totalTokens),
      unit: "tokens",
      rightHtml: svgSparkline(recentSeriesValues(d => d.totalTokens), "var(--accent)", "total"),
      seg: segBarHtml(totals.inputTokens, totals.cachedInputTokens, totals.outputTokens),
      hideMeter: true,
      foot: "<b>" + fmtCount(totals.sessions) + "</b> 会话 · <b>" + fmtCount(totals.records) + "</b> 请求",
      hints: ["命中 " + fmtPercent(cacheRate)]
    };
  }

  function speedCard() {
    const detail = state.detail;
    const speed = detail && detail.throughput;
    const todaySpeed = speed && speed.days ? speed.days[localDayKey(new Date())] : null;
    const recentSpeed = speed && detail.series
      ? (() => {
          const keys = detail.series.slice(-14).map(item => item.day);
          let out = 0, dur = 0, turns = 0;
          for (const key of keys) {
            const cell = speed.days[key];
            if (!cell) continue;
            out += cell.outputTokens;
            dur += cell.durationMs;
            turns += cell.turns;
          }
          return dur > 0 ? { tps: out * 1000 / dur, turns } : null;
        })()
      : null;

    const hints = [];
    if (recentSpeed) hints.push("14 日 " + recentSpeed.tps.toFixed(1) + " tok/s");
    const ttft = (todaySpeed && todaySpeed.ttftMs) || (speed && speed.ttftMs) || null;
    if (ttft) hints.push("首字 " + fmtSpeed(ttft));

    const speedVals = speed && detail.series
      ? detail.series.slice(-14).map(d => (speed.days[d.day] && speed.days[d.day].tps) || 0)
      : [];

    return {
      icon: "speed",
      label: "输出速度",
      window: "整轮",
      num: todaySpeed ? todaySpeed.tps.toFixed(1) : "—",
      unit: todaySpeed ? "tok/s" : "",
      rightHtml: svgSparkline(speedVals, "var(--ok)", "speed"),
      hideMeter: true,
      foot: todaySpeed
        ? "<b>" + fmtCount(todaySpeed.turns) + "</b> 轮"
        : "暂无样本",
      hints
    };
  }

  /** 累计花费卡：token 折算成钱，回答「这些用量等于花了多少」 */
  function costCard() {
    const detail = state.detail;
    const cost = detail && detail.cost;
    if (!cost) {
      return {
        icon: "cost",
        label: "等价花费",
        window: "USD",
        num: "—",
        unit: "",
        hideMeter: true,
        foot: "—",
        hints: []
      };
    }
    const days = detail.baseline && detail.baseline.days ? detail.baseline.days : detail.series.length;
    const totalTokens = detail.totals ? detail.totals.totalTokens : 0;
    const estimatedShare = totalTokens ? (cost.estimatedTokens || 0) / totalTokens : 0;

    return {
      icon: "cost",
      label: "等价花费",
      window: days + " 天",
      num: fmtMoney(cost.cny),
      money: true,
      unit: "",
      rightHtml: svgSparkline(recentSeriesValues(d => d.cost || 0), "var(--c-output)", "cost"),
      hideMeter: true,
      title: "USD 刊例价折算" +
        (estimatedShare >= 0.005 ? " · 含 " + fmtPercent(estimatedShare * 100, 1) + " 估算" : ""),
      foot: "今日 <b>" + fmtMoney(cost.todayCny) + "</b> · " + fmtTokens(totalTokens),
      hints: detail.totals && detail.totals.records
        ? ["均摊 " + fmtMoney(cost.cny / detail.totals.records)]
        : []
    };
  }

  function workbuddyCards() {
    const detail = state.detail;
    const totals = detail.totals;
    const today = detail.today;
    const cacheRate = totals.inputTokens ? (totals.cachedInputTokens / totals.inputTokens) * 100 : 0;
    const todayRate = today && today.inputTokens ? (today.cachedInputTokens / today.inputTokens) * 100 : 0;
    const credits = detail.credits || { total: 0 };
    const rootHint = (detail.roots || [])
      .filter(item => item.files > 0)
      .map(item => "~/" + String(item.root).split(/[\\/]/).filter(Boolean).pop() + "/projects")
      .join(" + ") || "~/.workbuddy/projects";

    return [
      {
        icon: "today",
        label: "今日用量",
        window: "00:00+",
        num: today ? fmtTokens(today.totalTokens) : "—",
        unit: "tokens",
        seg: today ? segBarHtml(today.inputTokens, today.cachedInputTokens, today.outputTokens) : "",
        hideMeter: true,
        foot: today
          ? "<b>" + fmtCount(today.records) + "</b> 调用 · 缓存 <b>" + fmtPercent(todayRate) + "</b>"
          : "暂无记录",
        hints: today
          ? ["输出 " + fmtTokens(today.outputTokens) + " · 推理 " + fmtTokens(today.reasoningOutputTokens)]
          : []
      },
      {
        icon: "total",
        label: "累计用量",
        window: detail.series.length + " 天",
        num: fmtTokens(totals.totalTokens),
        unit: "tokens",
        seg: segBarHtml(totals.inputTokens, totals.cachedInputTokens, totals.outputTokens),
        hideMeter: true,
        foot: "<b>" + fmtCount(totals.sessions) + "</b> 会话 · <b>" + fmtCount(totals.records) + "</b> 调用",
        hints: [rootHint]
      },
      {
        icon: "cost",
        label: "等价花费",
        window: "USD",
        num: fmtMoney(detail.cost ? detail.cost.cny : 0),
        money: true,
        unit: "",
        hideMeter: true,
        foot: "今日 <b>" + fmtMoney(detail.cost ? detail.cost.todayCny : 0) + "</b> · " + fmtTokens(totals.totalTokens),
        hints: totals.records ? ["均摊 " + fmtMoney((detail.cost ? detail.cost.cny : 0) / totals.records)] : []
      },
      {
        icon: "total",
        label: "积分消耗",
        window: "累计",
        num: credits.total ? credits.total.toFixed(0) : "—",
        unit: "积分",
        hideMeter: true,
        foot: "今日 <b>" + (credits.today ? credits.today.toFixed(0) : "0") + "</b> 积分",
        hints: []
      },
      {
        icon: "cache",
        label: "缓存命中率",
        window: "输入",
        num: fmtPercent(cacheRate, 1),
        unit: "命中",
        ring: true,
        percent: cacheRate,
        level: "ok",
        foot: "命中 <b>" + fmtTokens(totals.cachedInputTokens) + "</b> · 输入 <b>" + fmtTokens(totals.inputTokens) + "</b>",
        hints: []
      },
      speedCard()
    ];
  }

  function agyQuotaCard(title, group, planType, fallbackErr, scopeHint) {
    const primary = group && group.primary ? group.primary : null;
    const winShort = primary
      ? (primary.window === "5h" ? "5h" : primary.window === "argon" ? "Argon" : "周")
      : "";
    const windowParts = [planType || "", winShort, primary ? "实时" : ""].filter(Boolean);
    const windowLabel = windowParts.length ? windowParts.join(" · ") : "实时";

    if (!primary) {
      return {
        icon: "quota",
        label: title,
        window: windowLabel,
        num: "—",
        unit: "",
        hideMeter: true,
        foot: fallbackErr ? "查询失败" : "暂无快照",
        hints: [fallbackErr || scopeHint || ""]
      };
    }

    const used = Math.max(0, Math.min(100, primary.usedPercent));
    const remaining = Math.max(0, 100 - used);
    const pace = quotaPace(primary);
    const totalMs = primary.windowMinutes ? primary.windowMinutes * 60000 : 0;
    const resetMs = primary.resetsAt ? primary.resetsAt * 1000 : null;
    const elapsedPercent = resetMs && totalMs
      ? Math.max(0, Math.min(100, ((totalMs - (resetMs - Date.now())) / totalMs) * 100))
      : null;

    const hints = [];
    const others = (group.tiers || []).filter(t => t.id !== primary.id);
    if (others.length) {
      hints.push(others.map(t => {
        const shortName = t.window === "5h" ? "5h" : t.window === "argon" ? "Argon" : "每周";
        return shortName + " " + fmtPercent(t.usedPercent);
      }).join(" · "));
    } else if (scopeHint) {
      hints.push(scopeHint);
    }
    if (resetMs) {
      hints.push(fmtClock(resetMs) + " 重置" + (pace ? " · " + pace.text : ""));
    }

    const tipLines = (group.tiers || []).map(t =>
      t.label + "：" + t.usedPercent.toFixed(1) + "% · 剩 " + t.remainingPercent.toFixed(1) + "%" +
      (t.resetsAt ? "（" + fmtClock(t.resetsAt * 1000) + "）" : "")
    );

    return {
      icon: "quota",
      ring: true,
      label: title,
      window: windowLabel,
      num: fmtPercent(used),
      unit: "已用",
      percent: used,
      pace: elapsedPercent,
      title: tipLines.join("\n"),
      foot: [
        '<span class="dot" data-tone="' + (pace ? pace.tone : "muted") + '"></span>',
        "剩余 <b>" + fmtPercent(remaining) + "</b>",
        resetMs ? " · " + fmtClock(resetMs) : ""
      ].join(""),
      hints
    };
  }

  function antigravityCards() {
    const detail = state.detail;
    const totals = detail.totals;
    const today = detail.today;
    const cacheRate = totals.inputTokens ? (totals.cachedInputTokens / totals.inputTokens) * 100 : 0;
    const todayRate = today && today.inputTokens ? (today.cachedInputTokens / today.inputTokens) * 100 : 0;
    const agyQuota = state.status && state.status.antigravityQuota;
    const agyQuotaErr = state.status && state.status.antigravityQuotaError;
    const planType = agyQuota && agyQuota.planType;
    const rootHint = (detail.roots || [])
      .filter(item => item.files > 0)
      .map(item => {
        const parts = String(item.root).split(/[\\/]/).filter(Boolean);
        return parts.length >= 2 && parts[parts.length - 2] === ".gemini"
          ? "~/.gemini/" + parts[parts.length - 1]
          : "~/" + (parts[parts.length - 1] || "antigravity");
      })
      .join(" + ") || "~/.gemini/antigravity";

    return [
      agyQuotaCard("Gemini 额度", agyQuota && agyQuota.gemini, planType, agyQuotaErr, "Gemini 4 · Flash"),
      agyQuotaCard("Claude / GPT 额度", agyQuota && agyQuota.thirdParty, planType, agyQuotaErr, "Claude · GPT-OSS"),
      {
        icon: "today",
        label: "今日用量",
        window: "00:00+",
        num: today ? fmtTokens(today.totalTokens) : "—",
        unit: "tokens",
        seg: today ? segBarHtml(today.inputTokens, today.cachedInputTokens, today.outputTokens) : "",
        hideMeter: true,
        foot: today
          ? "<b>" + fmtCount(today.records) + "</b> 调用 · 缓存 <b>" + fmtPercent(todayRate) + "</b>"
          : "暂无记录",
        hints: today
          ? ["新增输入 " + fmtTokens(Math.max(0, today.inputTokens - today.cachedInputTokens)) + " · 输出 " + fmtTokens(today.outputTokens)]
          : []
      },
      {
        icon: "total",
        label: "累计用量",
        window: detail.series.length + " 天",
        num: fmtTokens(totals.totalTokens),
        unit: "tokens",
        seg: segBarHtml(totals.inputTokens, totals.cachedInputTokens, totals.outputTokens),
        hideMeter: true,
        foot: "<b>" + fmtCount(totals.sessions) + "</b> 会话 · <b>" + fmtCount(totals.records) + "</b> 调用",
        hints: ["命中 " + fmtPercent(cacheRate, 1), rootHint]
      },
      {
        icon: "cost",
        label: "等价花费",
        window: "USD",
        num: fmtMoney(detail.cost ? detail.cost.cny : 0),
        money: true,
        unit: "",
        hideMeter: true,
        foot: "今日 <b>" + fmtMoney(detail.cost ? detail.cost.todayCny : 0) + "</b> · " + fmtTokens(totals.totalTokens),
        hints: totals.records ? ["均摊 " + fmtMoney((detail.cost ? detail.cost.cny : 0) / totals.records)] : []
      },
      speedCard()
    ];
  }

  /** 合并 Codex / Antigravity / WorkBuddy 三个数据源，供「总览」选项卡使用 */
  function buildOverviewDetail(dataMap) {
    const defs = [
      ["codex", "Codex"],
      ["antigravity", "Antigravity"],
      ["workbuddy", "WorkBuddy"]
    ];
    const items = defs.map(([key, label]) => ({ key, label, detail: dataMap && dataMap[key] })).filter(x => x.detail);
    if (!items.length) return null;

    const addInto = (dest, src) => {
      dest.inputTokens = (dest.inputTokens || 0) + (src.inputTokens || 0);
      dest.cachedInputTokens = (dest.cachedInputTokens || 0) + (src.cachedInputTokens || 0);
      dest.outputTokens = (dest.outputTokens || 0) + (src.outputTokens || 0);
      dest.totalTokens = (dest.totalTokens || 0) + (src.totalTokens || 0);
      dest.records = (dest.records || 0) + (src.records || 0);
    };
    const blankBucket = () => ({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, totalTokens: 0, records: 0 });
    const mergeSpeed = (dest, cell) => {
      dest.turns = (dest.turns || 0) + (cell.turns || 0);
      dest.outputTokens = (dest.outputTokens || 0) + (cell.outputTokens || 0);
      dest.durationMs = (dest.durationMs || 0) + (cell.durationMs || 0);
      dest.tps = dest.durationMs > 0 ? (dest.outputTokens * 1000) / dest.durationMs : null;
    };

    const totals = { ...blankBucket(), sessions: 0, cost: 0 };
    const cost = { cny: 0, usd: 0, todayCny: 0, estimatedTokens: 0, rate: 7.25 };
    const pricing = { models: {}, fallback: null };
    const dayMap = new Map();
    const modelDays = {};
    const projectDays = {};
    const projectModelDays = {};
    const dailyHours = {};
    const speed = { turns: 0, outputTokens: 0, durationMs: 0, days: {}, projectDays: {}, modelDays: {}, dayHours: {} };
    const sessionList = [];
    const sourceBreakdown = {};
    let builtAt = null;
    let scannedFiles = 0;

    for (const { key, detail } of items) {
      if (detail.builtAt && (!builtAt || String(detail.builtAt) > String(builtAt))) builtAt = detail.builtAt;
      scannedFiles += detail.scannedFiles || 0;
      const t = detail.totals || {};
      addInto(totals, t);
      totals.sessions += t.sessions || detail.sessions || 0;
      totals.cost += t.cost || (detail.cost && detail.cost.cny) || 0;
      if (detail.cost) {
        cost.cny += detail.cost.cny || 0;
        cost.usd += detail.cost.usd || 0;
        cost.todayCny += detail.cost.todayCny || 0;
        cost.estimatedTokens += detail.cost.estimatedTokens || 0;
        if (detail.cost.rate) cost.rate = detail.cost.rate;
      }
      if (detail.pricing) {
        if (detail.pricing.models) Object.assign(pricing.models, detail.pricing.models);
        if (detail.pricing.fallback && !pricing.fallback) pricing.fallback = detail.pricing.fallback;
      }
      sourceBreakdown[key] = {
        totalTokens: t.totalTokens || 0,
        todayTokens: detail.today ? (detail.today.totalTokens || 0) : 0,
        costCny: (detail.cost && detail.cost.cny) || 0,
        sessions: t.sessions || detail.sessions || 0
      };

      for (const s of (detail.series || [])) {
        let row = dayMap.get(s.day);
        if (!row) {
          row = { day: s.day, ...blankBucket(), cost: 0 };
          dayMap.set(s.day, row);
        }
        addInto(row, s);
        row.cost += s.cost || 0;
      }

      for (const [day, byModel] of Object.entries(detail.modelDays || {})) {
        if (!modelDays[day]) modelDays[day] = {};
        for (const [model, b] of Object.entries(byModel)) {
          if (!modelDays[day][model]) modelDays[day][model] = blankBucket();
          addInto(modelDays[day][model], b);
        }
      }

      for (const [day, byProj] of Object.entries(detail.projectDays || {})) {
        if (!projectDays[day]) projectDays[day] = {};
        for (const [proj, b] of Object.entries(byProj)) {
          if (!projectDays[day][proj]) projectDays[day][proj] = blankBucket();
          addInto(projectDays[day][proj], b);
        }
      }

      for (const [day, byProj] of Object.entries(detail.projectModelDays || {})) {
        if (!projectModelDays[day]) projectModelDays[day] = {};
        for (const [proj, byModel] of Object.entries(byProj)) {
          if (!projectModelDays[day][proj]) projectModelDays[day][proj] = {};
          for (const [model, b] of Object.entries(byModel)) {
            if (!projectModelDays[day][proj][model]) projectModelDays[day][proj][model] = blankBucket();
            addInto(projectModelDays[day][proj][model], b);
          }
        }
      }

      for (const [day, arr] of Object.entries(detail.dailyHours || {})) {
        if (!dailyHours[day]) dailyHours[day] = new Array(24).fill(0);
        for (let h = 0; h < 24; h += 1) dailyHours[day][h] += arr[h] || 0;
      }

      const tp = detail.throughput;
      if (tp && tp.durationMs > 0) {
        mergeSpeed(speed, tp);
        for (const [day, cell] of Object.entries(tp.days || {})) {
          if (!speed.days[day]) speed.days[day] = { turns: 0, outputTokens: 0, durationMs: 0, tps: null };
          mergeSpeed(speed.days[day], cell);
        }
        for (const [day, byProj] of Object.entries(tp.projectDays || {})) {
          if (!speed.projectDays[day]) speed.projectDays[day] = {};
          for (const [proj, cell] of Object.entries(byProj)) {
            if (!speed.projectDays[day][proj]) speed.projectDays[day][proj] = { turns: 0, outputTokens: 0, durationMs: 0, tps: null };
            mergeSpeed(speed.projectDays[day][proj], cell);
          }
        }
        for (const [day, byModel] of Object.entries(tp.modelDays || {})) {
          if (!speed.modelDays[day]) speed.modelDays[day] = {};
          for (const [model, cell] of Object.entries(byModel)) {
            if (!speed.modelDays[day][model]) speed.modelDays[day][model] = { turns: 0, outputTokens: 0, durationMs: 0, tps: null };
            mergeSpeed(speed.modelDays[day][model], cell);
          }
        }
        for (const [day, hours] of Object.entries(tp.dayHours || {})) {
          if (!speed.dayHours[day]) speed.dayHours[day] = new Array(24).fill(null);
          for (let h = 0; h < 24; h += 1) {
            const cell = hours && hours[h];
            if (!cell) continue;
            if (!speed.dayHours[day][h]) speed.dayHours[day][h] = { turns: 0, outputTokens: 0, durationMs: 0, tps: null };
            mergeSpeed(speed.dayHours[day][h], cell);
          }
        }
      }

      for (const sess of (detail.sessionList || [])) {
        sessionList.push(sess);
      }
    }

    sessionList.sort((a, b) => String(b.lastAt || "").localeCompare(String(a.lastAt || "")));
    const series = [...dayMap.values()].sort((a, b) => a.day.localeCompare(b.day));
    const todayKey = localDayKey(new Date());
    const throughput = speed.durationMs > 0
      ? { ...speed, tps: (speed.outputTokens * 1000) / speed.durationMs }
      : null;

    return {
      ok: true,
      source: "overview",
      builtAt,
      sessions: totals.sessions,
      scannedFiles,
      totals,
      cost,
      pricing,
      series,
      modelDays,
      projectDays,
      projectModelDays,
      dailyHours,
      throughput,
      sessionList,
      sourceBreakdown,
      today: series.find(item => item.day === todayKey) || null
    };
  }

  function overviewCards() {
    const quota = (state.status && state.status.quota) || null;
    const codexWin = (quota && (quota.session || quota.weekly)) || null;
    const codexLive = quota && quota.source === "api" ? " · 实时" : "";
    const agyQuota = state.status && state.status.antigravityQuota;
    const agyQuotaErr = state.status && state.status.antigravityQuotaError;

    return [
      todayCard(),
      totalCard(),
      costCard(),
      speedCard(),
      quotaCard("Codex 额度", (quota && quota.session ? "5h" : "7d") + codexLive, codexWin),
      agyQuotaCard("AGY 额度", agyQuota && agyQuota.gemini, agyQuota && agyQuota.planType, agyQuotaErr, "Gemini · Claude")
    ];
  }

  function renderAgentStrip() {
    const el = $("agent-strip");
    if (!el) return;
    if (state.source !== "overview" || !state.detail || !state.detail.sourceBreakdown) {
      el.hidden = true;
      el.innerHTML = "";
      return;
    }
    const sb = state.detail.sourceBreakdown;
    const total = Math.max(1, (state.detail.totals && state.detail.totals.totalTokens) || 0);
    const agents = [
      {
        key: "codex",
        name: "Codex",
        color: "#6366f1",
        ico: '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M21.55 10.004a5.416 5.416 0 00-.478-4.501c-1.217-2.09-3.662-3.166-6.05-2.66A5.59 5.59 0 0010.831 1C8.39.995 6.224 2.546 5.473 4.838A5.553 5.553 0 001.76 7.496a5.487 5.487 0 00.691 6.5 5.416 5.416 0 00.477 4.502c1.217 2.09 3.662 3.165 6.05 2.66A5.586 5.586 0 0013.168 23c2.443.006 4.61-1.546 5.361-3.84a5.553 5.553 0 003.715-2.66 5.488 5.488 0 00-.693-6.497v.001zm-8.381 11.558a4.199 4.199 0 01-2.675-.954c.034-.018.093-.05.132-.074l4.44-2.53a.71.71 0 00.364-.623v-6.176l1.877 1.069c.02.01.033.029.036.05v5.115c-.003 2.274-1.87 4.118-4.174 4.123zM4.192 17.78a4.059 4.059 0 01-.498-2.763c.032.02.09.055.131.078l4.44 2.53c.225.13.504.13.73 0l5.42-3.088v2.138a.068.068 0 01-.027.057L9.9 19.288c-1.999 1.136-4.552.46-5.707-1.51h-.001zM3.023 8.216A4.15 4.15 0 015.198 6.41l-.002.151v5.06a.711.711 0 00.364.624l5.42 3.087-1.876 1.07a.067.067 0 01-.063.005l-4.489-2.559c-1.995-1.14-2.679-3.658-1.53-5.63h.001zm15.417 3.54l-5.42-3.088L14.896 7.6a.067.067 0 01.063-.006l4.489 2.557c1.998 1.14 2.683 3.662 1.529 5.633a4.163 4.163 0 01-2.174 1.807V12.38a.71.71 0 00-.363-.623zm1.867-2.773a6.04 6.04 0 00-.132-.078l-4.44-2.53a.731.731 0 00-.729 0l-5.42 3.088V7.325a.068.068 0 01.027-.057L14.1 4.713c2-1.137 4.555-.46 5.707 1.513.487.833.664 1.809.499 2.757h.001zm-11.741 3.81l-1.877-1.068a.065.065 0 01-.036-.051V6.559c.001-2.277 1.873-4.122 4.181-4.12.976 0 1.92.338 2.671.954-.034.018-.092.05-.131.073l-4.44 2.53a.71.71 0 00-.365.623l-.003 6.173v.002zm1.02-2.168L12 9.25l2.414 1.375v2.75L12 14.75l-2.415-1.375v-2.75z"/></svg>'
      },
      {
        key: "antigravity",
        name: "Antigravity",
        color: "#f59e0b",
        ico: '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M21.751 22.607c1.34 1.005 3.35.335 1.508-1.508C17.73 15.74 18.904 1 12.037 1 5.17 1 6.342 15.74.815 21.1c-2.01 2.009.167 2.511 1.507 1.506 5.192-3.517 4.857-9.714 9.715-9.714 4.857 0 4.522 6.197 9.714 9.715z"/></svg>'
      },
      {
        key: "workbuddy",
        name: "WorkBuddy",
        color: "#10b981",
        ico: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none"><rect x="2.2" y="2.2" width="19.6" height="19.6" rx="5.5" stroke="currentColor" stroke-width="2"/><path d="M6.4 8.2l2.3 7.6 3.3-5.2 3.3 5.2 2.3-7.6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
      }
    ];
    const barHtml = agents.map(a => {
      const info = sb[a.key] || { totalTokens: 0 };
      const pct = (info.totalTokens / total) * 100;
      if (pct <= 0) return "";
      return '<i data-jump="' + a.key + '" style="width:' + Math.max(1.5, pct).toFixed(2) + '%;background:' + a.color + '" title="' + a.name + ' · ' + fmtPercent(pct, 1) + '"></i>';
    }).join("");
    const chipsHtml = agents.map(a => {
      const info = sb[a.key] || { totalTokens: 0, todayTokens: 0, costCny: 0, sessions: 0 };
      const pct = (info.totalTokens / total) * 100;
      return [
        '<button type="button" class="agent-chip" data-jump="' + a.key + '" style="--agent-color:' + a.color + '">',
        '  <span class="agent-chip-ico">' + a.ico + '</span>',
        '  <span class="agent-chip-meta">',
        '    <span class="agent-chip-name"><span>' + a.name + '</span><span>' + fmtPercent(pct, 1) + '</span></span>',
        '    <span class="agent-chip-sub">' + fmtTokens(info.totalTokens) + ' · ' + fmtMoney(info.costCny) + ' · ' + fmtCount(info.sessions) + ' 会话</span>',
        '  </span>',
        '</button>'
      ].join("");
    }).join("");
    el.innerHTML = '<div class="agent-bar">' + barHtml + '</div><div class="agent-chips">' + chipsHtml + '</div>';
    el.hidden = false;
  }

  function renderStats() {
    const detail = state.detail;
    if (!detail && (state.source === "overview" || state.source === "workbuddy" || state.source === "antigravity")) return;

    let cards;
    if (state.source === "overview") {
      cards = overviewCards();
    } else if (state.source === "workbuddy") {
      cards = workbuddyCards();
    } else if (state.source === "antigravity") {
      cards = antigravityCards();
    } else {
      const quota = (state.status && state.status.quota) || null;
      const liveTag = quota && quota.source === "api" ? " · 实时" : "";
      cards = [
        quotaCard("5 小时额度", "5 小时窗口" + liveTag, quota && quota.session),
        quotaCard("7 天额度", "7 天窗口" + liveTag, quota && quota.weekly),
        todayCard(),
        totalCard(),
        costCard(),
        speedCard()
      ];
    }

    const row = $("stat-row");
    row.innerHTML = cards.map(card => {
      const level = card.level || meterLevel(card.percent);
      const pace = Number.isFinite(card.pace) ? '<b class="pace" style="left:' + Math.max(0, Math.min(100, card.pace)).toFixed(1) + '%"></b>' : '';
      // 每张卡都占住额度条和两行提示的位置：Codex / WorkBuddy 切换时高度不跳
      const hints = (card.hints || []).filter(Boolean).slice(0, 2);
      while (hints.length < 2) hints.push("");
      const footText = card.foot.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
      const rightVisual = card.ring && Number.isFinite(card.percent)
        ? svgRingGauge(card.percent, level)
        : (card.rightHtml || "");
      const meterBlock = card.seg
        ? card.seg
        : '<div class="meter"' + (card.hideMeter ? ' style="visibility:hidden"' : '') + '><i data-level="' + level + '" style="width:' + Math.max(2, Math.min(100, card.percent)) + '%"></i>' + pace + '</div>';
      return [
        '<div class="stat"' + (card.title ? ' title="' + escapeHtml(card.title) + '"' : '') + '>',
        '  <div class="stat-top">',
        card.icon ? '    <span class="stat-ico">' + statIconSvg(card.icon) + '</span>' : '',
        '    <span class="stat-label">' + escapeHtml(card.label) + '</span>',
        card.window ? '    <span class="stat-window">' + escapeHtml(card.window) + '</span>' : '',
        '  </div>',
        '  <div class="stat-value">',
        '    <div class="stat-val-main">',
        '      <span class="stat-num' + (card.money ? ' money' : '') + '">' + card.num + '</span>',
        '      <span class="stat-unit">' + (card.unit || "") + '</span>',
        '    </div>',
        rightVisual,
        '  </div>',
        meterBlock,
        '  <div class="stat-foot" title="' + escapeHtml(footText) + '">' + card.foot + '</div>',
        hints.map(text => '  <div class="stat-hint"' + (text ? ' title="' + escapeHtml(text) + '"' : '') + '>' +
          (text ? escapeHtml(text) : '&nbsp;') + '</div>').join(""),
        '</div>'
      ].join("");
    }).join("");
  }

  function previousDayKey() {
    const date = new Date();
    date.setDate(date.getDate() - 1);
    return localDayKey(date);
  }

  // ---------------------------------------------------------------------
  // 渲染：趋势图
  // ---------------------------------------------------------------------
  function niceCeil(value) {
    if (value <= 0) return 1;
    const magnitude = Math.pow(10, Math.floor(Math.log10(value)));
    const scaled = value / magnitude;
    const steps = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
    for (const step of steps) {
      if (scaled <= step) return step * magnitude;
    }
    return 10 * magnitude;
  }

  /** 平滑曲线：Catmull-Rom 转三次贝塞尔；纵向夹紧，避免曲线冲出坐标区 */
  function smoothPath(points, top, bottom) {
    if (!points.length) return "";
    const head = "M " + points[0].x.toFixed(1) + " " + points[0].y.toFixed(1);
    if (points.length === 1) return head;
    const clamp = v => Math.max(top, Math.min(bottom, v));
    let d = head;
    for (let i = 0; i < points.length - 1; i += 1) {
      const p0 = points[i - 1] || points[i];
      const p1 = points[i];
      const p2 = points[i + 1];
      const p3 = points[i + 2] || p2;
      const c1x = p1.x + (p2.x - p0.x) / 6;
      const c1y = clamp(p1.y + (p2.y - p0.y) / 6);
      const c2x = p2.x - (p3.x - p1.x) / 6;
      const c2y = clamp(p2.y - (p3.y - p1.y) / 6);
      d += " C " + c1x.toFixed(1) + " " + c1y.toFixed(1) + ", " +
        c2x.toFixed(1) + " " + c2y.toFixed(1) + ", " +
        p2.x.toFixed(1) + " " + p2.y.toFixed(1);
    }
    return d;
  }

  function renderChart() {
    const svg = $("chart");
    const wrap = svg.parentElement;
    const width = Math.max(320, wrap.clientWidth);
    // 高度跟 CSS 走，改样式不用回来改这里的常量
    const height = Math.max(200, wrap.clientHeight || 280);
    const padL = 40, padR = 12, padT = 16, padB = 24;
    const innerW = width - padL - padR;
    const innerH = height - padT - padB;
    const bottom = padT + innerH;

    const series = rangeSeries();
    if (!series.length) {
      svg.setAttribute("viewBox", "0 0 " + width + " " + height);
      svg.innerHTML = '<text x="' + (width / 2) + '" y="' + (height / 2) + '" text-anchor="middle" class="axis-text">暂无数据</text>';
      return;
    }

    const isCost = state.chartMetric === "cost";
    const isBar = state.chartType === "bar";
    const valOf = item => isCost ? (item.cost || 0) : item.totalTokens;
    const fmtVal = v => isCost ? fmtMoney(v) : fmtTokens(v);

    let max = 0;
    for (const item of series) max = Math.max(max, valOf(item));

    // 纵轴不跟着单日尖峰走：拿 p95 / 中位数撑出一个「日常看得见」的上限。
    // 极个别超出上限的日子贴顶画，并打上尖角标记，真实值仍在 tooltip 和副标题里。
    const positives = series.map(valOf).filter(value => value > 0).sort((a, b) => a - b);
    const percentile = q => positives.length
      ? positives[Math.min(positives.length - 1, Math.floor(q * (positives.length - 1)))]
      : 0;
    const hardCeiling = niceCeil(max * 1.06 || 1);
    const softCeiling = niceCeil(Math.max(percentile(0.95) * 1.8, percentile(0.5) * 4) || 1);
    const ceiling = Math.min(hardCeiling, softCeiling);
    const clipped = series.filter(item => valOf(item) > ceiling);
    const activeCount = series.filter(item => item.totalTokens > 0).length;
    const blankCount = series.length - activeCount;

    const step = series.length === 1 ? 0 : innerW / (series.length - 1);
    const xAt = index => (series.length === 1 ? padL + innerW / 2 : padL + index * step);
    const yAt = value => bottom - (Math.max(0, Math.min(value, ceiling)) / ceiling) * innerH;
    const todayKey = localDayKey(new Date());

    const parts = [];

    // 四等分刻度：压低上限之后，日常几十 M 的起伏也能对着刻度读出来
    for (let i = 0; i <= 4; i += 1) {
      const y = bottom - (innerH * i) / 4;
      if (i > 0 && i < 4) {
        parts.push('<line class="grid-line" x1="' + padL + '" y1="' + y.toFixed(1) + '" x2="' + (padL + innerW) + '" y2="' + y.toFixed(1) + '"/>');
      }
      parts.push('<text class="axis-text" x="' + (padL - 8) + '" y="' + (y + 3.5).toFixed(1) + '" text-anchor="end">' + fmtVal((ceiling * i) / 4) + '</text>');
    }

    const points = series.map((item, index) => ({ x: xAt(index), y: yAt(valOf(item)) }));
    const line = smoothPath(points, padT, bottom);
    const area = line +
      " L " + points[points.length - 1].x.toFixed(1) + " " + bottom.toFixed(1) +
      " L " + points[0].x.toFixed(1) + " " + bottom.toFixed(1) + " Z";

    parts.push('<defs>');
    parts.push('<linearGradient id="g-area" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0%" stop-color="' + (isCost ? 'var(--c-output)' : 'var(--accent)') + '" stop-opacity="0.34"/>' +
      '<stop offset="70%" stop-color="' + (isCost ? 'var(--c-output)' : 'var(--accent)') + '" stop-opacity="0.08"/>' +
      '<stop offset="100%" stop-color="' + (isCost ? 'var(--c-output)' : 'var(--accent)') + '" stop-opacity="0.01"/>' +
      '</linearGradient>');
    parts.push('</defs>');

    if (isBar) {
      const bw = Math.max(4, Math.min(26, (innerW / Math.max(1, series.length)) * 0.64));
      series.forEach((item, index) => {
        const v = valOf(item);
        if (v <= 0) return;
        const cx = xAt(index);
        const bx = cx - bw / 2;
        const topY = yAt(v);
        const totalH = Math.max(2, bottom - topY);
        const opacity = state.hover === -1 || state.hover === index ? "1" : "0.45";
        if (isCost) {
          parts.push('<rect x="' + bx.toFixed(1) + '" y="' + topY.toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + totalH.toFixed(1) + '" rx="3" fill="var(--c-output)" opacity="' + opacity + '"/>');
        } else {
          const input = Math.max(0, item.inputTokens || 0);
          const cached = Math.min(input, Math.max(0, item.cachedInputTokens || 0));
          const fresh = Math.max(0, input - cached);
          const out = Math.max(0, item.outputTokens || 0);
          const sum = fresh + cached + out || 1;
          const hOut = (out / sum) * totalH;
          const hCache = (cached / sum) * totalH;
          const hIn = totalH - hOut - hCache;
          parts.push('<g opacity="' + opacity + '">' +
            '<rect x="' + bx.toFixed(1) + '" y="' + (bottom - hIn).toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + Math.max(0, hIn).toFixed(1) + '" fill="var(--c-input)"/>' +
            '<rect x="' + bx.toFixed(1) + '" y="' + (bottom - hIn - hCache).toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + Math.max(0, hCache).toFixed(1) + '" fill="var(--c-cached)"/>' +
            '<rect x="' + bx.toFixed(1) + '" y="' + topY.toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + Math.max(0, hOut).toFixed(1) + '" rx="2" fill="var(--c-output)"/>' +
            '</g>');
        }
      });
    } else {
      parts.push('<path d="' + area + '" fill="url(#g-area)"/>');
      parts.push('<path d="' + line + '" fill="none" stroke="' + (isCost ? 'var(--c-output)' : 'var(--accent)') + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>');
    }

    // 0 token 的日子占着 X 轴上的一格，曲线自己落到基线就够了。
    // 不再给每个空日子打点：一天一个空心圈连成串，比空白本身还扎眼。
    // 数量交给副标题，hover 到这些日子显示「无用量」。

    // 超出纵轴的日子在顶部打一个橙色尖角：平顶不等于「峰值就这么高」
    series.forEach((item, index) => {
      if (valOf(item) <= ceiling) return;
      const x = points[index].x;
      parts.push('<path d="M ' + (x - 4.5).toFixed(1) + ' ' + (padT + 6).toFixed(1) +
        ' L ' + x.toFixed(1) + ' ' + (padT - 1).toFixed(1) +
        ' L ' + (x + 4.5).toFixed(1) + ' ' + (padT + 6).toFixed(1) + ' Z" fill="var(--warn)">' +
        '<title>' + dayLabel(item.day) + ' 实际 ' + fmtVal(valOf(item)) + '，超出纵轴</title></path>');
    });

    // 今天：实心点；正在悬停：竖线 + 空心点
    const todayIndex = series.findIndex(item => item.day === todayKey);
    if (todayIndex >= 0) {
      parts.push('<circle cx="' + points[todayIndex].x.toFixed(1) + '" cy="' + points[todayIndex].y.toFixed(1) + '" r="3.2" fill="var(--accent)" stroke="var(--panel)" stroke-width="2"/>');
    }

    if (state.hover >= 0 && state.hover < series.length) {
      const hx = points[state.hover].x;
      parts.push('<line x1="' + hx.toFixed(1) + '" y1="' + padT + '" x2="' + hx.toFixed(1) + '" y2="' + bottom.toFixed(1) + '" stroke="var(--accent)" stroke-width="1" stroke-dasharray="3 3" opacity="0.42" vector-effect="non-scaling-stroke"/>');
      parts.push('<circle cx="' + hx.toFixed(1) + '" cy="' + points[state.hover].y.toFixed(1) + '" r="4.2" fill="var(--panel)" stroke="var(--accent)" stroke-width="2.2"/>');
    }

    // X 轴：首、中、尾
    const labelIndexes = new Set([0, series.length - 1, Math.round((series.length - 1) / 2)]);
    const lastIndex = series.length - 1;
    series.forEach((item, index) => {
      if (!labelIndexes.has(index)) return;
      // 首尾对齐到绘图区边界：字号放大后居中会把日期切掉一半
      const anchor = series.length === 1 ? "middle" : index === 0 ? "start" : index === lastIndex ? "end" : "middle";
      const x = series.length === 1 ? xAt(index) : index === 0 ? padL : index === lastIndex ? padL + innerW : xAt(index);
      parts.push('<text class="axis-text" x="' + x.toFixed(1) + '" y="' + (height - 6) + '" text-anchor="' + anchor + '">' + dayLabel(item.day) + '</text>');
    });

    svg.setAttribute("viewBox", "0 0 " + width + " " + height);
    svg.removeAttribute("preserveAspectRatio");
    svg.innerHTML = parts.join("");

    // ------------------------------------------------------------------
    // 概要：四个指标横排，不再压成一行小字
    // ------------------------------------------------------------------
    const sumRange = series.reduce((acc, item) => acc + item.totalTokens, 0);
    const sumRecords = series.reduce((acc, item) => acc + item.records, 0);
    const activeDays = activeCount || series.length;
    const avg = activeDays ? sumRange / activeDays : 0;
    const peak = series.reduce((acc, item) => (!acc || item.totalTokens > acc.totalTokens ? item : acc), null);

    const days = rangeDays();
    const firstDay = series[0].day;
    const lastDay = series[series.length - 1].day;
    const clippedNote = clipped.length
      ? " · 纵轴 " + fmtTokens(ceiling) + "，" + clipped.length + " 天超出（峰值 " + fmtTokens(max) + "）"
      : "";
    $("chart-sub").textContent = (days === 0 ? "全部时间" : "最近 " + days + " 天") +
      " · " + dayLabel(firstDay) + " – " + dayLabel(lastDay) + " · " + activeCount + " 天有记录" +
      (blankCount ? " · " + blankCount + " 天零用量" : "") + clippedNote;

    // 环比：跟紧挨着的前一段等长区间比
    let compareValue = "—";
    let compareNote = "—";
    const detail = state.detail;
    if (detail && detail.series) {
      if (days > 0) {
        const all = detail.series;
        // 按日历取紧挨着的上一段等长区间：首日可能完全没有记录，不能靠 findIndex 定位
        const start = parseDayKey(firstDay);
        start.setDate(start.getDate() - days);
        const prevStart = localDayKey(start);
        const prev = all.filter(item => item.day >= prevStart && item.day < firstDay);
        const prevSum = prev.reduce((acc, item) => acc + item.totalTokens, 0);
        if (prevSum > 0) {
          const ratio = sumRange / prevSum;
          const delta = (ratio - 1) * 100;
          compareValue = delta >= 300 || delta <= -90
            ? "×" + ratio.toFixed(ratio >= 10 ? 0 : 1)
            : (delta >= 0 ? "+" : "") + Math.round(delta) + "%";
          compareNote = "上期 " + fmtTokens(prevSum);
        }
      } else {
        compareValue = series.length + " 天";
        compareNote = "自 " + dayLabel(firstDay);
      }
    }

    // 区间花费：按区间内每天、每个模型各自的单价现算
    const costRange = rangeCost();

    const cells = [
      ["区间用量", fmtTokens(sumRange), series.length + " 天"],
      ["区间花费", fmtMoney(costRange), "USD"],
      ["日均", fmtTokens(avg), activeDays + " 天 · " + fmtCount(sumRecords) + " 请求"],
      ["单日峰值", peak ? fmtTokens(peak.totalTokens) : "—", peak ? dayLabel(peak.day) : ""],
      ["环比", compareValue, compareNote]
    ];
    $("chart-summary").innerHTML = cells.map(([label, value, note]) =>
      '<div><div class="k">' + label + '</div><div class="v">' + value +
      (note ? '<small>' + note + '</small>' : '') + '</div></div>'
    ).join("");

    $("chart-badge").textContent = state.source === "overview"
      ? "全平台汇总 · 本地日志"
      : state.source === "workbuddy"
        ? "WorkBuddy · 本地日志"
        : state.source === "antigravity"
          ? "Antigravity · 本地日志"
          : "Codex · 本地日志";
  }

  // 悬停提示
  function bindChartHover() {
    const svg = $("chart");
    const tip = $("tip");

    svg.addEventListener("mousemove", event => {
      const series = rangeSeries();
      if (!series.length) return;
      const rect = svg.getBoundingClientRect();
      const padL = 40, padR = 12;
      const innerW = rect.width - padL - padR;
      const step = series.length === 1 ? 0 : innerW / (series.length - 1);
      const x = event.clientX - rect.left - padL;
      const index = step ? Math.max(0, Math.min(series.length - 1, Math.round(x / step))) : 0;
      if (index !== state.hover) {
        state.hover = index;
        renderChart();
      }
      const item = series[index];
      const empty = item.totalTokens <= 0 && !item.records;
      const cached = Math.max(0, item.cachedInputTokens);
      const uncached = Math.max(0, (item.inputTokens || 0) - cached);
      const speed = state.detail && state.detail.throughput ? state.detail.throughput.days[item.day] : null;
      const rows = (empty
        ? ['<div class="tip-row"><span>状态</span><b>无记录</b></div>']
        : [
          '<div class="tip-row"><span>合计</span><b>' + fmtTokens(item.totalTokens) + '</b></div>',
          '<div class="tip-row"><span>缓存命中</span><b>' + fmtTokens(cached) + '</b></div>',
          '<div class="tip-row"><span>输入</span><b>' + fmtTokens(uncached) + '</b></div>',
          '<div class="tip-row"><span>输出</span><b>' + fmtTokens(item.outputTokens) + '</b></div>',
          '<div class="tip-row"><span>请求</span><b>' + fmtCount(item.records) + '</b></div>',
          speed && speed.tps ? '<div class="tip-row"><span>速度</span><b>' + speed.tps.toFixed(1) + ' tok/s</b></div>' : ''
        ]).join("");
      tip.innerHTML = '<div class="tip-title">' + item.day +
        (item.day === localDayKey(new Date()) ? " · 今天" : "") +
        (empty ? " · 无用量" : "") + '</div>' + rows;
      const px = step ? padL + index * step : padL + innerW / 2;
      tip.style.left = Math.min(Math.max(px, 90), rect.width - 90) + "px";
      tip.style.top = (event.clientY - rect.top - 12) + "px";
      tip.classList.add("show");
    });

    svg.addEventListener("mouseleave", () => {
      tip.classList.remove("show");
      if (state.hover !== -1) {
        state.hover = -1;
        renderChart();
      }
    });
  }

  // ---------------------------------------------------------------------
  // 渲染：分布
  // ---------------------------------------------------------------------
  function renderBars(container, items, options) {
    const nameKey = options.nameKey;
    const emptyText = options.empty;

    if (!items.length) {
      container.innerHTML = '<div class="empty">' + emptyText + '</div>';
      return;
    }

    // 2.3.3：全量渲染。以前这里 slice(0, 6) + 「其他 N 项」，剩下的条目
    // 既看不到也点不开；现在卡片固定 244px 滚动，所有条目都能往下翻到。
    // items 已按 totalTokens 倒序，比例条仍以最大一项为满格。
    const max = Math.max.apply(null, items.map(item => item.share).concat([0.0001]));
    const scrollTop = container.scrollTop || 0;
    const openName = options.openName || null;

    container.innerHTML = items.map(item => {
      const width = Math.max(1.5, (item.share / max) * 100);
      const decorated = options.decorate ? options.decorate(item) : {};
      const extraHtml = decorated.extraHtml || (item.extra ? escapeHtml(item.extra) : "");
      const label = decorated.label || item.label || "";
      const detail = options.detail ? options.detail(item) : "";
      const open = openName !== null && openName === item[nameKey] && detail;
      const input = Math.max(0, Number(item.inputTokens) || 0);
      const cached = Math.min(input, Math.max(0, Number(item.cachedInputTokens) || 0));
      const fresh = Math.max(0, input - cached);
      const out = Math.max(0, Number(item.outputTokens) || 0);
      const sum = fresh + cached + out;
      const trackHtml = sum > 0
        ? '<i class="seg-in" style="width:' + ((fresh / sum) * width).toFixed(1) + '%"></i>' +
          '<i class="seg-cache" style="width:' + ((cached / sum) * width).toFixed(1) + '%"></i>' +
          '<i class="seg-out" style="width:' + ((out / sum) * width).toFixed(1) + '%"></i>'
        : '<i style="width:' + width.toFixed(1) + '%"></i>';
      return [
        '<div class="bar-row' + (open ? ' open' : '') + '" data-name="' + escapeHtml(item[nameKey]) + '"' + (label ? ' title="' + escapeHtml(label) + '"' : '') + '>',
        '  <span class="bar-name">' + escapeHtml(item[nameKey]) + '</span>',
        '  <span class="bar-val"><b>' + fmtPercent(item.share * 100, 1) + '</b> · ' + fmtTokens(item.totalTokens) +
          (extraHtml ? ' · <span class="bar-extra">' + extraHtml + '</span>' : '') + '</span>',
        '  <span class="bar-track">' + trackHtml + '</span>',
        detail ? '  <div class="bar-detail"' + (open ? '' : ' hidden') + '>' + detail + '</div>' : '',
        '</div>'
      ].join("");
    }).join("");
    // 重渲染（切区间 / 手动刷新）后仍停在同一位置，不然翻到第 70 项就被弹回顶部
    container.scrollTop = scrollTop;
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /** 两张分布卡共用的行尾格式：花费 + 输出速度 */
  function distExtra(item) {
    return '<span class="bar-money">' + fmtMoney(item.cost || 0) + '</span>' +
      '<span class="bar-sep"> · </span>' +
      (item.tps
        ? '<span class="bar-speed">' + item.tps.toFixed(1) + ' tok/s</span>'
        : '<span class="bar-none">—</span>');
  }

  function distLabel(item) {
    return (rangeDays() === 0 ? "全部时间" : "最近 " + rangeDays() + " 天") +
      " · " + fmtMoney(item.cost || 0) +
      (item.tps ? " · " + item.tps.toFixed(1) + " tok/s（" + fmtCount(item.turns || 0) + " 轮）" : " · 无速度样本");
  }

  /** 点分布行展开的四档明细，和请求明细同口径：新增输入 = input − 缓存命中 */
  function distDetail(item) {
    const input = item.inputTokens || 0;
    const cached = Math.min(input, item.cachedInputTokens || 0);
    const parts = [
      '新增输入 <b>' + fmtTokens(input - cached) + '</b>',
      '缓存命中 <b>' + fmtTokens(cached) + '</b>',
      '输出 <b>' + fmtTokens(item.outputTokens || 0) + '</b>',
      '请求 <b>' + fmtCount(item.records || 0) + '</b>',
      '花费 <b>' + fmtMoney(item.cost || 0) + '</b>'
    ];
    if (item.tps) parts.push('速度 <b>' + item.tps.toFixed(1) + ' tok/s</b>（' + fmtCount(item.turns || 0) + ' 轮）');
    return parts.join(' · ');
  }

  /** 项目分布展开：四档明细 + 该项目使用的模型及占比 */
  function projectDetail(item) {
    const summary = distDetail(item);
    const models = item.models || [];
    if (!models.length) return summary;
    const rows = models.map(m => {
      const pct = Math.max(0, Math.min(100, (m.share || 0) * 100));
      return [
        '<div class="proj-model-row">',
        '  <span class="proj-model-name">' + escapeHtml(m.model) + '</span>',
        '  <span class="proj-model-bar"><i style="width:' + Math.max(2, pct).toFixed(1) + '%"></i></span>',
        '  <span class="proj-model-stat"><b>' + fmtPercent(pct, 1) + '</b> · ' + fmtTokens(m.totalTokens) + ' · ' + fmtMoney(m.cost || 0) + '</span>',
        '</div>'
      ].join("");
    }).join("");
    return summary + '<div class="proj-models">' + rows + '</div>';
  }

  const DONUT_COLORS = ["#3f6ef0", "#10a37f", "#f0a33c", "#8b5cf6", "#ec4899", "#94a3b8"];

  function renderDonut(container, items, nameKey, unitWord) {
    if (!container) return;
    if (!items || !items.length) {
      container.innerHTML = "";
      return;
    }
    const top = items.slice(0, 5);
    const rest = items.slice(5);
    const slices = top.map((it, idx) => ({
      name: it[nameKey],
      share: it.share || 0,
      tokens: it.totalTokens || 0,
      color: DONUT_COLORS[idx % DONUT_COLORS.length],
      clickable: true
    }));
    if (rest.length) {
      const restShare = rest.reduce((a, b) => a + (b.share || 0), 0);
      const restTokens = rest.reduce((a, b) => a + (b.totalTokens || 0), 0);
      slices.push({
        name: "其余 " + rest.length + " 项",
        share: restShare,
        tokens: restTokens,
        color: DONUT_COLORS[5],
        clickable: false
      });
    }
    const r = 38, c = 2 * Math.PI * r;
    let offset = 0;
    const arcs = slices.map((s, idx) => {
      const len = Math.max(0, s.share) * c;
      const dash = len.toFixed(2) + " " + Math.max(0, c - len).toFixed(2);
      const rot = ((offset / c) * 360 - 90).toFixed(2);
      offset += len;
      return '<circle class="donut-slice" data-idx="' + idx + '"' +
        (s.clickable ? ' data-pick="' + escapeHtml(s.name) + '"' : '') +
        ' cx="54" cy="54" r="' + r + '" fill="none" stroke="' + s.color + '" stroke-width="12" ' +
        'stroke-dasharray="' + dash + '" transform="rotate(' + rot + ' 54 54)">' +
        '<title>' + escapeHtml(s.name) + ' · ' + fmtPercent(s.share * 100, 1) + ' (' + fmtTokens(s.tokens) + ')</title></circle>';
    }).join("");

    const lead = slices[0];
    const svg = '<svg class="donut-svg" viewBox="0 0 108 108" aria-hidden="true">' +
      '<circle cx="54" cy="54" r="' + r + '" fill="none" stroke="var(--line-soft)" stroke-width="12"/>' +
      arcs +
      '<text class="donut-center-num" x="54" y="53" text-anchor="middle">' + fmtPercent((lead ? lead.share : 0) * 100, 0) + '</text>' +
      '<text class="donut-center-sub" x="54" y="67" text-anchor="middle">' + items.length + ' ' + unitWord + '</text>' +
      '</svg>';

    const legend = '<div class="donut-legend">' + slices.map((s, idx) =>
      '<div class="donut-item" data-idx="' + idx + '"' + (s.clickable ? ' data-pick="' + escapeHtml(s.name) + '"' : '') + '>' +
      '<span class="donut-dot" style="background:' + s.color + '"></span>' +
      '<span class="donut-name" title="' + escapeHtml(s.name) + '">' + escapeHtml(s.name) + '</span>' +
      '<span class="donut-pct">' + fmtPercent(s.share * 100, 1) + '</span>' +
      '</div>'
    ).join("") + '</div>';

    container.innerHTML = svg + legend;
  }

  function renderModels() {
    const models = rangeModels();
    for (const item of models) {
      item.cost = bucketCost(item, unitFor(item.model));
    }
    renderDonut($("model-donut"), models, "model", "模型");
    renderBars($("models"), models, {
      nameKey: "model",
      empty: "此区间没有模型数据",
      openName: state.openBars.models,
      detail: distDetail,
      decorate: item => ({ extraHtml: distExtra(item), label: distLabel(item) })
    });
    const totalCost = models.reduce((acc, item) => acc + (item.cost || 0), 0);
    $("model-badge").textContent = fmtMoney(totalCost) + " · " +
      (rangeDays() === 0 ? "全部时间" : "最近 " + rangeDays() + " 天") + " · " + models.length + " 项";
  }

  function renderProjects() {
    const projects = rangeProjects();
    renderDonut($("project-donut"), projects, "project", "项目");
    renderBars($("projects"), projects, {
      nameKey: "project",
      empty: "此区间没有项目数据",
      openName: state.openBars.projects,
      detail: projectDetail,
      decorate: item => ({ extraHtml: distExtra(item), label: distLabel(item) })
    });
    const totalCost = projects.reduce((acc, item) => acc + (item.cost || 0), 0);
    $("project-badge").textContent = fmtMoney(totalCost) + " · " +
      (rangeDays() === 0 ? "全部时间" : "最近 " + rangeDays() + " 天") + " · " + projects.length + " 项";
  }

  function renderHours() {
    const detail = state.detail;
    const container = $("hours");
    if (!detail) {
      container.innerHTML = "";
      return;
    }
    const hasSpeed = Boolean(detail.throughput);
    const isHeatmap = state.hourMetric === "heatmap";
    const speedMode = hasSpeed && state.hourMetric === "speed";
    $("hour-tabs").hidden = false;
    const speedBtn = $("hour-tabs").querySelector('button[data-metric="speed"]');
    if (speedBtn) speedBtn.hidden = !hasSpeed;
    $("hour-title").textContent = isHeatmap ? "活跃热力图" : speedMode ? "活跃时段 · tok/s" : "活跃时段";
    if (isHeatmap) {
      const series = detail.series || [];
      const byDay = new Map(series.map(d => [d.day, d]));
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const totalDays = 140;
      const start = new Date(today);
      start.setDate(start.getDate() - totalDays + 1);
      // 对齐到周一作为网格第一行
      const shift = (start.getDay() + 6) % 7;
      start.setDate(start.getDate() - shift);
      const cells = [];
      let maxVal = 0;
      let activeDays = 0;
      let sumTokens = 0;
      for (let d = new Date(start); d <= today; d.setDate(d.getDate() + 1)) {
        const key = localDayKey(d);
        const row = byDay.get(key);
        const val = row ? (row.totalTokens || 0) : 0;
        if (val > 0) {
          activeDays += 1;
          sumTokens += val;
          if (val > maxVal) maxVal = val;
        }
        cells.push({ key, val, row });
      }
      const levelOf = v => {
        if (v <= 0 || maxVal <= 0) return 0;
        const r = v / maxVal;
        if (r >= 0.75) return 4;
        if (r >= 0.45) return 3;
        if (r >= 0.18) return 2;
        return 1;
      };
      $("hour-badge").textContent = "近 20 周 · " + activeDays + " 天活跃 · " + fmtTokens(sumTokens);
      container.innerHTML = '<div class="heatmap-wrap">' +
        '<div class="heatmap-grid">' +
        cells.map(c => '<span class="hm-cell" data-lv="' + levelOf(c.val) + '" title="' + c.key + ' · ' +
          (c.val > 0 ? fmtTokens(c.val) + ' tokens · ' + fmtMoney((c.row && c.row.cost) || 0) + ' · ' + fmtCount((c.row && c.row.records) || 0) + ' 请求' : '无用量') +
          '"></span>').join("") +
        '</div>' +
        '<div class="heatmap-foot"><span>' + cells[0].key + ' – ' + cells[cells.length - 1].key + '</span>' +
        '<span class="heatmap-scale">少<i class="hm-cell" data-lv="0"></i><i class="hm-cell" data-lv="1"></i><i class="hm-cell" data-lv="2"></i><i class="hm-cell" data-lv="3"></i><i class="hm-cell" data-lv="4"></i>多</span></div>' +
        '</div>';
      return;
    }
    const days = rangeSeries().map(item => item.day);
    const values = new Array(24).fill(0);
    const turns = new Array(24).fill(0);
    let sampled = 0;
    /** 区间内每天的小时数据：tokens 来自日志+历史基线，速度只来自本机日志 */
    const tokenByDay = detail.dailyHours || {};
    const speedByDay = (detail.throughput && detail.throughput.dayHours) || {};

    if (speedMode) {
      // 每小时的完成轮速度：输出 tokens ÷ 耗时，按当前区间逐天累加
      const acc = Array.from({ length: 24 }, () => ({ output: 0, duration: 0, turns: 0 }));
      for (const day of days) {
        const cells = speedByDay[day];
        if (!cells) continue;
        sampled += 1;
        cells.forEach((cell, hour) => {
          if (!cell || !cell.durationMs) return;
          acc[hour].output += cell.outputTokens;
          acc[hour].duration += cell.durationMs;
          acc[hour].turns += cell.turns;
        });
      }
      acc.forEach((cell, hour) => {
        values[hour] = cell.duration > 0 ? cell.output * 1000 / cell.duration : 0;
        turns[hour] = cell.turns;
      });
    } else {
      for (const day of days) {
        const row = tokenByDay[day];
        if (!row) continue;
        for (let hour = 0; hour < 24; hour += 1) values[hour] += row[hour] || 0;
      }
    }

    const max = Math.max.apply(null, values.concat([0.0001]));
    const total = values.reduce((acc, value) => acc + value, 0);
    const peakHour = values.indexOf(Math.max.apply(null, values));
    const span = rangeDays() === 0 ? "全部时间" : "最近 " + rangeDays() + " 天";
    const turnTotal = turns.reduce((acc, value) => acc + value, 0);
    $("hour-badge").textContent = speedMode
      // 速度只统计得到日志里还有原始耗时的那些天，样本不足时要说清楚
      ? span + " · " + turnTotal + " 轮" + (sampled > 0 && sampled < days.length ? " · 有样本 " + sampled + " 天" : "")
      : span + " · " + fmtTokens(total) + (total > 0 ? " · 峰值 " + peakHour + ":00" : "");

    container.innerHTML = values.map((value, hour) => {
      const ratio = max > 0 ? value / max : 0;
      const height = value > 0 ? Math.max(3, ratio * 72) : 2;
      const title = speedMode
        ? hour + ":00 · " + value.toFixed(1) + " tok/s · " + turns[hour] + " 轮"
        : hour + ":00 · " + fmtTokens(value) + " tokens";
      const style = value > 0
        ? "height:" + height.toFixed(1) + "px;opacity:" + (0.4 + ratio * 0.6).toFixed(2)
        : "height:2px;background:var(--line)";
      const peak = value > 0 && hour === peakHour;
      // 峰值整点强制显示标签，哪怕它不在 3 的倍数上
      const label = hour % 3 === 0 || peak ? hour : "";
      return [
        '<div class="hour-col' + (peak ? " is-peak" : "") + '" title="' + title + '">',
        '  <div class="hour-bar" style="' + style + '"></div>',
        '  <div class="hour-label">' + label + '</div>',
        '</div>'
      ].join("");
    }).join("");
  }

  /**
   * 一行「模型明细」的六个数字列。新增输入 = input - cached（input 含缓存命中），
   * 与成本公式、CC Switch 的 billable_input_tokens 是同一口径。
   */
  function modelDetailCells(d) {
    const input = Number(d.inputTokens) || 0;
    const cached = Math.min(input, Math.max(0, Number(d.cachedInputTokens) || 0));
    const fresh = Math.max(0, input - cached);
    return [
      '<td class="num">' + fmtTokens(fresh) + '</td>',
      '<td class="num">' + fmtTokens(cached) + '</td>',
      '<td class="num">' + fmtTokens(d.outputTokens) + '</td>',
      '<td class="num">' + fmtTokens(d.totalTokens) + '</td>',
      '<td class="num">' + fmtCount(d.records) + '</td>',
      '<td class="num bar-money">' + fmtMoney(d.cost) + '</td>'
    ].join("");
  }

  /** 模型名永远完整显示：允许换行，鼠标停上去还有原名 */
  function modelNameCell(d) {
    return '<td class="model-cell" title="' + escapeHtml(d.model) + '">' +
      escapeHtml(d.model) +
      (d.estimated ? ' <span class="muted">估算</span>' : '') +
      '</td>';
  }

  /** 点开会话行后的展开面板：一行一个模型，外加完整路径与时间范围 */
  function sessionDetailHtml(item) {
    const details = item.modelDetails || [];
    const stampText = value => value ? escapeHtml(String(value).replace("T", " ").slice(0, 19)) : "";
    const meta = [
      item.cwd ? escapeHtml(item.cwd) : "无本地路径",
      item.firstAt ? "始于 " + stampText(item.firstAt) : "",
      item.lastAt ? "止于 " + stampText(item.lastAt) : "",
      item.files ? item.files + " 个日志" : ""
    ].filter(Boolean).join(" · ");
    const body = details.length
      ? details.map(d => '<tr>' + modelNameCell(d) + modelDetailCells(d) + '</tr>').join("")
      : '<tr><td colspan="7" class="empty">该会话没有可展开的模型明细</td></tr>';
    return [
      '<tr class="detail-row"><td colspan="8">',
      '  <div class="detail-panel">',
      '    <div class="detail-meta">' + meta + '</div>',
      '    <table class="detail-table">',
      '      <thead><tr>',
      '        <th>模型</th>',
      '        <th style="text-align:right">新增输入</th>',
      '        <th style="text-align:right">缓存命中</th>',
      '        <th style="text-align:right">输出</th>',
      '        <th style="text-align:right">用量</th>',
      '        <th style="text-align:right">请求</th>',
      '        <th style="text-align:right">花费</th>',
      '      </tr></thead>',
      '      <tbody>' + body + '</tbody>',
      '    </table>',
      '  </div>',
      '</td></tr>'
    ].join("");
  }

  function filterSessions(list) {
    const q = (state.sessionQuery || "").trim().toLowerCase();
    if (!q) return list;
    return list.filter(item => {
      if (String(item.project || "").toLowerCase().includes(q)) return true;
      if (String(item.cwd || "").toLowerCase().includes(q)) return true;
      return (item.models || []).some(m => String(m).toLowerCase().includes(q));
    });
  }

  /** 视图一：按会话汇总，模型名全部列出、不再折叠成 +N；点行展开明细 */
  function renderSessionRows() {
    const detail = state.detail;
    const body = $("session-body");
    if (!detail || !detail.sessionList.length) {
      body.innerHTML = '<tr><td colspan="8" class="empty">暂无会话记录</td></tr>';
      $("session-badge").textContent = "0";
      return;
    }

    const isWorkBuddy = detail.source === "workbuddy";
    $("th-speed").textContent = "速度";
    const filtered = filterSessions(detail.sessionList);
    $("session-badge").textContent = state.sessionQuery
      ? filtered.length + " / " + detail.sessions + " 个会话"
      : detail.sessions + " 个会话";

    const rows = filtered.slice(0, 60);
    body.innerHTML = rows.map(item => {
      const details = item.modelDetails || [];
      // 多模型时逐个 chips 换行列出，并带上该模型在本会话里的用量占比
      const chips = details.length
        ? details.map(d => {
          const pct = item.totalTokens ? (d.totalTokens / item.totalTokens) * 100 : 0;
          return '<span class="chip" title="' + escapeHtml(d.model) + ' · ' + fmtTokens(d.totalTokens) +
            ' tokens · ' + pct.toFixed(1) + '%">' + escapeHtml(d.model) +
            '<small>· ' + pct.toFixed(0) + '%</small></span>';
        }).join("")
        : ((item.models || []).map(m => '<span class="chip">' + escapeHtml(m) + '</span>').join("") || '<span class="muted">—</span>');
      const span = item.firstAt && item.lastAt ? new Date(item.lastAt).getTime() - new Date(item.firstAt).getTime() : 0;
      const speedCell = item.tps
        ? item.tps.toFixed(1) + ' <span class="muted">tok/s</span>'
        : (isWorkBuddy && item.credit ? item.credit.toFixed(1) + ' <span class="muted">积分</span>' : '<span class="muted">—</span>');
      const open = state.openSession === item.id;
      return [
        '<tr class="session-row' + (open ? ' is-open' : '') + '" data-session="' + escapeHtml(item.id) + '">',
        '  <td class="muted" title="' + escapeHtml(item.lastAt || "") + '">' + relTime(item.lastAt) + '</td>',
        '  <td class="proj" title="' + escapeHtml(item.cwd || "") + '"><span class="row-caret">▸</span>' + escapeHtml(item.project) + '</td>',
        '  <td class="model-cell"><div class="model-chips">' + chips + '</div></td>',
        '  <td class="num">' + fmtTokens(item.totalTokens) + '</td>',
        '  <td class="num">' + fmtCount(item.records) + '</td>',
        '  <td class="num bar-money">' + (item.cost ? fmtMoney(item.cost) : '<span class="muted">—</span>') + '</td>',
        '  <td class="num">' + speedCell + '</td>',
        '  <td class="num muted col-duration">' + fmtDuration(span) + '</td>',
        '</tr>',
        open ? sessionDetailHtml(item) : ''
      ].join("");
    }).join("");
  }

  /** 视图二：CC Switch 式请求日志，一行一个「会话 × 模型」，字段逐项摊开 */
  function renderLog() {
    const detail = state.detail;
    const body = $("log-body");
    if (!detail || !detail.sessionList.length) {
      body.innerHTML = '<tr><td colspan="10" class="empty">暂无请求明细</td></tr>';
      $("session-badge").textContent = "0";
      return;
    }

    const rows = [];
    for (const item of detail.sessionList) {
      for (const d of (item.modelDetails || [])) rows.push({ item, d });
    }
    rows.sort((a, b) =>
      String(b.item.lastAt || "").localeCompare(String(a.item.lastAt || "")) || b.d.totalTokens - a.d.totalTokens);

    const LIMIT = 400;
    const shown = rows.slice(0, LIMIT);
    $("session-badge").textContent = detail.sessions + " 个会话 · " + rows.length + " 行";

    body.innerHTML = shown.map(({ item, d }) => {
      const speed = item.tps
        ? item.tps.toFixed(1) + ' <span class="muted">tok/s</span>'
        : '<span class="muted">—</span>';
      return [
        '<tr>',
        '  <td class="muted" title="' + escapeHtml(item.lastAt || "") + '">' + relTime(item.lastAt) + '</td>',
        '  <td class="proj" title="' + escapeHtml(item.cwd || "") + '">' + escapeHtml(item.project) + '</td>',
        modelNameCell(d),
        modelDetailCells(d),
        '  <td class="num">' + speed + '</td>',
        '</tr>'
      ].join("");
    }).join("") + (rows.length > LIMIT
      ? '<tr><td colspan="10" class="log-note">共 ' + rows.length + ' 行，按最近活动只显示前 ' + LIMIT + ' 行</td></tr>'
      : "");
  }

  function renderSessions() {
    const isLog = state.logView === "requests";
    $("session-table").hidden = isLog;
    $("log-table").hidden = !isLog;
    for (const button of $("session-tabs").querySelectorAll("button[data-view]")) {
      button.setAttribute("aria-pressed", String(button.dataset.view === state.logView));
    }
    if (isLog) renderLog(); else renderSessionRows();
  }

  function renderStatus() {
    const detail = state.detail;
    const dot = $("status-dot");
    if (!detail) {
      $("status-text").textContent = "正在读取本地会话日志…";
      return;
    }
    dot.setAttribute("data-tone", detail.builtAt ? "" : "muted");
    const sourcePrefix = detail.source === "overview"
      ? "总览 · "
      : detail.source === "workbuddy"
        ? "WorkBuddy · "
        : detail.source === "antigravity"
          ? "Antigravity · "
          : "Codex · ";
    $("status-text").textContent =
      sourcePrefix +
      detail.scannedFiles + " 个日志 · " + detail.sessions + " 个会话 · " +
      (detail.builtAt ? new Date(detail.builtAt).toLocaleString("zh-CN", { hour12: false }) : "—");

    const legacyDays = detail.baseline && detail.baseline.days ? detail.baseline.days : detail.series.length;
    $("brand-sub").textContent = fmtTokens(detail.totals.totalTokens) +
      (detail.cost ? " · " + fmtMoney(detail.cost.cny) : "") +
      (legacyDays ? " · " + legacyDays + "d" : "");
    const titleEl = $("top-title");
    if (titleEl) {
      titleEl.textContent = detail.source === "overview"
        ? "全平台总览"
        : detail.source === "codex" || !detail.source
          ? "Codex 用量看板"
          : detail.source === "antigravity"
            ? "Antigravity 用量看板"
            : "WorkBuddy 用量看板";
    }
    for (const key of ["overview", "codex", "antigravity", "workbuddy"]) {
      const pill = $("nav-tok-" + key);
      const d = state.data[key];
      if (pill) pill.textContent = d && d.totals ? fmtTokens(d.totals.totalTokens) : "—";
    }
    const sq = $("sidebar-quotas");
    if (sq) {
      const qRows = [];
      const codex5h = state.status && state.status.quota && state.status.quota.session;
      if (codex5h) {
        const pct = Math.max(0, Math.min(100, codex5h.usedPercent || 0));
        qRows.push('<div class="sq-row"><div class="sq-head"><span>Codex 5h</span><b>' + Math.round(pct) + '%</b></div><div class="sq-bar"><i style="width:' + pct + '%;background:#6366f1"></i></div></div>');
      }
      const agyGem = state.status && state.status.antigravityQuota && state.status.antigravityQuota.gemini && state.status.antigravityQuota.gemini.primary;
      if (agyGem) {
        const pct = Math.max(0, Math.min(100, agyGem.usedPercent || 0));
        qRows.push('<div class="sq-row"><div class="sq-head"><span>AGY Gemini</span><b>' + Math.round(pct) + '%</b></div><div class="sq-bar"><i style="width:' + pct + '%;background:#f59e0b"></i></div></div>');
      }
      sq.innerHTML = qRows.join("");
    }
    if (typeof syncAuthTopLabel === "function") syncAuthTopLabel();
  }

  function renderAll() {
    renderStats();
    renderAgentStrip();
    renderChart();
    renderModels();
    renderProjects();
    renderHours();
    renderSessions();
    renderStatus();
  }
