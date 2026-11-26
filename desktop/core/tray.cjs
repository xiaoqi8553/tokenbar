'use strict';

const { TOKEN_TRUNCATE } = require('./constants.cjs');

/**
 * 托盘、额度刷新与 push 系列（W3 拆分自 main.cjs）。
 * 函数间相互调用一律走 ctx.xxx(ctx, ...)，避免循环依赖拿到 undefined。
 */

function pushStatusToPopover(ctx) {
  if (!ctx.popover || ctx.popover.isDestroyed() || !ctx.popoverReady) return;
  ctx.popover.webContents.send("popover:status", ctx.latestStatus || { ok: false, phase: ctx.store ? ctx.store.phase : "idle" });
}

/** 科研通状态变了，让打开的弹窗重新拉一次签到状态 */
function pushAbleSciChanged(ctx) {
  if (!ctx.popover || ctx.popover.isDestroyed() || !ctx.popoverReady) return;
  ctx.popover.webContents.send("ablesci:changed");
}

function pushDetailProgress(ctx, progress) {
  if (!ctx.mainWindow || ctx.mainWindow.isDestroyed()) return;
  ctx.mainWindow.webContents.send("dashboard:progress", progress);
}

/** 把 WorkBuddy 的当日/累计摘要挂到最新快照上，弹窗与托盘共用 */
function attachWorkBuddySummary(ctx) {
  if (!ctx.wbStore || !ctx.latestStatus) return;
  try {
    ctx.latestStatus.workbuddy = ctx.wbStore.summary();
  } catch {
    return;
  }
  ctx.updateTray(ctx);
  ctx.pushStatusToPopover(ctx);
}

/** 把 Antigravity 的当日/累计摘要挂到最新快照上，弹窗与托盘共用 */
function attachAntigravitySummary(ctx) {
  if (!ctx.agyStore || !ctx.latestStatus) return;
  try {
    ctx.latestStatus.antigravity = ctx.agyStore.summary();
  } catch {
    return;
  }
  ctx.updateTray(ctx);
  ctx.pushStatusToPopover(ctx);
}

/** 把实时额度挂到 latestStatus.quota，并记录来源，供界面标注「实时」 */
function applyLiveQuota(ctx, result) {
  if (!result || !result.quota || !ctx.latestStatus) return;
  ctx.latestStatus.quota = { ...result.quota, source: "api", account: result.email, fetchedAt: result.fetchedAt };
  ctx.updateTray(ctx);
  ctx.pushStatusToPopover(ctx);
  if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
    ctx.mainWindow.webContents.send("dashboard:status", ctx.latestStatus);
  }
}

/** 后台静默刷新实时额度：失败不影响用量主链路 */
async function refreshLiveQuota(ctx, force = false) {
  if (!ctx.codexAuthStore) return;
  try {
    const result = await ctx.codexAuthStore.activeQuota({ force });
    if (result && result.quota) ctx.applyLiveQuota(ctx, result);
  } catch (error) {
    ctx.log(ctx, `live quota refresh failed: ${error.message}`);
  }
}

/** 把缓存的实时额度重新挂到最新快照（刷新会换掉整个对象） */
function attachLiveQuota(ctx) {
  if (!ctx.latestStatus || !ctx.codexAuthStore) return;
  try {
    const active = ctx.codexAuthStore.list().activeId;
    const live = active ? ctx.codexAuthStore.cachedQuotaFor(active) : null;
    if (live) ctx.latestStatus.quota = { ...live, source: "api" };
  } catch {
    /* 覆盖失败就保留日志快照口径 */
  }
}

/** 把 Antigravity 实时额度挂到 latestStatus.antigravityQuota，弹窗与看板共用 */
function applyAntigravityQuota(ctx, result) {
  if (!result || !result.quota || !ctx.latestStatus) return;
  ctx.latestStatus.antigravityQuota = {
    ...result.quota,
    source: "api",
    account: result.email,
    fetchedAt: result.fetchedAt,
    error: null
  };
  ctx.updateTray(ctx);
  ctx.pushStatusToPopover(ctx);
  if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
    ctx.mainWindow.webContents.send("dashboard:status", ctx.latestStatus);
  }
}

