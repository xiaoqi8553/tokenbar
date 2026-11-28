'use strict';

/**
 * TokenBar Desktop 主进程门面（W3 3.0 深度重构）。
 * 职责：装配 ctx（可变状态 + 函数引用）、启动编排、app 事件。
 * 业务逻辑全部在 desktop/core/** 模块，模块内部通过 ctx.xxx(ctx, ...) 互相调用
 * （闭包 late-binding，无循环依赖问题）。所有 IPC channel / 窗口安全配置 /
 * userData 路径与数据格式 / 截图诊断环境变量钩子均保持零行为变化。
 */

const { app, BrowserWindow, Menu, Tray, shell, ipcMain, screen, nativeImage, safeStorage, Notification } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { CodexStore } = require("./data/codex-store.cjs");
const { WorkBuddyStore } = require("./data/workbuddy-store.cjs");
const { AntigravityStore } = require("./data/antigravity-store.cjs");
const { loadTable, ensureTableFile } = require("./data/pricing.cjs");
const { buildBaseline, baselineIsFresh, loadBaseline, saveBaseline } = require("./data/history-baseline.cjs");
const { createAbleSciStore } = require("./data/ablesci-store.cjs");
const { createCodexAuthStore } = require("./data/codex-auth-store.cjs");
const { createAntigravityQuotaStore } = require("./data/antigravity-quota-store.cjs");

const C = require("./core/constants.cjs");
const { logger: baseLogger, createLogger } = require("./core/logger.cjs");
const { installErrorBoundary } = require("./core/error-boundary.cjs");
const { installPaths } = require("./core/paths.cjs");
const { installPrefs } = require("./core/prefs.cjs");
const { installWindows } = require("./core/windows.cjs");
const { installTray } = require("./core/tray.cjs");
const { installPopoverIpc } = require("./core/ipc/popover.cjs");
const { installDashboardIpc } = require("./core/ipc/dashboard.cjs");
const { installAuthIpc } = require("./core/ipc/auth.cjs");
const { installStores } = require("./core/stores.cjs");
const { installShotDiagnostics } = require("./core/diagnostics.cjs");

const PRODUCT_NAME = "TokenBar";
const APP_ROOT = app.getAppPath();
const SMOKE = process.env.CODEX_TOKEN_DASHBOARD_SMOKE === "1";
const gotLock = SMOKE || app.requestSingleInstanceLock();

/** ctx：普通对象，既放全部可变状态，也放所有函数引用。 */
const ctx = {
  // 依赖注入
  app, BrowserWindow, Menu, Tray, shell, ipcMain, screen, nativeImage, safeStorage, Notification,
  fs, os, path, crypto,
  CodexStore, WorkBuddyStore, AntigravityStore,
  // 计价数据入口已移除，但单价数据仍由 loadTable(paths.pricing) 装载（见 core/stores.cjs）。
  loadTable: p => loadTable(p),
  ensureTableFile,
  buildBaseline, baselineIsFresh, loadBaseline, saveBaseline,
  createAbleSciStore, createCodexAuthStore, createAntigravityQuotaStore,
  PRODUCT_NAME, APP_ROOT, SMOKE,
  DESKTOP_DIR: path.join(APP_ROOT, "desktop"),

  // 可变状态
  mainWindow: null,
  popover: null,
  popoverReady: false,
  trayMenu: null,
  tray: null,
  /** 关窗口默认只是隐藏，退出时才允许真关 */
  allowWindowClose: false,
  quitting: false,
  latestStatus: null,
  startupError: "",
  statusTimer: null,
  smokeExitTimer: null,
  preferences: { launchAtLogin: false, startMode: "dashboard", popoverOnly: false },
  store: null,
  wbStore: null,
  agyStore: null,
  ablesciStore: null,
  codexAuthStore: null,
  agyQuotaStore: null,
  /** 启动诊断日志的落盘位置，start() 阶段才确定 */
  logFile: null,
  logger: baseLogger
};
// 手写 log() 改为委托 logger：启动早期只走 stdout，目录就绪后切换为文件日志（自动脱敏）。
ctx.log = (c, message) => c.logger.info(message);

