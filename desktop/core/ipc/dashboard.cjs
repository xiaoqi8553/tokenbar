'use strict';

/**
 * 完整看板 IPC handlers（W3 拆分自 main.cjs）。
 * 所有 channel 名与参数签名逐字不变（preload 白名单依赖）。
 */

function registerDashboardHandlers(ctx) {
  ctx.ipcMain.handle("dashboard:status", () => ctx.latestStatus || (ctx.store ? ctx.store.snapshot() : null));

  ctx.ipcMain.handle("dashboard:get-detail", async () => {
    if (!ctx.store) throw new Error("用量数据层尚未初始化，请稍候重试");
    const detail = await ctx.store.buildDetail({ onProgress: progress => ctx.pushDetailProgress(ctx, progress) });
    ctx.latestStatus = ctx.store.snapshot();
    // 新快照是干净的：WorkBuddy / Antigravity 摘要与实时额度都要重新挂上
    ctx.attachWorkBuddySummary(ctx);
    ctx.attachAntigravitySummary(ctx);
    ctx.attachLiveQuota(ctx);
    ctx.attachAntigravityQuota(ctx);
    ctx.updateTray(ctx);
    ctx.pushStatusToPopover(ctx);
    return detail;
  });

  ctx.ipcMain.handle("dashboard:refresh", async () => {
    if (!ctx.store) throw new Error("用量数据层尚未初始化，请稍候重试");
    await ctx.store.refresh({ full: true });
    const detail = await ctx.store.buildDetail({ onProgress: progress => ctx.pushDetailProgress(ctx, progress) });
    ctx.latestStatus = ctx.store.snapshot();
    ctx.attachWorkBuddySummary(ctx);
    ctx.attachAntigravitySummary(ctx);
    ctx.attachLiveQuota(ctx);
    ctx.attachAntigravityQuota(ctx);
    ctx.updateTray(ctx);
    ctx.pushStatusToPopover(ctx);
    return detail;
  });

  // WorkBuddy 用量：与 Codex 完全独立的第二个数据源，切到该标签时按需构建
  ctx.ipcMain.handle("dashboard:workbuddy-detail", async () => {
    if (!ctx.wbStore) return null;
    const detail = await ctx.wbStore.build({ onProgress: progress => ctx.pushDetailProgress(ctx, progress) });
    ctx.attachWorkBuddySummary(ctx);
    return detail;
  });

  ctx.ipcMain.handle("dashboard:workbuddy-refresh", async () => {
    if (!ctx.wbStore) return null;
    const detail = await ctx.wbStore.build({ onProgress: progress => ctx.pushDetailProgress(ctx, progress), force: true });
    ctx.attachWorkBuddySummary(ctx);
    return detail;
  });

  // Antigravity 用量：对齐 CC Switch 口径，切到该标签时按需构建
  ctx.ipcMain.handle("dashboard:antigravity-detail", async () => {
    if (!ctx.agyStore) return null;
    const detail = await ctx.agyStore.build({ onProgress: progress => ctx.pushDetailProgress(ctx, progress) });
    ctx.attachAntigravitySummary(ctx);
    ctx.refreshAntigravityQuota(ctx).catch(() => {});
    return detail;
  });

  ctx.ipcMain.handle("dashboard:antigravity-refresh", async () => {
    if (!ctx.agyStore) return null;
    const detail = await ctx.agyStore.build({ onProgress: progress => ctx.pushDetailProgress(ctx, progress), force: true });
    ctx.attachAntigravitySummary(ctx);
    await ctx.refreshAntigravityQuota(ctx, true).catch(() => {});
    return detail;
  });

  ctx.ipcMain.handle("dashboard:meta", () => ({
    name: ctx.PRODUCT_NAME,
    version: ctx.app.getVersion(),
    repo: "https://github.com/xiaoqi8553/tokenbar",
    packaged: ctx.app.isPackaged
  }));

  ctx.ipcMain.handle("dashboard:open-sessions", () => ctx.shell.openPath(ctx.sessionsDir(ctx)));
  ctx.ipcMain.handle("dashboard:open-workbuddy", () => {
    const roots = ctx.workBuddyRoots(ctx);
    // 优先打开有数据的那套（国际版在前）
    const target = roots.find(root => ctx.fs.existsSync(ctx.path.join(root, "projects"))) || roots[0];
    return ctx.shell.openPath(ctx.path.join(target, "projects"));
  });
  ctx.ipcMain.handle("dashboard:open-antigravity", () => {
    const roots = ctx.antigravityRoots(ctx);
    const target = roots.find(root => ctx.fs.existsSync(ctx.path.join(root, "brain"))) || roots[0];
    return ctx.shell.openPath(ctx.path.join(target, "brain"));
  });
  ctx.ipcMain.handle("dashboard:open-external", (_event, url) => {
    if (typeof url === "string" && /^https:\/\//i.test(url)) ctx.shell.openExternal(url);
    return true;
  });
}

function installDashboardIpc(ctx) {
  ctx.registerDashboardHandlers = registerDashboardHandlers;
  return ctx;
}

module.exports = { installDashboardIpc, registerDashboardHandlers };