/** 后台静默刷新 Antigravity 实时额度：失败保留已有缓存或记下错误原因 */
async function refreshAntigravityQuota(ctx, force = false) {
  if (!ctx.agyQuotaStore) return;
  try {
    const result = await ctx.agyQuotaStore.activeQuota({ force });
    if (result && result.quota) ctx.applyAntigravityQuota(ctx, result);
  } catch (error) {
    ctx.log(ctx, `antigravity quota refresh failed: ${error.message}`);
    if (ctx.latestStatus && !ctx.latestStatus.antigravityQuota) {
      ctx.latestStatus.antigravityQuotaError = error.message;
      ctx.pushStatusToPopover(ctx);
    }
  }
}

/** 把缓存的 Antigravity 实时额度重新挂到最新快照 */
function attachAntigravityQuota(ctx) {
  if (!ctx.latestStatus || !ctx.agyQuotaStore) return;
  try {
    const live = ctx.agyQuotaStore.bestCachedQuota();
    if (live) {
      ctx.latestStatus.antigravityQuota = live;
      delete ctx.latestStatus.antigravityQuotaError;
    }
  } catch {
    /* 覆盖失败保留旧状态 */
  }
}

function formatAgyQuotaLine(quota) {
  if (!quota) return "Antigravity 额度：暂无数据";
  const parts = [];
  if (quota.gemini && quota.gemini.primary) {
    parts.push(`Gemini 剩 ${Math.round(quota.gemini.primary.remainingPercent)}%`);
  }
  if (quota.thirdParty && quota.thirdParty.primary) {
    parts.push(`Claude 剩 ${Math.round(quota.thirdParty.primary.remainingPercent)}%`);
  }
  return parts.length ? `Antigravity 额度：${parts.join(" · ")}` : "Antigravity 额度：暂无数据";
}

function formatTokens(ctx, value) {
  const number = Number(value) || 0;
  if (number >= 1e9) return `${(number / 1e9).toFixed(number >= 1e10 ? 1 : 2).replace(/0+$/, "").replace(/\.$/, "")}B`;
  if (number >= 1e6) return `${(number / 1e6).toFixed(number >= 1e8 ? 0 : 1).replace(/\.0$/, "")}M`;
  if (number >= 1e3) return `${(number / 1e3).toFixed(1).replace(/\.0$/, "")}K`;
  return String(number);
}

/** 托盘右键「科研通签到」：签到后用系统通知反馈结果，不依赖弹窗是否打开 */
async function runTraySign(ctx) {
  if (!ctx.ablesciStore) return;
  if (ctx.ablesciStore.list().accounts.length === 0) {
    ctx.showPopover(ctx);
    return;
  }
  try {
    const result = await ctx.ablesciStore.sign();
    const detail = (result.results || []).map(r => `${r.masked}：${r.msg}`).join("\n");
    if (typeof ctx.Notification === "function" && ctx.Notification.isSupported()) {
      new ctx.Notification({
        title: result.results && result.results.some(r => !r.ok) ? "科研通签到（部分失败）" : "科研通签到完成",
        body: (result.summary + "\n" + detail).slice(0, TOKEN_TRUNCATE),
        silent: true
      }).show();
    }
    // 同步弹窗里的状态徽标
    ctx.pushAbleSciChanged(ctx);
    ctx.log(ctx, `tray ablesci sign: ${result.summary}`);
  } catch (e) {
    ctx.log(ctx, `tray ablesci sign failed: ${e.message}`);
  }
}

