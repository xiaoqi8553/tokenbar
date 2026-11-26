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
  function quotaCard(title, fallbackWindow, quotaWindow) {
    const windowLabel = quotaWindow && quotaWindow.windowMinutes
      ? (quotaWindow.windowMinutes >= 1440
        ? Math.round(quotaWindow.windowMinutes / 1440) + " 天窗口"
        : Math.round(quotaWindow.windowMinutes / 60) + " 小时窗口")
      : fallbackWindow;

    if (!quotaWindow) {
      return {
        label: title,
        window: windowLabel,
        num: "—",
        unit: "",
        hideMeter: true,
        foot: "暂无配额快照",
        hints: ["跑一次 Codex 就能拿到额度"]
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
    if (tokens !== null) hints.push("窗口内 " + fmtTokens(tokens) + " tokens");
    if (resetMs) hints.push(fmtClock(resetMs) + " 重置");

    return {
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
    let deltaText = "昨日同期无数据";
    if (yesterdaySameTime > 0) {
      const delta = ((total - yesterdaySameTime) / yesterdaySameTime) * 100;
      deltaText = "较昨日同期 " + (delta >= 0 ? "+" : "") + Math.round(delta) + "%";
    }

    const freshInput = today ? Math.max(0, today.inputTokens - today.cachedInputTokens) : 0;
    return {
      label: "今日用量",
      window: "00:00 起",
      num: today ? fmtTokens(total) : "—",
      unit: "tokens",
      hideMeter: true,
      foot: today
        ? "<b>" + fmtCount(today.records) + "</b> 次请求 · 缓存命中 <b>" + fmtPercent(cacheRate) + "</b>"
        : "今天还没有记录",
      hints: today
        ? [deltaText, "新增输入 " + fmtTokens(freshInput) + " · 输出 " + fmtTokens(today.outputTokens)]
        : []
    };
  }

  /** 累计用量卡：跟 WorkBuddy 那边对称，两边都六张卡 */
  function totalCard() {
    const detail = state.detail;
    const totals = detail && detail.totals ? detail.totals : null;
    if (!totals) {
      return {
        label: "累计用量",
        window: "全部时间",
        num: "—",
        unit: "tokens",
        hideMeter: true,
        foot: "暂无历史数据",
        hints: []
      };
    }
    const days = detail.series ? detail.series.length : 0;
    const cacheRate = totals.inputTokens ? (totals.cachedInputTokens / totals.inputTokens) * 100 : 0;
    return {
      label: "累计用量",
      window: days + " 天",
      num: fmtTokens(totals.totalTokens),
      unit: "tokens",
      hideMeter: true,
      foot: "<b>" + fmtCount(totals.sessions) + "</b> 个会话 · <b>" + fmtCount(totals.records) + "</b> 次请求",
      hints: ["缓存命中 " + fmtPercent(cacheRate)]
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
    if (recentSpeed) hints.push("近 14 天 " + recentSpeed.tps.toFixed(1) + " tok/s");
    if (todaySpeed && todaySpeed.ttftMs) hints.push("首字 " + fmtSpeed(todaySpeed.ttftMs));

    return {
      label: "输出速度",
      window: "整轮口径",
      num: todaySpeed ? todaySpeed.tps.toFixed(1) : "—",
      unit: todaySpeed ? "tok/s" : "",
      hideMeter: true,
      foot: todaySpeed
        ? "<b>" + fmtCount(todaySpeed.turns) + "</b> 轮完成"
        : "今天还没有完成的轮次",
      hints
    };
  }

  /** 累计花费卡：token 折算成钱，回答「这些用量等于花了多少」 */
  function costCard() {
    const detail = state.detail;
    const cost = detail && detail.cost;
    if (!cost) {
      return {
        label: "等价花费",
        window: "API 刊例价",
        num: "—",
        unit: "",
        hideMeter: true,
        foot: "还没算过价格",
        hints: []
      };
    }
    const days = detail.baseline && detail.baseline.days ? detail.baseline.days : detail.series.length;
    const totalTokens = detail.totals ? detail.totals.totalTokens : 0;
    const estimatedShare = totalTokens ? (cost.estimatedTokens || 0) / totalTokens : 0;

    return {
      label: "等价花费",
      window: "累计 " + days + " 天",
      num: fmtMoney(cost.cny),
      money: true,
      unit: "",
      hideMeter: true,
      // 详情都收进 tooltip：卡片上只留「多少钱 + 今日多少」
      title: "美元计价 · 按官方 API 刊例价折算" +
        (estimatedShare >= 0.005 ? " · 含 " + fmtPercent(estimatedShare * 100, 1) + " 估算用量" : ""),
      foot: "今日 <b>" + fmtMoney(cost.todayCny) + "</b> · " + fmtTokens(totalTokens) + " tokens",
      hints: detail.totals && detail.totals.records
        ? ["单次请求均摊 " + fmtMoney(cost.cny / detail.totals.records)]
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
    // 国际版写 ~/.workbuddy-ai，国内版写 ~/.workbuddy；同名会话只算体积更大的一份
    const rootHint = (detail.roots || [])
      .filter(item => item.files > 0)
      .map(item => "~/" + String(item.root).split(/[\\/]/).filter(Boolean).pop() + "/projects")
      .join(" + ") || "~/.workbuddy/projects";

    return [
      {
        label: "今日用量",
        window: "00:00 起",
        num: today ? fmtTokens(today.totalTokens) : "—",
        unit: "tokens",
        hideMeter: true,
        foot: today
          ? "<b>" + fmtCount(today.records) + "</b> 次调用 · 缓存 <b>" + fmtPercent(todayRate) + "</b>"
          : "今天还没有记录",
        hints: today
          ? ["输出 " + fmtTokens(today.outputTokens) + " · 推理 " + fmtTokens(today.reasoningOutputTokens)]
          : []
      },
      {
        label: "累计用量",
        window: detail.series.length + " 天",
        num: fmtTokens(totals.totalTokens),
        unit: "tokens",
        hideMeter: true,
        foot: "<b>" + fmtCount(totals.sessions) + "</b> 个会话 · <b>" + fmtCount(totals.records) + "</b> 次调用",
        hints: ["来源 " + rootHint]
      },
      {
        label: "等价花费",
        window: "累计",
        num: fmtMoney(detail.cost ? detail.cost.cny : 0),
        money: true,
        unit: "",
        hideMeter: true,
        title: "美元计价 · 按官方 API 刊例价折算",
        foot: "今日 <b>" + fmtMoney(detail.cost ? detail.cost.todayCny : 0) + "</b> · " + fmtTokens(totals.totalTokens) + " tokens",
        hints: []
      },
      {
        label: "积分消耗",
        window: "按调用累加",
        num: credits.total ? credits.total.toFixed(0) : "—",
        unit: "积分",
        hideMeter: true,
        foot: "今日 <b>" + (credits.today ? credits.today.toFixed(0) : "0") + "</b> 积分",
        hints: ["WorkBuddy 自己的计费口径"]
      },
      {
        label: "缓存命中率",
        window: "输入口径",
        num: fmtPercent(cacheRate, 1),
        unit: "命中",
        percent: cacheRate,
        level: "ok",
        foot: "命中 <b>" + fmtTokens(totals.cachedInputTokens) + "</b> · 输入 <b>" + fmtTokens(totals.inputTokens) + "</b>",
        hints: ["每轮重发上下文，命中越高越省"]
      },
      // 速度：function_call → function_call_result 的时间差算出来的整轮吞吐
      speedCard()
    ];
  }

  function antigravityCards() {
    const detail = state.detail;
    const totals = detail.totals;
    const today = detail.today;
    const cacheRate = totals.inputTokens ? (totals.cachedInputTokens / totals.inputTokens) * 100 : 0;
    const todayRate = today && today.inputTokens ? (today.cachedInputTokens / today.inputTokens) * 100 : 0;
    const ttftMs = detail.throughput && detail.throughput.ttftMs;
    const ttftTurns = detail.throughput && detail.throughput.turns ? detail.throughput.turns : 0;
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
      {
        label: "今日用量",
        window: "00:00 起",
        num: today ? fmtTokens(today.totalTokens) : "—",
        unit: "tokens",
        hideMeter: true,
        foot: today
          ? "<b>" + fmtCount(today.records) + "</b> 次调用 · 缓存 <b>" + fmtPercent(todayRate) + "</b>"
          : "今天还没有记录",
        hints: today
          ? ["新增输入 " + fmtTokens(Math.max(0, today.inputTokens - today.cachedInputTokens)) + " · 输出 " + fmtTokens(today.outputTokens)]
          : []
      },
      {
        label: "累计用量",
        window: detail.series.length + " 天",
        num: fmtTokens(totals.totalTokens),
        unit: "tokens",
        hideMeter: true,
        foot: "<b>" + fmtCount(totals.sessions) + "</b> 个会话 · <b>" + fmtCount(totals.records) + "</b> 次调用",
        hints: ["来源 " + rootHint]
      },
      {
        label: "等价花费",
        window: "累计",
        num: fmtMoney(detail.cost ? detail.cost.cny : 0),
        money: true,
        unit: "",
        hideMeter: true,
        title: "美元计价 · 按官方 API 刊例价折算",
        foot: "今日 <b>" + fmtMoney(detail.cost ? detail.cost.todayCny : 0) + "</b> · " + fmtTokens(totals.totalTokens) + " tokens",
        hints: ["按 CC Switch 同口径折算"]
      },
      {
        label: "缓存命中率",
        window: "输入口径",
        num: fmtPercent(cacheRate, 1),
        unit: "命中",
        percent: cacheRate,
        level: "ok",
        foot: "命中 <b>" + fmtTokens(totals.cachedInputTokens) + "</b> · 输入 <b>" + fmtTokens(totals.inputTokens) + "</b>",
        hints: ["input 已含缓存还原，不重复扣除"]
      },
      {
        label: "首字延迟",
        window: "TTFT 中位数",
        num: ttftMs !== null && ttftMs !== undefined ? fmtSpeed(ttftMs) : "—",
        unit: "",
        hideMeter: true,
        foot: ttftTurns
          ? "<b>" + fmtCount(ttftTurns) + "</b> 轮带原生计时"
          : "暂无原生计时样本",
        hints: ["来自 conversations/*.db"]
      },
      speedCard()
    ];
  }

  function renderStats() {
    const detail = state.detail;
    if (!detail && (state.source === "workbuddy" || state.source === "antigravity")) return;

    let cards;
    if (state.source === "workbuddy") {
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
      return [
        '<div class="stat"' + (card.title ? ' title="' + escapeHtml(card.title) + '"' : '') + '>',
        '  <div class="stat-top">',
        '    <span class="stat-label">' + escapeHtml(card.label) + '</span>',
        card.window ? '    <span class="stat-window">' + escapeHtml(card.window) + '</span>' : '',
        '  </div>',
        '  <div class="stat-value">',
        '    <span class="stat-num' + (card.money ? ' money' : '') + '">' + card.num + '</span>',
        '    <span class="stat-unit">' + (card.unit || "") + '</span>',
        '  </div>',
        '<div class="meter"' + (card.hideMeter ? ' style="visibility:hidden"' : '') + '><i data-level="' + level + '" style="width:' + Math.max(2, Math.min(100, card.percent)) + '%"></i>' + pace + '</div>',
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

    let max = 0;
    for (const item of series) max = Math.max(max, item.totalTokens);

    // 纵轴不跟着单日尖峰走：拿 p95 / 中位数撑出一个「日常看得见」的上限。
    // 极个别超出上限的日子贴顶画，并打上尖角标记，真实值仍在 tooltip 和副标题里。
    const positives = series.map(item => item.totalTokens).filter(value => value > 0).sort((a, b) => a - b);
    const percentile = q => positives.length
      ? positives[Math.min(positives.length - 1, Math.floor(q * (positives.length - 1)))]
      : 0;
    const hardCeiling = niceCeil(max * 1.06 || 1);
    const softCeiling = niceCeil(Math.max(percentile(0.95) * 1.8, percentile(0.5) * 4) || 1);
    const ceiling = Math.min(hardCeiling, softCeiling);
    const clipped = series.filter(item => item.totalTokens > ceiling);
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
      parts.push('<text class="axis-text" x="' + (padL - 8) + '" y="' + (y + 3.5).toFixed(1) + '" text-anchor="end">' + fmtTokens((ceiling * i) / 4) + '</text>');
    }

    const points = series.map((item, index) => ({ x: xAt(index), y: yAt(item.totalTokens) }));
    const line = smoothPath(points, padT, bottom);
    const area = line +
      " L " + points[points.length - 1].x.toFixed(1) + " " + bottom.toFixed(1) +
      " L " + points[0].x.toFixed(1) + " " + bottom.toFixed(1) + " Z";

    parts.push('<defs>');
    parts.push('<linearGradient id="g-area" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0%" stop-color="var(--accent)" stop-opacity="0.32"/>' +
      '<stop offset="70%" stop-color="var(--accent)" stop-opacity="0.08"/>' +
      '<stop offset="100%" stop-color="var(--accent)" stop-opacity="0.01"/>' +
      '</linearGradient>');
    parts.push('</defs>');

    parts.push('<path d="' + area + '" fill="url(#g-area)"/>');
    parts.push('<path d="' + line + '" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>');

    // 0 token 的日子占着 X 轴上的一格，曲线自己落到基线就够了。
    // 不再给每个空日子打点：一天一个空心圈连成串，比空白本身还扎眼。
    // 数量交给副标题，hover 到这些日子显示「无用量」。

    // 超出纵轴的日子在顶部打一个橙色尖角：平顶不等于「峰值就这么高」
    series.forEach((item, index) => {
      if (item.totalTokens <= ceiling) return;
      const x = points[index].x;
      parts.push('<path d="M ' + (x - 4.5).toFixed(1) + ' ' + (padT + 6).toFixed(1) +
        ' L ' + x.toFixed(1) + ' ' + (padT - 1).toFixed(1) +
        ' L ' + (x + 4.5).toFixed(1) + ' ' + (padT + 6).toFixed(1) + ' Z" fill="var(--warn)">' +
        '<title>' + dayLabel(item.day) + ' 实际 ' + fmtTokens(item.totalTokens) + '，超出纵轴</title></path>');
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
    let compareNote = "缺少上一周期数据";
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
          compareNote = "上一周期 " + fmtTokens(prevSum) + " · 含历史索引";
        }
      } else {
        compareValue = series.length + " 天";
        compareNote = "最早 " + dayLabel(firstDay);
      }
    }

    // 区间花费：按区间内每天、每个模型各自的单价现算
    const costRange = rangeCost();

    const cells = [
      ["区间用量", fmtTokens(sumRange), series.length + " 天"],
      ["区间花费", fmtMoney(costRange), "美元 · 刊例价"],
      ["日均", fmtTokens(avg), activeDays + " 天 · " + fmtCount(sumRecords) + " 次请求"],
      ["单日峰值", peak ? fmtTokens(peak.totalTokens) : "—", peak ? dayLabel(peak.day) : ""],
      ["环比", compareValue, compareNote]
    ];
    $("chart-summary").innerHTML = cells.map(([label, value, note]) =>
      '<div><div class="k">' + label + '</div><div class="v">' + value +
      (note ? '<small>' + note + '</small>' : '') + '</div></div>'
    ).join("");

    $("chart-badge").textContent = state.source === "workbuddy"
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
        ? ['<div class="tip-row"><span>状态</span><b>这天没有 token 记录</b></div>']
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
      return [
        '<div class="bar-row' + (open ? ' open' : '') + '" data-name="' + escapeHtml(item[nameKey]) + '"' + (label ? ' title="' + escapeHtml(label) + '"' : '') + '>',
        '  <span class="bar-name">' + escapeHtml(item[nameKey]) + '</span>',
        '  <span class="bar-val"><b>' + fmtPercent(item.share * 100, 1) + '</b> · ' + fmtTokens(item.totalTokens) +
          (extraHtml ? ' · <span class="bar-extra">' + extraHtml + '</span>' : '') + '</span>',
        '  <span class="bar-track"><i style="width:' + width.toFixed(1) + '%"></i></span>',
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

  function renderModels() {
    const models = rangeModels();
    for (const item of models) {
      item.cost = bucketCost(item, unitFor(item.model));
    }
    renderBars($("models"), models, {
      nameKey: "model",
      empty: "此区间没有模型数据",
      openName: state.openBars.models,
      detail: distDetail,
      decorate: item => ({
        extraHtml: distExtra(item),
        // 模型行额外保留单价说明：鼠标停上去能看到输入 / 命中 / 输出三档
        label: (item.tps ? item.tps.toFixed(1) + " tok/s · " : "") + unitText(item.model)
      })
    });
    const totalCost = models.reduce((acc, item) => acc + (item.cost || 0), 0);
    $("model-badge").textContent = fmtMoney(totalCost) + " · " +
      (rangeDays() === 0 ? "全部时间" : "最近 " + rangeDays() + " 天") + " · " + models.length + " 项";
  }

  function renderProjects() {
    const projects = rangeProjects();
    renderBars($("projects"), projects, {
      nameKey: "project",
      empty: "此区间没有项目数据",
      openName: state.openBars.projects,
      detail: distDetail,
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
    const speedMode = hasSpeed && state.hourMetric === "speed";
    $("hour-tabs").hidden = !hasSpeed;
    $("hour-title").textContent = speedMode ? "活跃时段 · tok/s" : "活跃时段";
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
    $("session-badge").textContent = detail.sessions + " 个会话";

    const rows = detail.sessionList.slice(0, 60);
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
    const sourcePrefix = detail.source === "workbuddy"
      ? "WorkBuddy · "
      : detail.source === "antigravity"
        ? "Antigravity · "
        : "Codex · ";
    $("status-text").textContent =
      sourcePrefix +
      detail.scannedFiles + " 个日志 · " + detail.sessions + " 个会话 · " +
      (detail.builtAt ? new Date(detail.builtAt).toLocaleString("zh-CN", { hour12: false }) : "—");

    const legacyDays = detail.baseline && detail.baseline.days ? detail.baseline.days : detail.series.length;
    if (detail.source === "workbuddy" || detail.source === "antigravity") {
      const todayTokens = detail.today ? detail.today.totalTokens : 0;
      $("brand-sub").textContent = "累计 " + fmtTokens(detail.totals.totalTokens) +
        (detail.cost ? " ≈ " + fmtMoney(detail.cost.cny) : "") +
        " · " + legacyDays + " 天" +
        (legacyDays > 1 && todayTokens > 0 ? " · 今日 " + fmtTokens(todayTokens) : "");
    } else {
      const wbToday = workbuddyTodayTokens();
      const agyToday = antigravityTodayTokens();
      $("brand-sub").textContent = "累计 " + fmtTokens(detail.totals.totalTokens) +
        (detail.cost ? " ≈ " + fmtMoney(detail.cost.cny) : "") +
        (legacyDays ? " · " + legacyDays + " 天" : "") +
        (wbToday > 0 ? " · WorkBuddy " + fmtTokens(wbToday) + " 今日" : "") +
        (agyToday > 0 ? " · Antigravity " + fmtTokens(agyToday) + " 今日" : "");
    }
  }

  function renderAll() {
    renderStats();
    renderChart();
    renderModels();
    renderProjects();
    renderHours();
    renderSessions();
    renderStatus();
  }
