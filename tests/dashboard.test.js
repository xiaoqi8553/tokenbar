"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = file => fs.readFileSync(path.join(root, file), "utf8");

const packageJson = JSON.parse(read("package.json"));
const dashboard = read("desktop/dashboard.html");
const popover = read("desktop/popover.html");
const main = read("desktop/main.cjs");
const builder = read("desktop/builder.config.cjs");
const readme = read("README.md");

const { WorkBuddyStore } = require(path.join(root, "desktop", "data", "workbuddy-store.cjs"));

test("2.0 项目名与版本已经换到 TokenBar", () => {
  assert.equal(packageJson.name, "tokenbar");
  assert.match(packageJson.version, /^2\.\d+\.\d+$/);
  assert.match(builder, /productName: "TokenBar"/);
  assert.match(builder, /appId: "com\.xiaoqi\.tokenbar"/);
  assert.match(main, /const PRODUCT_NAME = "TokenBar"/);
  assert.match(dashboard, /<title>TokenBar/);
  assert.match(popover, /<title>TokenBar<\/title>/);
  assert.doesNotMatch(readme, /Codex Token 用量看板/);
});

test("2.0 桌面看板仍是双数据源 + 时段徽标", () => {
  assert.match(dashboard, /data-source="codex"/);
  assert.match(dashboard, /data-source="workbuddy"/);
  assert.match(dashboard, /id="hour-badge"/);
  assert.match(dashboard, /id="hour-tabs"/);
  assert.match(dashboard, /等价花费/);
});

test("2.0 旧网页看板已经整体删除，桌面端不再有入口", () => {
  assert.equal(fs.existsSync(path.join(root, "legacy")), false, "legacy 目录应已删除");
  assert.equal(fs.existsSync(path.join(root, "server.js")), false);
  assert.doesNotMatch(main, /openLegacy|utilityProcess|startBackend|ensureBackend|SERVER_PATH|dashboard:open-legacy/);
  assert.doesNotMatch(dashboard, /btn-legacy|openLegacy/);
  assert.doesNotMatch(read("desktop/dashboard-preload.cjs"), /openLegacy/);
  assert.doesNotMatch(builder, /legacy/);
  assert.equal(packageJson.scripts["legacy:start"], undefined);
  assert.equal(packageJson.scripts["legacy:test"], undefined);
  assert.doesNotMatch(readme, /legacy|旧版网页看板/);
});

test("2.0 WorkBuddy 同时读国际版与国内版，并按会话去重", async () => {
  assert.match(main, /\.workbuddy-ai/);
  assert.match(readme, /~\/\.workbuddy-ai\/projects/);

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tokenbar-roots-"));
  const intl = path.join(home, "intl");
  const cn = path.join(home, "cn");
  const write = (base, workspace, session, lines) => {
    const dir = path.join(base, "projects", workspace);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, session + ".jsonl");
    fs.writeFileSync(file, lines.map(line => JSON.stringify(line)).join("\n") + "\n");
    return file;
  };
  const usage = (tokens, day) => ({
    type: "message",
    timestamp: new Date(2026, 9, 30, 10, 0, 0).getTime(),
    providerData: {
      traceId: "t-" + day,
      stepSeq: 1,
      model: "deepseek-v4.1-flash",
      usage: { inputTokens: tokens, outputTokens: 10, totalTokens: tokens + 10 }
    }
  });

  // 同一个会话 id 在两套安装里都存在：国内版 1 条、国际版续写到 3 条
  write(cn, "ws", "same-session", [usage(100, 1)]);
  write(intl, "ws", "same-session", [usage(100, 1), usage(200, 2), usage(300, 3)]);
  // 只存在于国际版的新会话
  write(intl, "ws2", "intl-only", [usage(400, 4)]);

  const store = new WorkBuddyStore({ roots: [intl, cn] });
  const files = store.listFiles();
  assert.equal(files.length, 2, "同名会话只留一份，另一个是国际版独有");
  assert.equal(files.filter(item => item.path.includes("intl")).length, 2);

  const snap = await store.build();
  assert.equal(snap.sessions, 2);
  assert.equal(snap.totals.records, 4, "续写后的 3 条 + 独有会话 1 条");
  assert.equal(snap.totals.totalTokens, 100 + 200 + 300 + 400 + 40);

  const intlInfo = snap.roots.find(item => item.root === intl);
  const cnInfo = snap.roots.find(item => item.root === cn);
  assert.equal(intlInfo.kept, 2);
  assert.equal(cnInfo.kept, 0, "国内版那份被更大的同名文件取代");

  fs.rmSync(home, { recursive: true, force: true });
});

