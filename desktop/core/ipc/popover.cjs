'use strict';

/**
 * 弹窗 IPC handlers（W3 拆分自 main.cjs）。
 * 所有 channel 名与参数签名逐字不变（preload 白名单依赖）。
 */

function registerPopoverHandlers(ctx) {
  ctx.ipcMain.handle("popover:refresh", async () => {
    await ctx.refreshTrayStatus(ctx, true);
    return ctx.latestStatus;
  });
  ctx.ipcMain.handle("popover:open-dashboard", async () => {
    ctx.hidePopover(ctx);
    await ctx.showWindow(ctx);
    return true;
  });
  ctx.ipcMain.handle("popover:close", () => {
    ctx.hidePopover(ctx);
    return true;
  });
  ctx.ipcMain.handle("popover:quit", () => {
    ctx.app.quit();
    return true;
  });
  ctx.ipcMain.handle("popover:open-status-page", () => {
    ctx.shell.openExternal("https://status.openai.com/");
    return true;
  });
  ctx.ipcMain.handle("popover:prefs", () => ({
    launchAtLogin: Boolean(ctx.preferences.launchAtLogin),
    startMode: ctx.preferences.startMode
  }));
  ctx.ipcMain.on("popover:set-height", (_event, requested) => {
    if (!ctx.popover || ctx.popover.isDestroyed()) return;
    const area = ctx.screen.getDisplayNearestPoint(ctx.screen.getCursorScreenPoint()).workArea;
    const maxHeight = Math.max(320, area.height - 32);
    const nextHeight = Math.min(Math.max(Math.round(requested), 320), maxHeight);
    const bounds = ctx.popover.getBounds();
    if (!nextHeight || Math.abs(bounds.height - nextHeight) < 2) return;
    // Keep the panel bottom-anchored above the tray icon while it grows.
    const nextY = Math.min(
      Math.max(bounds.y + bounds.height - nextHeight, area.y + 8),
      area.y + area.height - nextHeight - 8
    );
    ctx.popover.setBounds({ x: bounds.x, y: nextY, width: bounds.width, height: nextHeight });
  });
  ctx.ipcMain.handle("popover:set-launch-at-login", (_event, enabled) => {
    ctx.preferences.launchAtLogin = Boolean(enabled);
    ctx.savePreferences(ctx, ctx.userDataPaths(ctx));
    if (process.platform === "win32") ctx.app.setLoginItemSettings({ openAtLogin: Boolean(enabled), path: process.execPath });
    ctx.updateTray(ctx);
    return { launchAtLogin: ctx.preferences.launchAtLogin };
  });

  // ---- 科研通签到（弹窗与完整看板共用） ----
  ctx.ipcMain.handle("ablesci:list", () => {
    if (!ctx.ablesciStore) return { accounts: [], today: "" };
    try { return ctx.ablesciStore.list(); } catch (e) { return { accounts: [], today: "", error: e.message }; }
  });
  ctx.ipcMain.handle("ablesci:add", (_event, email, password) => {
    if (!ctx.ablesciStore) throw new Error("签到模块尚未就绪");
    return ctx.ablesciStore.addAccount(email, password);
  });
  ctx.ipcMain.handle("ablesci:remove", (_event, id) => {
    if (!ctx.ablesciStore) throw new Error("签到模块尚未就绪");
    return ctx.ablesciStore.removeAccount(id);
  });
  ctx.ipcMain.handle("ablesci:sign", async () => {
    if (!ctx.ablesciStore) throw new Error("签到模块尚未就绪");
    const result = await ctx.ablesciStore.sign();
    ctx.log(ctx, `ablesci sign: ${result.summary}`);
    return result;
  });
  ctx.ipcMain.handle("ablesci:open-site", () => {
    ctx.shell.openExternal("https://www.ablesci.com/");
    return true;
  });
}

function installPopoverIpc(ctx) {
  ctx.registerPopoverHandlers = registerPopoverHandlers;
  return ctx;
}

module.exports = { installPopoverIpc, registerPopoverHandlers };
