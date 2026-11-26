/**
 * 生成 README / docs 用的文档截图。只做一件事：起一个临时 Electron，用假会话
 * 日志喂数据，连 CDP 按固定视口把托盘弹窗与看板截成几张图，写到 docs/shots/。
 *
 *   npm run docs:shots
 *   TOKENBAR_SHOTS_EXE=<安装目录>/TokenBar.exe npm run docs:shots
 *
 * 打包后想用安装版截图时设 TOKENBAR_SHOTS_EXE；不设则用仓库的 electron。
 * 文件名见 docs/shots/README.md。本脚本只写文件，不提交、不发布。
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { spawn } = require("node:child_process");
const { chromium } = require("playwright");

const root = path.resolve(__dirname, "..");
const shotsDir = path.join(root, "docs", "shots");
const VIEWPORT = { width: 1180, height: 860, deviceScaleFactor: 2 };

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

// 跟 desktop-smoke.js 同构的假日志：session_meta + 两轮 token_count，再补一条
// 四天前的记录，让「全部时间」视图里出现空白天，截图更接近真实使用情况。
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
    { timestamp: now, type: "session_meta", payload: { id: "docs-shots", cwd: root, model_provider: "openai" } },
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
  fs.writeFileSync(path.join(dir, "rollout-docs-shots.jsonl"), lines.map(line => JSON.stringify(line)).join("\n") + "\n", "utf8");

  const old = new Date(Date.now() - 4 * 86400000).toISOString();
  const oldLines = [
    { timestamp: old, type: "session_meta", payload: { id: "docs-shots-old", cwd: root, model_provider: "openai" } },
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
  fs.writeFileSync(path.join(dir, "rollout-docs-shots-old.jsonl"), oldLines.map(line => JSON.stringify(line)).join("\n") + "\n", "utf8");
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

// connectOverCDP 拿到的页面视口由 Electron 窗口决定；用 CDP 覆盖成固定尺寸和 DPR。
async function fixViewport(page) {
  const session = await page.context().newCDPSession(page);
  await session.send("Emulation.setDeviceMetricsOverride", {
    width: VIEWPORT.width,
    height: VIEWPORT.height,
    deviceScaleFactor: VIEWPORT.deviceScaleFactor,
    mobile: false
  });
  await delay(200);
}

async function setTheme(page, theme) {
  // 先注入 localStorage（应用启动也读这里），再点一次真实按钮让内部状态和 DOM 对齐。
  await page.evaluate(wanted => {
    localStorage.setItem("codex.theme", wanted);
    document.documentElement.setAttribute("data-theme", wanted);
    document.querySelectorAll("#theme-switch button[data-theme]").forEach(btn => {
      btn.setAttribute("aria-pressed", String(btn.dataset.theme === wanted));
    });
  }, theme);
  await page.click(`#theme-switch button[data-theme="${theme}"]`);
  await page.waitForFunction(
    wanted => document.documentElement.dataset.theme === wanted && localStorage.getItem("codex.theme") === wanted,
    theme,
    { timeout: 10_000 }
  );
  await delay(300);
}

async function shoot(page, name) {
  const file = path.join(shotsDir, name);
  await page.screenshot({ path: file, animations: "disabled" });
  console.log(`  wrote ${path.relative(root, file)}`);
}

async function main() {
  fs.mkdirSync(shotsDir, { recursive: true });
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tokenbar-shots-"));
  const sessions = path.join(temporaryRoot, "sessions");
  fs.mkdirSync(sessions, { recursive: true });
  writeFixture(sessions);

  // 假的本机授权（token 是测试假值）：让实时额度 / OAuth 面板有脱敏账号行可截。
  const fakeJwt = payload => "h." + Buffer.from(JSON.stringify(payload)).toString("base64url") + ".s";
  fs.writeFileSync(path.join(temporaryRoot, "auth.json"), JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      access_token: fakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
      refresh_token: "shots-refresh",
      id_token: fakeJwt({ email: "smoke@example.com" }),
      account_id: "shots-acct"
    }
  }));

  const debugPort = await freePort();
  const packagedExecutable = process.env.TOKENBAR_SHOTS_EXE || process.env.CODEX_TOKEN_DESKTOP_SMOKE_EXE;
  const electronPath = packagedExecutable || require("electron");
  if (packagedExecutable && !fs.existsSync(packagedExecutable)) {
    throw new Error(`TOKENBAR_SHOTS_EXE 指向的程序不存在：${packagedExecutable}`);
  }
  const childEnv = { ...process.env };
  delete childEnv.ELECTRON_RUN_AS_NODE; // 宿主是 Electron 时会退化成纯 Node
  const electronArgs = [
    ...(packagedExecutable ? [] : [root]),
    `--user-data-dir=${path.join(temporaryRoot, "profile")}`,
    `--remote-debugging-port=${debugPort}`
  ];
  const child = spawn(electronPath, electronArgs, {
    cwd: root,
    env: {
      ...childEnv,
      CODEX_HOME: temporaryRoot,
      WORKBUDDY_HOME: path.join(temporaryRoot, "no-workbuddy"),
      ANTIGRAVITY_HOME: path.join(temporaryRoot, "no-antigravity"),
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

    const popover = await findPage(browser, "popover.html", 25_000);
    if (!popover) throw new Error(`没找到弹窗页面。\n${processOutput}`);
    await popover.waitForFunction(() => document.body.innerText.trim().length > 20, { timeout: 20_000 });
    await fixViewport(popover);

    console.log("capture-shots:");
    // 弹窗截图必须趁它还可见时做：点开看板后 popover 会 hide，隐藏窗口无法截。
    await shoot(popover, "popover.png");

    // 从弹窗点开完整看板（lucid 的启动链就是这么走的）
    await popover.click("#dashboard");
    const dashboard = await findPage(browser, "dashboard.html", 25_000);
    if (!dashboard) throw new Error(`没找到看板页面。\n${processOutput}`);
    await dashboard.waitForFunction(
      () => document.querySelector("#hour-badge") && document.querySelectorAll("#range button").length === 4,
      { timeout: 25_000 }
    );
    await fixViewport(dashboard);
    await dashboard.waitForFunction(
      () => document.body.innerText.includes("活跃时段"),
      { timeout: 15_000 }
    );

    await setTheme(dashboard, "light");
    await shoot(dashboard, "dashboard-light.png");

    await setTheme(dashboard, "dark");
    await shoot(dashboard, "dashboard-dark.png");

    // 时段图：尽量切到 tok/s，切不动（没有速度样本）就保留用量视图。
    await setTheme(dashboard, "light");
    const hourTabsVisible = await dashboard.evaluate(() => {
      const tabs = document.querySelector("#hour-tabs");
      return !!tabs && !tabs.hidden && tabs.getClientRects().length > 0;
    });
    if (hourTabsVisible) {
      await dashboard.click('#hour-tabs button[data-metric="speed"]').catch(() => {});
      await delay(400);
    }
    await dashboard.locator("#hours").scrollIntoViewIfNeeded().catch(() => {});
    await delay(300);
    await shoot(dashboard, "dashboard-hours.png");

    // 授权面板：点顶栏「实时额度」，等弹层可见再截。
    await dashboard.click("#btn-auth");
    await dashboard.waitForFunction(
      () => {
        const modal = document.querySelector("#auth-modal");
        return modal && !modal.hidden;
      },
      { timeout: 10_000 }
    );
    await delay(500);
    await shoot(dashboard, "auth-panel.png");
    const closeAuth = dashboard.locator("#a-close");
    if (await closeAuth.count()) await closeAuth.click().catch(() => {});

    console.log(`done: ${fs.readdirSync(shotsDir).filter(f => f.endsWith(".png")).length} png in docs/shots/`);
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
