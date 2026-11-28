  // ---------------------------------------------------------------------
  // 区间数据
  // ---------------------------------------------------------------------
  function rangeDays() {
    return state.range > 0 ? state.range : 0;
  }

  /** YYYY-MM-DD 按本地日历解析；new Date("2026-11-07") 会被当成 UTC，别用 */
  function parseDayKey(key) {
    const [year, month, day] = String(key).split("-").map(Number);
    return new Date(year, (month || 1) - 1, day || 1, 0, 0, 0, 0);
  }

  function emptyDay(day) {
    return {
      day,
      totalTokens: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      records: 0
    };
  }

  /**
   * 按本地日历把 [from, to] 逐日列出来，没记录的日子填 0。
   * 少一天就会把「有量的日子」挤到一起，看不出哪几天根本没开过机。
   */
  function fillCalendar(from, to, byDay) {
    const out = [];
    const end = parseDayKey(to);
    let cursor = parseDayKey(from);
    // 日志里混进远古日期时别生成几千个 SVG 点：最多补两年
    const MAX_CHART_DAYS = 730;
    if ((end - cursor) / 86400000 >= MAX_CHART_DAYS) {
      cursor = parseDayKey(to);
      cursor.setDate(cursor.getDate() - (MAX_CHART_DAYS - 1));
    }
    while (cursor <= end) {
      const key = localDayKey(cursor);
      out.push(byDay.get(key) || emptyDay(key));
      cursor.setDate(cursor.getDate() + 1);
    }
    return out;
  }

  /** 取区间内的每日序列，补齐没有用量的空白日（全部时间也一样补） */
  function rangeSeries() {
    const detail = state.detail;
    if (!detail || !detail.series || !detail.series.length) return [];
    const byDay = new Map(detail.series.map(item => [item.day, item]));
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayKey = localDayKey(today);

    const days = rangeDays();
    if (days > 0) {
      const start = new Date(today);
      start.setDate(start.getDate() - (days - 1));
      return fillCalendar(localDayKey(start), todayKey, byDay);
    }
    // 全部时间：从最早一条记录到今天，0 token 的日子不能凭空消失
    const first = detail.series.reduce(
      (min, item) => (item.day < min ? item.day : min),
      detail.series[0].day
    );
    return fillCalendar(first < todayKey ? first : todayKey, todayKey, byDay);
  }

  /** 区间内的模型汇总（用 天×模型 维度重算，而不是全量占比） */
  function rangeModels() {
    const detail = state.detail;
    if (!detail) return [];
    const days = rangeDays();
    const keys = days === 0
      ? Object.keys(detail.modelDays || {})
      : rangeSeries().map(item => item.day);

    const totals = new Map();
    let grand = 0;
    for (const day of keys) {
      const byModel = (detail.modelDays || {})[day];
      if (!byModel) continue;
      for (const [model, bucket] of Object.entries(byModel)) {
        const current = totals.get(model) || {
          model,
          totalTokens: 0,
          inputTokens: 0,
          cachedInputTokens: 0,
          outputTokens: 0,
          records: 0
        };
        current.totalTokens += bucket.totalTokens || 0;
        current.inputTokens += bucket.inputTokens || 0;
        current.cachedInputTokens += bucket.cachedInputTokens || 0;
        current.outputTokens += bucket.outputTokens || 0;
        current.records += bucket.records || 0;
        totals.set(model, current);
        grand += bucket.totalTokens || 0;
      }
    }

    // 速度与用量走同一批天，避免「占比是 30 天、速度是全部时间」
    const speedDays = (detail.throughput && detail.throughput.modelDays) || {};
    const speedAcc = new Map();
    for (const day of keys) {
      const byModel = speedDays[day];
      if (!byModel) continue;
      for (const [model, cell] of Object.entries(byModel)) {
        const current = speedAcc.get(model) || { output: 0, duration: 0, turns: 0 };
        current.output += cell.outputTokens || 0;
        current.duration += cell.durationMs || 0;
        current.turns += cell.turns || 0;
        speedAcc.set(model, current);
      }
    }

    return [...totals.values()]
      .map(item => {
        const speed = speedAcc.get(item.model);
        const output = speed ? speed.output : 0;
        const duration = speed ? speed.duration : 0;
        return {
          ...item,
          share: grand ? item.totalTokens / grand : 0,
          turns: speed ? speed.turns : 0,
          speedOutput: output,
          speedDuration: duration,
          tps: duration > 0 ? output * 1000 / duration : null
        };
      })
      .sort((a, b) => b.totalTokens - a.totalTokens);
  }

  /** 区间内的项目汇总：和模型分布同口径，花费与输出速度都补齐 */
  function rangeProjects() {
    const detail = state.detail;
    if (!detail) return [];
    const days = rangeDays();
    const keys = days === 0
      ? Object.keys(detail.projectDays || {})
      : rangeSeries().map(item => item.day);

    const blank = project => ({
      project,
      totalTokens: 0,
      // 2.3.3：点行展开要显示四档 token，项目侧也得把这三个桶带上
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      records: 0,
      cost: 0,
      turns: 0,
      speedOutput: 0,
      speedDuration: 0,
      modelMap: new Map()
    });

    const totals = new Map();
    let grand = 0;
    for (const day of keys) {
      const byProject = (detail.projectDays || {})[day];
      if (!byProject) continue;
      const unit = dayUnit(day);
      const pmByProject = (detail.projectModelDays || {})[day] || {};
      for (const [project, bucket] of Object.entries(byProject)) {
        const current = totals.get(project) || blank(project);
        current.totalTokens += bucket.totalTokens || 0;
        current.inputTokens += bucket.inputTokens || 0;
        current.cachedInputTokens += bucket.cachedInputTokens || 0;
        current.outputTokens += bucket.outputTokens || 0;
        current.records += bucket.records || 0;
        if (unit) current.cost += bucketCost(bucket, unit);
        const byModel = pmByProject[project];
        if (byModel) {
          for (const [model, mb] of Object.entries(byModel)) {
            let mCell = current.modelMap.get(model);
            if (!mCell) {
              mCell = {
                model,
                totalTokens: 0,
                inputTokens: 0,
                cachedInputTokens: 0,
                outputTokens: 0,
                records: 0,
                cost: 0
              };
              current.modelMap.set(model, mCell);
            }
            mCell.totalTokens += mb.totalTokens || 0;
            mCell.inputTokens += mb.inputTokens || 0;
            mCell.cachedInputTokens += mb.cachedInputTokens || 0;
            mCell.outputTokens += mb.outputTokens || 0;
            mCell.records += mb.records || 0;
            mCell.cost += bucketCost(mb, unitFor(model));
          }
        }
        totals.set(project, current);
        grand += bucket.totalTokens || 0;
      }
    }

    // 速度与用量走同一批天：项目级速度由每份日志的完成轮按天归属得到
    const speedDays = (detail.throughput && detail.throughput.projectDays) || {};
    for (const day of keys) {
      const byProject = speedDays[day];
      if (!byProject) continue;
      for (const [project, cell] of Object.entries(byProject)) {
        const current = totals.get(project);
        if (!current) continue;
        current.speedOutput += cell.outputTokens || 0;
        current.speedDuration += cell.durationMs || 0;
        current.turns += cell.turns || 0;
      }
    }

    return [...totals.values()]
      .map(item => {
        const { modelMap, ...rest } = item;
        const models = [...modelMap.values()]
          .map(m => ({ ...m, share: item.totalTokens ? m.totalTokens / item.totalTokens : 0 }))
          .sort((a, b) => b.totalTokens - a.totalTokens);
        return {
          ...rest,
          models,
          share: grand ? item.totalTokens / grand : 0,
          tps: item.speedDuration > 0 ? item.speedOutput * 1000 / item.speedDuration : null
        };
      })
      .sort((a, b) => b.totalTokens - a.totalTokens);
  }
