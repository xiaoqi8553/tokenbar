/**
 * 桌面端冒烟：真的起一个 Electron，用假会话日志喂数据，检查弹窗与看板窗口
 * 都能正常渲染，并且旧版网页看板的入口确实不在了。
 *
 *   npm run desktop:smoke
 *   CODEX_TOKEN_DESKTOP_SMOKE_EXE=<安装目录>/TokenBar.exe npm run desktop:smoke
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { spawn } = require("node:child_process");
const { chromium } = require("playwright");

const root = path.resolve(__dirname, "..");

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 造一份跟真实 Codex 日志同构的会话：session_meta + 两轮 token_count
function writeFixture(sessionsDir) {
  const dir = path.join(sessionsDir, "2026", "10", "30");
  fs.mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  const usage = (input, cached, output) => ({
    input_tokens: input,
    cached_input_tokens: cached,
    output_tokens: output,
    total_tokens: input + output
  });
  const lines = [
    { timestamp: now, type: "session_meta", payload: { id: "desktop-smoke", cwd: root, model_provider: "openai" } },
    {
      timestamp: now,
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { last_token_usage: usage(900, 400, 100), total_token_usage: usage(900, 400, 100) },
        rate_limits: { primary: { used_percent: 12, window_minutes: 300, resets_in_seconds: 5400 } }
      }
    },
    {
      timestamp: new Date(Date.now() + 1000).toISOString(),
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { last_token_usage: usage(400, 100, 100), total_token_usage: usage(1300, 500, 200) }
      }
    }
  ];
  fs.writeFileSync(path.join(dir, "rollout-desktop-smoke.jsonl"), lines.map(line => JSON.stringify(line)).join("\n") + "\n", "utf8");

  // 四天前再来一条：全部时间视图里就该出现几天的空白，用来验证补零
  const old = new Date(Date.now() - 4 * 86400000).toISOString();
  const oldLines = [
    { timestamp: old, type: "session_meta", payload: { id: "desktop-smoke-old", cwd: root, model_provider: "openai" } },
    {
      timestamp: old,
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { last_token_usage: usage(300, 100, 50), total_token_usage: usage(300, 100, 50) },
        rate_limits: { primary: { used_percent: 8, window_minutes: 300, resets_in_seconds: 5400 } }
      }
    }
  ];
  fs.writeFileSync(path.join(dir, "rollout-desktop-smoke-old.jsonl"), oldLines.map(line => JSON.stringify(line)).join("\n") + "\n", "utf8");
}

async function findPage(browser, match, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const page = browser.contexts()
      .flatMap(context => context.pages())
      .find(candidate => candidate.url().includes(match));
    if (page) return page;
    await delay(150);
  }
  return null;
}

async function main() {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tokenbar-smoke-"));
  const sessions = path.join(temporaryRoot, "sessions");
  fs.mkdirSync(sessions, { recursive: true });
  writeFixture(sessions);

  const debugPort = await freePort();
  const packagedExecutable = process.env.CODEX_TOKEN_DESKTOP_SMOKE_EXE;
  const electronPath = packagedExecutable || require("electron");
  const electronArgs = [
    ...(packagedExecutable ? [] : [root]),
    `--user-data-dir=${path.join(temporaryRoot, "profile")}`,
    `--remote-debugging-port=${debugPort}`
  ];
  const child = spawn(electronPath, electronArgs, {
    cwd: root,
    env: {
      ...process.env,
      CODEX_HOME: temporaryRoot,
      WORKBUDDY_HOME: path.join(temporaryRoot, "no-workbuddy"),
      CODEX_TOKEN_DASHBOARD_SMOKE: "1",
      CODEX_TOKEN_DASHBOARD_SMOKE_TIMEOUT: "90000"
    },
    windowsHide: false,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let processOutput = "";
  child.stdout.on("data", chunk => { processOutput += chunk.toString(); });
  child.stderr.on("data", chunk => { processOutput += chunk.toString(); });

  let browser;
  try {
    const deadline = Date.now() + 40_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`Electron 提前退出（code=${child.exitCode}）：\n${processOutput}`);
      try {
        const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`, { signal: AbortSignal.timeout(500) });
        if (response.ok) break;
      } catch {}
      await delay(150);
    }
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);

    // 1. 托盘弹窗：主入口
    const popover = await findPage(browser, "popover.html", 25_000);
    assert.ok(popover, `弹窗没打开。\n${processOutput}`);
    await popover.waitForFunction(
      () => document.body.innerText.trim().length > 20,
      { timeout: 20_000 }
    );
    const popoverInfo = await popover.evaluate(() => ({
      title: document.title,
      host: document.documentElement.dataset.host || "",
      text: document.body.innerText.slice(0, 400),
      hasDashboardButton: !!document.querySelector("#dashboard")
    }));
    assert.equal(popoverInfo.title, "TokenBar");
    assert.ok(popoverInfo.hasDashboardButton, "弹窗里应该有打开完整看板的按钮");

    // 2. 从弹窗点开完整看板
    await popover.click("#dashboard");
    const dashboard = await findPage(browser, "dashboard.html", 20_000);
    assert.ok(dashboard, `看板窗口没打开。\n${processOutput}`);
    await dashboard.waitForFunction(
      () => document.querySelector("#hour-badge") && document.querySelectorAll("#range button").length === 4,
      { timeout: 25_000 }
    );

    // 3. 看板本身：双数据源、区间切换、时段徽标、口径文案
    const info = await dashboard.evaluate(() => ({
      title: document.title,
      sources: [...document.querySelectorAll("#source [data-source]")].map(el => el.dataset.source),
      ranges: [...document.querySelectorAll("#range [data-key]")].map(el => el.dataset.key),
      hourMetrics: [...document.querySelectorAll("#hour-tabs [data-metric]")].map(el => el.dataset.metric),
      hourBadge: (document.querySelector("#hour-badge") || {}).textContent || "",
      bodyText: document.body.innerText,
      legacyButton: !!document.querySelector("#btn-legacy, [data-action='open-legacy']"),
      legacyApi: !!window.dashboard && "openLegacy" in window.dashboard
    }));
    assert.match(info.title, /TokenBar/);
    assert.deepEqual(info.sources.sort(), ["codex", "workbuddy"]);
    assert.deepEqual(info.ranges.sort(), ["0", "14", "30", "7"]);
    assert.deepEqual(info.hourMetrics.sort(), ["speed", "tokens"]);
    assert.notEqual(info.hourBadge.trim(), "—", "时段徽标应该已经有数据");
    assert.match(info.bodyText, /等价花费/);
    assert.equal(info.legacyButton, false, "旧版网页看板按钮应该已经删除");
    assert.equal(info.legacyApi, false, "preload 不应该再暴露 openLegacy");

    // 3b. 固定几何：表格框、分布卡、趋势图尺寸与数据源无关
    const layout = await dashboard.evaluate(() => {
      const box = sel => {
        const el = document.querySelector(sel);
        return el ? Math.round(el.getBoundingClientRect().height) : -1;
      };
      return {
        statRow: box("#stat-row"),
        table: box(".table-wrap"),
        chart: box(".chart-wrap"),
        cols: [...document.querySelectorAll(".cols > .card")].map(el => Math.round(el.getBoundingClientRect().height)),
        pricingButton: !!document.querySelector("#btn-pricing"),
        pricingApi: !!window.dashboard && "openPricing" in window.dashboard,
        modelRows: document.querySelectorAll("#models .bar-row").length,
        modelMoney: document.querySelectorAll("#models .bar-money").length,
        projectRows: document.querySelectorAll("#projects .bar-row").length,
        projectMoney: document.querySelectorAll("#projects .bar-money").length,
        chartSub: (document.querySelector("#chart-sub") || {}).textContent || "",
        zeroDots: document.querySelectorAll("#chart .zero-dot").length,
        speedCol: (() => {
          const el = document.querySelector("#th-speed");
          return el ? Math.round(el.getBoundingClientRect().width) : -1;
        })(),
        footStyle: (() => {
          const el = document.querySelector(".stat-foot");
          if (!el) return "";
          const s = getComputedStyle(el);
          return s.display + "/" + s.textOverflow;
        })(),
        dotDisplay: (() => {
          const el = document.querySelector(".stat-foot .dot") || document.querySelector(".dot");
          return el ? getComputedStyle(el).display : "";
        })(),
        clippedCells: [...document.querySelectorAll("#session-body td")]
          .filter(td => td.scrollWidth > td.clientWidth + 1)
          .map(td => td.textContent.trim() + " [" + td.clientWidth + "/" + td.scrollWidth + "]").slice(0, 8)
      };
    });
    assert.equal(layout.pricingButton, false, "底栏「价格表」按钮应该已经删除");
    assert.equal(layout.pricingApi, false, "preload 不应该再暴露 openPricing");
    assert.equal(layout.table, 244, "会话表框固定高度，切数据源不跳");
    assert.ok(layout.chart >= 260, "趋势图应该拉长到 280px");
    assert.equal(layout.cols.length, 2, "模型 / 项目两张分布卡");
    assert.equal(layout.cols[0], layout.cols[1], "两张分布卡应该等高");
    assert.equal(layout.modelMoney, layout.modelRows, "模型分布每行都要带金额");
    assert.equal(layout.projectMoney, layout.projectRows, "项目分布每行都要带金额");
    assert.match(layout.chartSub, /天有记录/);
    assert.match(layout.chartSub, /天零用量/, "14 天视图要把没用量的日子数出来");
    assert.ok(layout.zeroDots >= 1, "0 token 的日子要在基线上画出空心点");
    assert.ok(layout.speedCol >= 100, "速度列要够宽，别把 102.7 tok/s 切掉");
    assert.equal(layout.footStyle, "block/ellipsis", "统计卡底部文案单行省略，不把整行撑高");
    assert.equal(layout.dotDisplay, "inline-block", "stat-foot 改块级后配额小圆点仍要显示");
    assert.deepEqual(layout.clippedCells, [], "会话表任何单元格都不该被裁切：" + layout.clippedCells.join(", "));

    // 4. 切一次区间，确认活跃时段跟着变
    const before = await dashboard.evaluate(() => (document.querySelector("#hour-badge") || {}).textContent || "");
    await dashboard.click('#range button[data-key="7"]');
    await dashboard.waitForFunction(
      previous => (document.querySelector("#hour-badge") || {}).textContent !== previous,
      before,
      { timeout: 10_000 }
    );

    // 4b. 全部时间也要按日历补齐空白天，而不是只画有记录的那几天
    await dashboard.click('#range button[data-key="0"]');
    await dashboard.waitForFunction(
      () => /全部时间/.test((document.querySelector("#chart-sub") || {}).textContent || ""),
      null,
      { timeout: 10_000 }
    );
    const allTime = await dashboard.evaluate(() => ({
      sub: (document.querySelector("#chart-sub") || {}).textContent || "",
      zeroDots: document.querySelectorAll("#chart .zero-dot").length
    }));
    assert.match(allTime.sub, /\d+ 天有记录 · \d+ 天零用量/, "全部时间也要显示空白天数");
    assert.ok(allTime.zeroDots >= 2, "四天前那条日志到今天之间的空白天要画出来：" + allTime.sub);

    assert.equal(child.exitCode, null, `测试期间应用不应该退出：\n${processOutput}`);
    process.stdout.write(`desktop smoke passed: ${JSON.stringify({ popover: popoverInfo.title, ...info, bodyText: undefined })}\n`);
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (child.exitCode === null) {
      child.kill();
      await Promise.race([new Promise(resolve => child.once("exit", resolve)), delay(5_000)]);
    }
    try {
      fs.rmSync(temporaryRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
    } catch (error) {
      console.warn(`临时目录没清干净：${temporaryRoot}（${error.code || error.message}）`);
    }
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