// 尽早安装全局错误边界（幂等；模块设计不主动退出进程，Electron 保持存活）。
installErrorBoundary({ onFatal: payload => ctx.log(ctx, `[fatal:${payload.type}]`) });

// 按依赖顺序装配；函数体通过 ctx 引用，安装顺序不影响相互调用。
// WorkBuddy 国际版 ~/.workbuddy-ai 与国内版 ~/.workbuddy 的双根探测见 core/paths.cjs 的 workBuddyRoots。
installPaths(ctx);
installPrefs(ctx);
installWindows(ctx);
installTray(ctx);
installPopoverIpc(ctx);
installDashboardIpc(ctx);
installAuthIpc(ctx);
installStores(ctx);

/**
 * 改名 TokenBar 后，userData 会从 %APPDATA%/Codex Token 变成 %APPDATA%/TokenBar。
 * 历史索引（usage-index.json，5.7B 的基线）还在旧目录，直接换名会让累计掉回磁盘日志的 2.4B，
 * 所以首次启动把旧目录整份搬过来。搬不动（占用/权限）就继续用旧目录，宁可名字不对也不能丢账。
 * 搬迁逻辑逐字保留在 core/paths.cjs。
 */
// 只有拿到单实例锁才搬数据，避免两个实例同时读同一个索引；冒烟测试不碰真实账本
if (gotLock && !SMOKE) ctx.adoptLegacyUserData(ctx);

// 启动诊断：设置 CODEX_TOKEN_BOOT_MARK 可确认主进程脚本是否真的被执行
if (process.env.CODEX_TOKEN_BOOT_MARK) {
  try {
    fs.writeFileSync(process.env.CODEX_TOKEN_BOOT_MARK, `boot ${new Date().toISOString()} packaged=${app.isPackaged}\n`);
  } catch {
    /* 诊断失败不影响启动 */
  }
}

// 托盘状态刷新入口：实现保留在门面（源码守门测试直接读取函数体），
// 其余托盘 / push 逻辑在 core/tray.cjs，通过 ctx 互相调用。
function attachWorkBuddySummary() {
  return ctx.attachWorkBuddySummary(ctx);
}
function attachAntigravitySummary() {
  return ctx.attachAntigravitySummary(ctx);
}
async function refreshTrayStatus(force = false) {
  if (!ctx.store) return;
  // 实时额度走独立节奏：store 内部有 30 秒节流，失败也只是留旧值
  ctx.refreshLiveQuota(ctx).catch(() => {});
  ctx.refreshAntigravityQuota(ctx, force).catch(() => {});
  // WorkBuddy / Antigravity 是独立数据源：build() 自带 _promise 防并发，只重扫 size/mtime
  // 变过的文件；放进 30 秒轮询不会重复劳动，且不阻塞托盘/弹窗的 Codex 刷新。
  const wbStore = ctx.wbStore;
  if (wbStore) {
    wbStore.build()
      .then(() => attachWorkBuddySummary())
      .catch(error => ctx.log(ctx, `workbuddy refresh failed: ${error.message}`));
  }
  const agyStore = ctx.agyStore;
  if (agyStore) {
    agyStore.build()
      .then(() => attachAntigravitySummary())
      .catch(error => ctx.log(ctx, `antigravity refresh failed: ${error.message}`));
  }
  try {
    ctx.latestStatus = await ctx.store.refresh({ full: false });
    ctx.startupError = "";
  } catch (error) {
    ctx.startupError = `读取用量失败：${error.message}`;
  }
  // 快照是全新的对象，WorkBuddy 与 Antigravity 摘要要重新挂上
  if (ctx.latestStatus && wbStore) {
    try {
      ctx.latestStatus.workbuddy = wbStore.summary();
    } catch {
      /* 摘要失败不影响主数据 */
    }
  }
  if (ctx.latestStatus && agyStore) {
    try {
      ctx.latestStatus.antigravity = agyStore.summary();
    } catch {
      /* 摘要失败不影响主数据 */
    }
  }
  ctx.attachLiveQuota(ctx);
  ctx.attachAntigravityQuota(ctx);
  ctx.updateTray(ctx);
  ctx.pushStatusToPopover(ctx);
  }