test("2.1 WorkBuddy 用 call/result 时间戳配对算速度，结构跟 Codex 对齐", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tokenbar-speed-"));
  const root = path.join(home, "wb");
  const dir = path.join(root, "projects", "ws");
  fs.mkdirSync(dir, { recursive: true });

  const base = new Date(2026, 9, 30, 10, 0, 0).getTime();
  // 一轮：call 在 t，result 在 t+2000ms，输出 400 tokens → 200 tok/s
  const callId = "call-1";
  const lines = [
    {
      id: callId,
      type: "function_call",
      timestamp: base,
      providerData: {
        traceId: "tr-1",
        stepSeq: 1,
        model: "deepseek-v4.1-flash",
        usage: { inputTokens: 1000, outputTokens: 400, totalTokens: 1400 }
      }
    },
    {
      id: "result-1",
      parentId: callId,
      type: "function_call_result",
      timestamp: base + 2000
    }
  ];
  fs.writeFileSync(path.join(dir, "session-1.jsonl"), lines.map(line => JSON.stringify(line)).join("\n") + "\n");

  const store = new WorkBuddyStore({ roots: [root] });
  const snap = await store.build();

  assert.ok(snap.throughput, "应该算出 throughput");
  assert.equal(snap.throughput.turns, 1);
  assert.equal(snap.throughput.outputTokens, 400);
  assert.equal(snap.throughput.durationMs, 2000);
  assert.equal(snap.throughput.tps, 200, "400 tokens / 2s = 200 tok/s");

  // 与 Codex 同构的字段
  assert.ok(snap.throughput.days["2026-10-30"], "按天");
  assert.ok(snap.throughput.models, "按模型");
  assert.equal(Array.isArray(snap.throughput.hours), true, "24 小时桶");
  assert.equal(snap.throughput.hours.length, 24);
  assert.ok(snap.throughput.dayHours["2026-10-30"], "按天×小时");
  assert.ok(snap.throughput.modelDays["2026-10-30"], "按天×模型");
  assert.ok(snap.throughput.projects.length > 0, "按项目");
  assert.equal(snap.throughput.projects[0].tps, 200, "项目级速度也能算出来");
  assert.ok(snap.throughput.projectDays["2026-10-30"], "按天×项目");

  // 模型与会话级 tps 不再是写死的 null
  const model = snap.models.find(item => item.model === "deepseek-v4.1-flash");
  assert.equal(model.turns, 1);
  assert.equal(model.tps, 200);
  const session = snap.sessionList[0];
  assert.equal(session.turns, 1);
  assert.equal(session.tps, 200);

  fs.rmSync(home, { recursive: true, force: true });
});

test("2.1 两个数据源都有速度卡，WorkBuddy 会话表也显示 tok/s", () => {
  // speedCard() 两个分支都要挂上
  assert.match(dashboard, /totalCard\(\),\s*\n\s*costCard\(\),\s*\n\s*speedCard\(\)/);
  assert.match(dashboard, /speedCard\(\)\s*\n\s*\];/);
  // 会话表速度列统一叫「速度」，WorkBuddy 有 tps 时显示 tok/s
  assert.match(dashboard, /\$\("th-speed"\)\.textContent = "速度"/);
  assert.match(dashboard, /tok\/s<\/span>/);
  // 固定六列，Codex 补了「累计用量」卡，两边卡片数一致
  assert.match(dashboard, /grid-template-columns: repeat\(6, minmax\(0, 1fr\)\)/);
  assert.match(dashboard, /function totalCard\(\)/);
});

