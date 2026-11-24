'use strict';

/**
 * 窗口管理（W3 拆分自 main.cjs）：完整看板窗口 + 托盘弹窗。
 * 四个安全配置 contextIsolation:true / nodeIntegration:false / sandbox:true /
 * webSecurity:true 逐字保留。所有依赖通过 ctx 注入。
 */

const { POPOVER_HEIGHT, WINDOW_WIDTH, WINDOW_HEIGHT, WINDOW_MIN_WIDTH, WINDOW_MIN_HEIGHT } = require('./constants.cjs');
const POPOVER_WIDTH = 396;

function loadingPage(ctx, message = "正在载入完整看板…") {
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${ctx.PRODUCT_NAME}</title><style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f2f5f9;color:#172235;font:14px/1.6 "Segoe UI",sans-serif}.card{width:min(460px,calc(100vw - 40px));padding:32px;border:1px solid #d9e1eb;border-radius:18px;background:#fff;box-shadow:0 20px 70px #20395a18}.mark{width:44px;height:44px;display:grid;place-items:center;border-radius:13px;background:#172235;color:#fff;font-weight:700;font-size:19px}.title{margin:22px 0 4px;font-size:24px}.muted{color:#64748b}.bar{height:5px;margin-top:22px;border-radius:8px;background:linear-gradient(90deg,#2a61dd 0 38%,#e8edf5 38%);animation:move 1.4s ease-in-out infinite alternate}@keyframes move{to{background:linear-gradient(90deg,#e8edf5 0 40%,#2a61dd 40% 76%,#e8edf5 76%)}}</style><section class="card"><div class="mark">&gt;_</div><h1 class="title">${ctx.PRODUCT_NAME}</h1><div class="muted">${message}</div><div class="bar"></div></section>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

/**
 * 完整看板窗口：直接加载本地 dashboard.html，由 preload 从 CodexStore 取数，
 * 不经过 server.js / index.html。
 */
function createWindow(ctx) {
  if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) return ctx.mainWindow;
  const { BrowserWindow, path } = ctx;

  ctx.mainWindow = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    minWidth: WINDOW_MIN_WIDTH,
    minHeight: WINDOW_MIN_HEIGHT,
    show: false,
    title: `${ctx.PRODUCT_NAME} · 用量看板`,
    backgroundColor: "#f3f4f7",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(ctx.DESKTOP_DIR, "dashboard-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });

  ctx.mainWindow.loadFile(path.join(ctx.DESKTOP_DIR, "dashboard.html"));
  ctx.mainWindow.once("ready-to-show", () => {
    if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) ctx.mainWindow.show();
  });
  ctx.mainWindow.on("close", event => {
    if (ctx.allowWindowClose || ctx.quitting) return;
    event.preventDefault();
    ctx.mainWindow.hide();
  });
  ctx.mainWindow.on("closed", () => {
    ctx.mainWindow = null;
  });
  ctx.mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) ctx.shell.openExternal(url);
    return { action: "deny" };
  });
  return ctx.mainWindow;
}

/**
 * 托盘弹窗：不依赖本地服务，数据直接来自 CodexStore
 */
function createPopover(ctx) {
  const { BrowserWindow, path } = ctx;
  ctx.popover = new BrowserWindow({
    width: POPOVER_WIDTH,
    height: POPOVER_HEIGHT,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    transparent: true,
    hasShadow: true,
    backgroundColor: "#00000000",
    roundedCorners: true,
    title: ctx.PRODUCT_NAME,
    webPreferences: {
      preload: path.join(ctx.DESKTOP_DIR, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });

  ctx.popover.loadFile(path.join(ctx.DESKTOP_DIR, "popover.html"));
  ctx.popover.webContents.once("did-finish-load", () => {
    ctx.popoverReady = true;
    ctx.pushStatusToPopover(ctx);
  });
  ctx.popover.on("blur", () => {
    if (ctx.popover && !ctx.popover.isDestroyed() && ctx.popover.isVisible()) ctx.hidePopover(ctx);
  });
  ctx.popover.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) ctx.shell.openExternal(url);
    return { action: "deny" };
  });
}

function popoverPosition(ctx, height = POPOVER_HEIGHT) {
  const { tray, screen } = ctx;
  const trayBounds = tray && typeof tray.getBounds === "function" ? tray.getBounds() : { x: 0, y: 0, width: 0, height: 0 };
  const anchor = trayBounds.width || trayBounds.height
    ? { x: Math.round(trayBounds.x + trayBounds.width / 2), y: Math.round(trayBounds.y + trayBounds.height / 2) }
    : { x: screen.getPrimaryDisplay().workArea.x + screen.getPrimaryDisplay().workArea.width, y: screen.getPrimaryDisplay().workArea.y + screen.getPrimaryDisplay().workArea.height };
  const area = screen.getDisplayNearestPoint(anchor).workArea;

  let x = Math.round(anchor.x - POPOVER_WIDTH / 2);
  let y;
  if (trayBounds.width && trayBounds.y > area.y + area.height / 2) {
    y = Math.round(trayBounds.y - height - 6);
  } else if (trayBounds.width) {
    y = Math.round(trayBounds.y + trayBounds.height + 6);
  } else {
    y = area.y + area.height - height - 10;
    x = area.x + area.width - POPOVER_WIDTH - 10;
  }

  x = Math.min(Math.max(x, area.x + 8), area.x + area.width - POPOVER_WIDTH - 8);
  y = Math.min(Math.max(y, area.y + 8), area.y + area.height - height - 8);
  return { x, y, width: POPOVER_WIDTH, height };
}

function showPopover(ctx) {
  if (!ctx.popover || ctx.popover.isDestroyed()) return;
  const bounds = ctx.popover.getBounds();
  ctx.popover.setBounds(ctx.popoverPosition(ctx, bounds.height));
  ctx.popover.showInactive();
  ctx.popover.focus();
  ctx.pushStatusToPopover(ctx);
  ctx.refreshTrayStatus(ctx).catch(() => {});
}

function hidePopover(ctx) {
  if (!ctx.popover || ctx.popover.isDestroyed()) return;
  if (ctx.popover.isVisible()) ctx.popover.hide();
}

function togglePopover(ctx) {
  if (!ctx.popover || ctx.popover.isDestroyed()) return;
  if (ctx.popover.isVisible()) ctx.hidePopover(ctx);
  else ctx.showPopover(ctx);
}

async function showWindow(ctx) {
  // 窗口是惰性创建的：默认启动模式不建看板窗口，
  // 早先这里直接 return，导致「打开完整看板」看起来毫无反应。
  const win = ctx.createWindow(ctx);
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function installWindows(ctx) {
  ctx.loadingPage = loadingPage;
  ctx.createWindow = createWindow;
  ctx.createPopover = createPopover;
  ctx.popoverPosition = popoverPosition;
  ctx.showPopover = showPopover;
  ctx.hidePopover = hidePopover;
  ctx.togglePopover = togglePopover;
  ctx.showWindow = showWindow;
  return ctx;
}

module.exports = {
  installWindows, loadingPage, createWindow, createPopover, popoverPosition,
  showPopover, hidePopover, togglePopover, showWindow
};