// 模块内统一通过 ctx.refreshTrayStatus(ctx, force) 调用；上面的门面函数适配成 (c, force)。
ctx.refreshTrayStatus = (c, force) => refreshTrayStatus(force);

async function start(ctx) {
  const paths = ctx.userDataPaths(ctx);
  ctx.migrateUserData(ctx, paths);
  // 目录就绪后再挂日志，否则首次启动会写不进去
  ctx.logFile = path.join(paths.logs, C.LOG_FILE_NAME);
  ctx.logger = createLogger({ file: ctx.logFile, console: false });
  ctx.log(ctx, `start v${ctx.app.getVersion()} | smoke=${ctx.SMOKE} | packaged=${ctx.app.isPackaged} | execPath=${process.execPath}`);
  ctx.loadPreferences(ctx, paths);
  ctx.registerPopoverHandlers(ctx);
  ctx.registerDashboardHandlers(ctx);
  ctx.registerCodexAuthHandlers(ctx);
  ctx.log(ctx, "creating popover");
  ctx.createPopover(ctx);
  ctx.log(ctx, "creating tray");
  ctx.createTray(ctx);
  if (!ctx.SMOKE) ctx.createWindow(ctx);

  ctx.initStore(ctx, paths, ctx.resolveBaseline(ctx, paths)).catch(error => {
    ctx.log(ctx, `initStore failed: ${error.stack || error.message}`);
    ctx.startupError = `用量数据初始化失败：${error.message}`;
    ctx.updateTray(ctx);
    ctx.pushStatusToPopover(ctx);
  });

  if (!ctx.SMOKE) {
    ctx.showWindow(ctx).catch(() => {});
  } else {
    ctx.showPopover(ctx);
  }

  ctx.statusTimer = setInterval(() => { refreshTrayStatus().catch(() => {}); }, C.POLL_INTERVAL_MS);

  // Dev 截图诊断：环境变量钩子逐字搬迁到 core/diagnostics.cjs
  installShotDiagnostics(ctx);

  if (ctx.SMOKE) {
    // 冒烟脚本自己控制节奏，超时可从外面传
    const smokeTimeout = Number(process.env.CODEX_TOKEN_DASHBOARD_SMOKE_TIMEOUT)
      || (process.env.CODEX_TOKEN_DASHBOARD_SHOT ? C.SMOKE_TIMEOUT_WITH_SHOT_MS : C.SMOKE_TIMEOUT_DEFAULT_MS);
    ctx.smokeExitTimer = setTimeout(() => {
      process.stdout.write("Desktop smoke lifecycle check complete; quitting.\n");
      ctx.app.quit();
    }, smokeTimeout);
  }
}

if (!gotLock) {
  app.quit();
} else {
  app.setName(PRODUCT_NAME);
  if (process.platform === "win32") app.setAppUserModelId("com.xiaoqi.tokenbar");

  app.on("second-instance", () => { ctx.showWindow(ctx); });
  app.on("window-all-closed", event => {
    // 托盘常驻，不因窗口全部关闭而退出
    if (event && typeof event.preventDefault === "function") event.preventDefault();
  });
  app.on("before-quit", () => {
    ctx.quitting = true;
    ctx.allowWindowClose = true;
    if (ctx.statusTimer) clearInterval(ctx.statusTimer);
    if (ctx.smokeExitTimer) clearTimeout(ctx.smokeExitTimer);
    if (ctx.store) ctx.store.saveCache();
  });
  app.whenReady().then(() => start(ctx)).catch(error => {
    ctx.log(ctx, `fatal: ${error.stack || error.message}`);
    ctx.startupError = error.message;
    ctx.updateTray(ctx);
  });
}