test("2.2 价格表入口整体删掉，计价数据仍在", () => {
  assert.doesNotMatch(dashboard, /btn-pricing|openPricing|价格表/);
  assert.doesNotMatch(read("desktop/dashboard-preload.cjs"), /openPricing|dashboard:open-pricing/);
  assert.doesNotMatch(main, /dashboard:open-pricing/);
  assert.doesNotMatch(readme, /「价格表」按钮|"price table" button/);
  // 删的是入口，不是计价：单价文件和折算逻辑都还活着
  assert.match(main, /loadTable\(/);
  assert.match(dashboard, /function bucketCost\(/);
});

test("2.2 趋势图拉长，纵轴不再被单日尖峰拖到 500M", () => {
  assert.match(dashboard, /height: 280px/);
  assert.match(dashboard, /wrap\.clientHeight \|\| 280/);
  assert.match(dashboard, /softCeiling/);
  assert.match(dashboard, /percentile\(0\.95\)/);
  assert.match(dashboard, /天超出（峰值/);
  assert.match(dashboard, /四等分刻度/);
});

test("2.2 两个数据源共用固定几何，切换不跳", () => {
  assert.match(dashboard, /table-layout: fixed/);
  assert.match(dashboard, /height: 244px/);
  assert.doesNotMatch(dashboard, /max-height: 244px/);
  assert.match(dashboard, /align-items: stretch/);
  assert.match(dashboard, /min-height: 196px/);
  assert.match(dashboard, /min-height: 148px/);
  assert.match(dashboard, /visibility:hidden/);
});

test("2.2 模型与项目分布都显示花费和 tok/s", () => {
  assert.match(dashboard, /function distExtra\(/);
  assert.match(dashboard, /function dayUnit\(/);
  assert.match(dashboard, /detail\.throughput && detail\.throughput\.projectDays/);
  assert.match(dashboard, /bar-speed/);
  assert.match(dashboard, /decorate: item => \(\{ extraHtml: distExtra\(item\), label: distLabel\(item\) \}\)/);
  assert.match(read("desktop/data/codex-store.cjs"), /speed\.projectDays/);
  assert.match(read("desktop/data/workbuddy-store.cjs"), /speed\.projectDays/);
});

test("2.2 统计卡文案与会话表数值不再被裁切", () => {
  // stat-foot 改块级单行省略后，配额小圆点必须显式变成 inline-block，否则宽高失效
  const rule = sel => {
    const match = dashboard.match(new RegExp("^  " + sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + " \\{([\\s\\S]*?)^  \\}", "m"));
    assert.ok(match, "找到 CSS 规则 " + sel);
    return match[1];
  };
  assert.match(rule(".stat-foot"), /text-overflow: ellipsis/);
  assert.doesNotMatch(rule(".stat-foot"), /display: flex/);
  assert.match(rule(".dot"), /display: inline-block/);
  assert.match(dashboard, /\.stat-foot \.dot \{ margin-right: 6px; \}/);
  // 速度列 66px 装不下「102.7 tok/s」；日期、长模型名、时长也各差几像素
  assert.match(dashboard, /width: 104px; text-align: right" id="th-speed"/);
  assert.match(dashboard, /width: 100px">最近活动/);
  // 2.3.2：模型列从 186px 加宽到 230px，多模型换行列出，不再折叠成 +N
  assert.match(dashboard, /width: 230px">模型/);
  assert.match(dashboard, /width: 110px; text-align: right">时长/);
  assert.match(dashboard, /td\.num \{[\s\S]*?padding-left: 8px/);
  assert.match(dashboard, /\.col-duration \{ display: none; \}/);
  assert.doesNotMatch(dashboard, /width: 66px; text-align: right" id="th-speed"/);
});

test("2.3 用量趋势把 0 token 的日子也画出来", () => {
  assert.match(dashboard, /function parseDayKey\(/);
  assert.match(dashboard, /function fillCalendar\(from, to, byDay\)/);
  assert.match(dashboard, /const MAX_CHART_DAYS = 730/);
  // 全部时间以前直接返回有记录的日子，空白天整个从图上消失
  assert.doesNotMatch(dashboard, /if \(rangeDays\(\) === 0\) return detail\.series\.slice\(\);/);
  assert.match(dashboard, /fillCalendar\(first < todayKey \? first : todayKey, todayKey, byDay\)/);
  assert.match(dashboard, /天零用量/);
  assert.match(dashboard, /无用量/);
  // 环比按日历区间取上一周期，不再依赖首日恰好在 detail.series 里
  assert.match(dashboard, /item\.day >= prevStart && item\.day < firstDay/);
});

test("2.4 零用量日留在图上，但不再标点", () => {
  // 一天一个空心圈连成串比空白本身更扎眼：曲线贴基线 + 副标题计数就够了
  assert.doesNotMatch(dashboard, /class="zero-dot"/);
  assert.doesNotMatch(dashboard, /blankRuns/);
  assert.doesNotMatch(dashboard, /基线空心点/);
  assert.doesNotMatch(dashboard, /\.legend i\.zero/);
  assert.match(dashboard, /不再给每个空日子打点/);
  // 顶部尖角是另一个功能：提示哪几天超出纵轴，保留
  assert.match(dashboard, /i\.clip/);
  assert.match(dashboard, /超出纵轴 · 顶部尖角/);
  // 图例只剩这一项
  const legend = dashboard.match(/<div class="legend">([\s\S]*?)<\/div>/)[1];
  assert.equal((legend.match(/<span>/g) || []).length, 1);
});

test("2.3 补零按本地日历逐日，跨月不漏天", () => {
  const script = dashboard.match(/<script>([\s\S]*?)<\/script>/)[1];
  const source = name => {
    const match = script.match(new RegExp("^  function " + name + "\\(([\\s\\S]*?)^  \\}", "m"));
    assert.ok(match, "找到函数 " + name);
    return "function " + name + "(" + match[1] + "  }";
  };
  const { fillCalendar } = new Function(
    ["parseDayKey", "localDayKey", "emptyDay", "fillCalendar"]
      .map(source).join("\n") + "\nreturn { fillCalendar };"
  )();

  const byDay = new Map([
    ["2026-10-30", { day: "2026-10-30", totalTokens: 500 }],
    ["2026-11-07", { day: "2026-11-07", totalTokens: 900 }]
  ]);
  const out = fillCalendar("2026-10-30", "2026-11-07", byDay);
  assert.equal(out.length, 9, "10/30 到 11/7 一共 9 个日历日");
  assert.deepEqual(out.map(item => item.day), [
    "2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02", "2026-11-03",
    "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-07"
  ]);
  assert.equal(out.filter(item => item.totalTokens === 0).length, 7);
  assert.deepEqual(out[1], {
    day: "2026-10-31", totalTokens: 0, inputTokens: 0,
    cachedInputTokens: 0, outputTokens: 0, records: 0
  });
});
