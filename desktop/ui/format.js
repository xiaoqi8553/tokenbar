(function () {
  "use strict";

  // ---------------------------------------------------------------------
  // 状态
  // ---------------------------------------------------------------------
  const RANGES = [
    { key: 7, label: "7 天" },
    { key: 14, label: "14 天" },
    { key: 30, label: "30 天" },
    { key: 0, label: "全部" }
  ];

  /** 系统主题媒体查询：只在用户没有显式选主题时跟随系统切换 */
  const themeQuery = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  /** 用户是否显式选过「月之亮面 / 月之暗面」；选过就以用户选择为准 */
  let themeExplicit = localStorage.getItem("codex.theme") === "light" || localStorage.getItem("codex.theme") === "dark";

  const state = {
    /** 当前展示的数据源明细（等于 data[source]） */
    detail: null,
    /** 两个数据源各自缓存一份，切换时不用重新扫描 */
    data: { codex: null, workbuddy: null },
    source: localStorage.getItem("codex.source") === "workbuddy" ? "workbuddy" : "codex",
    status: null,
    meta: null,
    range: Number(localStorage.getItem("codex.range") || 14) || 14,
    hourMetric: localStorage.getItem("codex.hourMetric") || "tokens",
    /** 主题：月之亮面 = light，月之暗面 = dark（旧版 auto/空值按系统偏好落到具体值） */
    theme: (function () {
      const saved = localStorage.getItem("codex.theme");
      if (saved === "light" || saved === "dark") return saved;
      return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    })(),
    /** 日志视图：sessions = 按会话汇总，requests = 按会话×模型逐行（CC Switch 式） */
    logView: localStorage.getItem("codex.logView") === "requests" ? "requests" : "sessions",
    /** 当前点开的会话 id（会话视图里的行内明细） */
    openSession: null,
    /** 两张分布卡各自点开的行名（切区间 / 刷新后仍保持展开） */
    openBars: { models: null, projects: null },
    hover: -1
  };

  const $ = id => document.getElementById(id);

  // ---------------------------------------------------------------------
  // 格式化
  // ---------------------------------------------------------------------
  function fmtTokens(value) {
    const n = Number(value) || 0;
    // B 级统一两位小数：看板与弹窗并排出现时不会一个 5.75 一个 5.7
    if (n >= 1e9) return (n / 1e9).toFixed(n >= 1e10 ? 1 : 2) + "B";
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e8 ? 0 : 1).replace(/\.0$/, "") + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
    return String(Math.round(n));
  }

  function fmtCount(value) {
    return (Number(value) || 0).toLocaleString("zh-CN");
  }

  /** 当前汇率：数据层仍以人民币为 canonical，界面按这个汇率折成美元展示 */
  function moneyRate() {
    return (state.detail && state.detail.cost && Number(state.detail.cost.rate)) || 7.2;
  }

  /**
   * 金额统一用美元（USD）计价：所有业务值（cost.cny、桶单价、区间花费）内部仍是人民币，
   * 在展示边界统一除以汇率折成美元。小额给两位小数，百万以上用 M，中间用千分位。
   */
  function fmtMoney(cny) {
    return fmtUsd(Number(cny) / moneyRate());
  }

  /** 美元主计价 */
  function fmtUsd(usd) {
    const n = Number(usd);
    if (!Number.isFinite(n) || n <= 0) return "$0";
    if (n < 1) return "$" + n.toFixed(2);
    if (n < 1000) return "$" + n.toFixed(n < 10 ? 2 : 0);
    if (n < 1000000) return "$" + Math.round(n).toLocaleString("en-US");
    return "$" + (n / 1000000).toFixed(2) + "M";
  }

  /** 某模型的每百万 tokens 单价（人民币），拿不到就用兜底价 */
  function unitFor(model) {
    const pricing = state.detail && state.detail.pricing;
    if (!pricing) return null;
    const cell = pricing.models && pricing.models[model];
    if (cell && cell.unit) return cell.unit;
    return pricing.fallback ? pricing.fallback.unit : null;
  }

  /** 单个桶按单价折算成人民币 */
  function bucketCost(bucket, unit) {
    if (!bucket || !unit) return 0;
    const input = Math.max(0, bucket.inputTokens || 0);
    const cached = Math.min(input, Math.max(0, bucket.cachedInputTokens || 0));
    const output = Math.max(0, bucket.outputTokens || 0);
    return ((input - cached) * unit.input + cached * unit.cached + output * unit.output) / 1e6;
  }

  /**
   * 某天的「混合单价」：项目桶是按天聚合的、不分模型，没法直接套某个模型的单价。
   * 用当天各模型的实际用量加权出三档均价，再套到项目桶上。
   * 这样项目花费与模型花费出自同一批桶，两边的合计能对上。
   */
  function dayUnit(day) {
    const byModel = state.detail && state.detail.modelDays ? state.detail.modelDays[day] : null;
    if (!byModel) return null;
    const acc = { fresh: 0, freshCost: 0, cached: 0, cachedCost: 0, output: 0, outputCost: 0 };
    for (const [model, bucket] of Object.entries(byModel)) {
      const unit = unitFor(model);
      if (!unit) continue;
      const input = Math.max(0, bucket.inputTokens || 0);
      const cached = Math.min(input, Math.max(0, bucket.cachedInputTokens || 0));
      const fresh = input - cached;
      const output = Math.max(0, bucket.outputTokens || 0);
      acc.fresh += fresh;
      acc.freshCost += fresh * unit.input;
      acc.cached += cached;
      acc.cachedCost += cached * unit.cached;
      acc.output += output;
      acc.outputCost += output * unit.output;
    }
    if (!acc.fresh && !acc.cached && !acc.output) return null;
    return {
      input: acc.fresh ? acc.freshCost / acc.fresh : 0,
      cached: acc.cached ? acc.cachedCost / acc.cached : 0,
      output: acc.output ? acc.outputCost / acc.output : 0
    };
  }

  /** 当前区间内、按模型单价逐天累加的花费 */
  function rangeCost() {
    const detail = state.detail;
    if (!detail || !detail.modelDays) return 0;
    const days = rangeDays();
    const keys = days === 0 ? Object.keys(detail.modelDays) : rangeSeries().map(item => item.day);
    let total = 0;
    for (const day of keys) {
      const byModel = detail.modelDays[day];
      if (!byModel) continue;
      for (const [model, bucket] of Object.entries(byModel)) {
        total += bucketCost(bucket, unitFor(model));
      }
    }
    return total;
  }

  /** 单价说明：鼠标停在模型行上能看到「输入 / 命中 / 输出」三档（美元 / 百万 tokens） */
  function unitText(model) {
    const unit = unitFor(model);
    if (!unit) return "";
    const rate = moneyRate();
    return "输入 $" + (unit.input / rate).toFixed(2) + " · 命中 $" + (unit.cached / rate).toFixed(2) +
      " · 输出 $" + (unit.output / rate).toFixed(2) + " / 百万 tokens";
  }

  function fmtPercent(value, digits) {
    const n = Number(value) || 0;
    return n.toFixed(digits === undefined ? 0 : digits) + "%";
  }

  function fmtDuration(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return "—";
    const minutes = Math.floor(ms / 60000);
    if (minutes < 1) return "<1 分钟";
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    if (days >= 1) return days + " 天 " + (hours % 24) + " 小时";
    if (hours >= 1) return hours + " 小时 " + (minutes % 60) + " 分";
    return minutes + " 分钟";
  }

  /** 秒级耗时：首字延迟、每轮耗时这类数字用 */
  function fmtSpeed(ms) {
    if (!Number.isFinite(ms) || ms < 0) return "—";
    if (ms < 1000) return Math.round(ms) + "ms";
    if (ms < 60000) return (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + "s";
    return Math.round(ms / 60000) + " 分";
  }

  function relTime(iso) {
    if (!iso) return "—";
    const stamp = new Date(iso).getTime();
    if (Number.isNaN(stamp)) return "—";
    const diff = Date.now() - stamp;
    if (diff < 60e3) return "刚刚";
    if (diff < 3600e3) return Math.floor(diff / 60e3) + " 分钟前";
    if (diff < 86400e3) return Math.floor(diff / 3600e3) + " 小时前";
    const days = Math.floor(diff / 86400e3);
    if (days === 1) return "昨天";
    if (days < 7) return days + " 天前";
    const date = new Date(iso);
    return (date.getMonth() + 1) + " 月 " + date.getDate() + " 日";
  }
  function dayLabel(key) {
    const [, month, day] = String(key).split("-");
    return Number(month) + "/" + Number(day);
  }

  function localDayKey(date) {
    const pad = n => String(n).padStart(2, "0");
    return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate());
  }

  // ---------------------------------------------------------------------
  // 主题
  // ---------------------------------------------------------------------
  function applyTheme() {
    const dark = state.theme === "dark";
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
    // 同步两个 tag 的选中态（html[data-theme] 是真正生效的开关）
    const sw = $("theme-switch");
    if (sw) {
      for (const btn of sw.querySelectorAll("button[data-theme]")) {
        btn.setAttribute("aria-pressed", String(btn.dataset.theme === state.theme));
      }
    }
  }