function updateTray(ctx) {
  if (!ctx.tray) return;
  const data = ctx.latestStatus;
  const quota = data && data.quota;
  const tooltip = data
    ? `TokenBar · 会话 ${quota && quota.session ? Math.round(quota.session.usedPercent) + "%" : "—"} · 今日 ${ctx.formatTokens(ctx, data.today?.totalTokens)}`
    : ctx.startupError || "TokenBar · 正在读取用量";
  ctx.tray.setToolTip(tooltip.slice(0, 127));
  ctx.trayMenu = ctx.Menu.buildFromTemplate([
    { label: "打开用量速览", click: () => { ctx.showPopover(ctx); } },
    { label: "打开完整看板", click: () => { ctx.showWindow(ctx); } },
    { type: "separator" },
    { label: quota && quota.session ? `会话额度：${Math.round(quota.session.usedPercent)}% 已用` : "会话额度：暂无数据", enabled: false },
    { label: quota && quota.weekly ? `每周额度：${Math.round(quota.weekly.usedPercent)}% 已用` : "每周额度：暂无数据", enabled: false },
    { label: `今日用量：${ctx.formatTokens(ctx, data?.today?.totalTokens)} tokens`, enabled: false },
    { label: `累计用量：${ctx.formatTokens(ctx, data?.totals?.totalTokens)} tokens`, enabled: false },
    { label: `WorkBuddy 今日：${ctx.formatTokens(ctx, data?.workbuddy?.today?.totalTokens)} tokens`, enabled: false },
    { label: `Antigravity 今日：${ctx.formatTokens(ctx, data?.antigravity?.today?.totalTokens)} tokens`, enabled: false },
    { label: formatAgyQuotaLine(data?.antigravityQuota), enabled: false },
    { type: "separator" },
    { label: "立即同步数据", click: () => { ctx.refreshTrayStatus(ctx, true); } },
    {
      label: "科研通签到",
      click: () => { ctx.runTraySign(ctx); }
    },
    {
      label: "登录 Windows 时启动",
      type: "checkbox",
      checked: Boolean(ctx.preferences.launchAtLogin),
      click: item => {
        ctx.preferences.launchAtLogin = item.checked;
        ctx.savePreferences(ctx, ctx.userDataPaths(ctx));
        if (process.platform === "win32") ctx.app.setLoginItemSettings({ openAtLogin: item.checked, path: process.execPath });
        ctx.updateTray(ctx);
      }
    },
    {
      label: "启动时打开完整看板",
      type: "checkbox",
      checked: ctx.preferences.startMode === "dashboard",
      click: item => {
        ctx.preferences.startMode = item.checked ? "dashboard" : "popover";
        ctx.savePreferences(ctx, ctx.userDataPaths(ctx));
        ctx.updateTray(ctx);
      }
    },
    { type: "separator" },
    { label: "退出 TokenBar", click: () => ctx.app.quit() }
  ]);
  ctx.tray.setContextMenu(null);
}

// 注：refreshTrayStatus 保留在门面 main.cjs（源码守门测试 live-refresh.test.js 直接
// 读取其函数体断言 WorkBuddy 增量扫描形态），tray.cjs 通过 ctx.refreshTrayStatus 调用。

function createTray(ctx) {
  const image = ctx.nativeImage.createFromPath(ctx.path.join(ctx.DESKTOP_DIR, "icon.png")).resize({ width: 32, height: 32 });
  ctx.tray = new ctx.Tray(image);
  ctx.tray.setToolTip(`${ctx.PRODUCT_NAME} · 点击查看用量速览`);
  ctx.tray.on("click", () => ctx.togglePopover(ctx));
  ctx.tray.on("double-click", () => { ctx.showWindow(ctx); });
  ctx.tray.on("right-click", () => {
    if (ctx.trayMenu) ctx.tray.popUpContextMenu(ctx.trayMenu);
  });
  ctx.updateTray(ctx);
}

function installTray(ctx) {
  Object.assign(ctx, {
    pushStatusToPopover, pushAbleSciChanged, pushDetailProgress, attachWorkBuddySummary, attachAntigravitySummary,
    applyLiveQuota, refreshLiveQuota, attachLiveQuota,
    applyAntigravityQuota, refreshAntigravityQuota, attachAntigravityQuota,
    formatTokens, runTraySign, updateTray, createTray
  });
  return ctx;
}

module.exports = {
  installTray, pushStatusToPopover, pushAbleSciChanged, pushDetailProgress,
  attachWorkBuddySummary, attachAntigravitySummary, applyLiveQuota, refreshLiveQuota, attachLiveQuota,
  applyAntigravityQuota, refreshAntigravityQuota, attachAntigravityQuota,
  formatTokens, runTraySign, updateTray, createTray
};
