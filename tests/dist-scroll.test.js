/**
 * 2.3.3 回归：模型 / 项目分布不再折叠成「前 6 + 其他 N 项」。
 * 既有静态口径断言，也把 renderBars / distDetail 抠出来真跑一遍，
 * 防止以后又改回「看得到数字、看不到条目」。
 */

const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { test } = require("node:test");

const dashboard = fs.readFileSync(
  path.join(__dirname, "..", "desktop", "dashboard.html"),
  "utf8"
);

function extract(name) {
  // 仓库里的 HTML 是 CRLF，结尾锚点要容忍 \r
  const re = new RegExp("(?:^|\\r?\\n)  function " + name + "\\(([^)]*)\\) \\{([\\s\\S]*?)\\r?\\n  \\}\\r?\\n");
  const match = dashboard.match(re);
  assert.ok(match, "找到函数 " + name);
  return { args: match[1], body: match[2] };
}

function loadHelpers() {
  const bars = extract("renderBars");
  const detail = extract("distDetail");
  const escapeHtml = value => String(value == null ? "" : value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const fmtPercent = (n, digits) => Number(n).toFixed(digits) + "%";
  const fmtTokens = n => String(n);
  const fmtCount = n => String(n);
  const fmtMoney = n => "¥" + Number(n).toFixed(0);
  const renderBars = new Function(
    "escapeHtml", "fmtPercent", "fmtTokens",
    "return function renderBars(" + bars.args + ") {" + bars.body + "\n  }"
  )(escapeHtml, fmtPercent, fmtTokens);
  const distDetail = new Function(
    "fmtTokens", "fmtCount", "fmtMoney",
    "return function distDetail(" + detail.args + ") {" + detail.body + "\n  }"
  )(fmtTokens, fmtCount, fmtMoney);
  return { renderBars, distDetail };
}

function items(count) {
  return Array.from({ length: count }, (_, i) => ({
    model: "model-" + i,
    totalTokens: (count - i) * 100,
    share: (count - i) / (count * (count + 1) / 2),
    inputTokens: (count - i) * 80,
    cachedInputTokens: (count - i) * 30,
    outputTokens: (count - i) * 20,
    records: count - i,
    cost: count - i,
    turns: count - i,
    tps: 12.5
  }));
}

test("分布卡固定 244px 滚动，全量行都在 DOM 里", () => {
  const rule = dashboard.match(/^  \.bars \{([\s\S]*?)^  \}/m);
  assert.ok(rule, "找到 .bars 规则");
  assert.match(rule[1], /height: 244px/);
  assert.match(rule[1], /overflow-y: auto/);
  // 固定高度 flex column 里行必须 flex:none，否则展开明细会把行压扁、文字叠到下一行
  const rowRule = dashboard.match(/^  \.bar-row \{([\s\S]*?)^  \}/m);
  assert.ok(rowRule, "找到 .bar-row 规则");
  assert.match(rowRule[1], /flex: none/);
  assert.doesNotMatch(dashboard, /const limit = options\.limit \|\| 6/);
  assert.doesNotMatch(dashboard, /"其他 " \+ rest\.length \+ " 项"/);
  assert.match(dashboard, /models\.length \+ " 项"/);
  assert.match(dashboard, /projects\.length \+ " 项"/);
});

test("renderBars 真渲染 83 行，不再有截断或其他项", () => {
  const { renderBars } = loadHelpers();
  const container = { innerHTML: "", scrollTop: 0 };
  const all = items(83);
  renderBars(container, all, {
    nameKey: "model",
    empty: "无",
    detail: () => "<span>明细</span>",
    decorate: item => ({ extraHtml: "¥" + item.cost })
  });
  assert.equal((container.innerHTML.match(/class="bar-row/g) || []).length, 83);
  assert.doesNotMatch(container.innerHTML, /其他 \d+ 项/);
  assert.match(container.innerHTML, /model-82/);
  assert.match(container.innerHTML, /bar-detail" hidden/);
});

test("点开的行保持展开，重渲染保留滚动位置", () => {
  const { renderBars } = loadHelpers();
  const container = { innerHTML: "", scrollTop: 700 };
  const all = items(20);
  renderBars(container, all, {
    nameKey: "model",
    empty: "无",
    openName: "model-5",
    detail: () => "<span>明细</span>"
  });
  assert.match(container.innerHTML, /class="bar-row open" data-name="model-5"/);
  assert.match(container.innerHTML, /<div class="bar-detail"><span>明细<\/span><\/div>/);
  assert.equal((container.innerHTML.match(/<div class="bar-detail"/g) || []).length, 20);
  assert.equal((container.innerHTML.match(/hidden/g) || []).length, 19);
  assert.equal(container.scrollTop, 700, "刷新后不能被弹回顶部");
});

test("展开明细与请求日志同口径：新增输入 = input − 缓存命中", () => {
  const { distDetail } = loadHelpers();
  const html = distDetail({
    inputTokens: 900,
    cachedInputTokens: 400,
    outputTokens: 100,
    records: 3,
    cost: 12.6,
    turns: 2,
    tps: 20.5
  });
  // fmtTokens 在测试里是原样数字，便于精确核对数值而不是格式
  assert.match(html, /新增输入 <b>500<\/b>/);
  assert.match(html, /缓存命中 <b>400<\/b>/);
  assert.match(html, /输出 <b>100<\/b>/);
  assert.match(html, /请求 <b>3<\/b>/);
  assert.match(html, /花费 <b>¥13<\/b>/);
  assert.match(html, /速度 <b>20\.5 tok\/s<\/b>（2 轮）/);
});

test("项目侧也带三档 token 桶，否则展开明细会全是 0", () => {
  const fn = dashboard.match(/function rangeProjects\(\) \{([\s\S]*?)\n  \}/);
  assert.ok(fn, "找到 rangeProjects");
  assert.match(fn[1], /inputTokens: 0/);
  assert.match(fn[1], /cachedInputTokens: 0/);
  assert.match(fn[1], /outputTokens: 0/);
  assert.match(fn[1], /current\.inputTokens \+= bucket\.inputTokens/);
  assert.match(fn[1], /current\.cachedInputTokens \+= bucket\.cachedInputTokens/);
  assert.match(fn[1], /current\.outputTokens \+= bucket\.outputTokens/);
});
