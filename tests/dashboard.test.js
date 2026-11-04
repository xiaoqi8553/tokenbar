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
