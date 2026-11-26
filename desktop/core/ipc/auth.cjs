'use strict';

/**
 * Codex 授权 / 实时额度 IPC handlers（W3 拆分自 main.cjs）。
 * 所有 channel 名与参数签名逐字不变（preload 白名单依赖）。
 */

/**
 * 实时额度（复用本机 Codex 授权）：弹窗与完整看板共用同一组 handler。
 * 与科研通签到不同，这里不需要用户再登录——本机 auth.json 已有 token。
 */
function registerCodexAuthHandlers(ctx) {
  ctx.ipcMain.handle("codex-auth:list", () => {
    if (!ctx.codexAuthStore) return { accounts: [], codexHome: "", activeId: null };
    try { return ctx.codexAuthStore.list(); }
    catch (e) { return { accounts: [], codexHome: "", activeId: null, error: e.message }; }
  });
  ctx.ipcMain.handle("codex-auth:fetch", async (_event, accountId, opts) => {
    if (!ctx.codexAuthStore) throw new Error("授权模块尚未就绪");
    const result = await ctx.codexAuthStore.fetchQuota(accountId, opts || {});
    // 取到额度后立刻覆盖当前快照，让 5 小时 / 7 天卡片显示实时值
    ctx.applyLiveQuota(ctx, result);
    return result;
  });
  ctx.ipcMain.handle("codex-auth:active", async (_event, opts) => {
    if (!ctx.codexAuthStore) return null;
    const result = await ctx.codexAuthStore.activeQuota(opts || {});
    if (result) ctx.applyLiveQuota(ctx, result);
    return result;
  });

  // OAuth Device Code 授权：配对码只在主进程内存里，token 只落本机
  ctx.ipcMain.handle("codex-auth:device-start", async () => {
    if (!ctx.codexAuthStore) throw new Error("授权模块尚未就绪");
    return ctx.codexAuthStore.startDeviceAuth();
  });
  ctx.ipcMain.handle("codex-auth:device-poll", async (_event, sessionId) => {
    if (!ctx.codexAuthStore) throw new Error("授权模块尚未就绪");
    return ctx.codexAuthStore.pollDeviceAuth(sessionId);
  });
  ctx.ipcMain.handle("codex-auth:device-status", (_event, sessionId) => {
    if (!ctx.codexAuthStore) return null;
    return ctx.codexAuthStore.deviceStatus(sessionId);
  });
  ctx.ipcMain.handle("codex-auth:device-cancel", (_event, sessionId) => {
    if (!ctx.codexAuthStore) return false;
    return ctx.codexAuthStore.cancelDeviceAuth(sessionId);
  });

  // 隐藏 / 恢复账号：只改 TokenBar 自己的清单，不碰本机 auth.json
  ctx.ipcMain.handle("codex-auth:hide", (_event, accountId) => {
    if (!ctx.codexAuthStore) return false;
    return ctx.codexAuthStore.hideAccount(accountId);
  });
  ctx.ipcMain.handle("codex-auth:unhide", (_event, accountId) => {
    if (!ctx.codexAuthStore) return false;
    return ctx.codexAuthStore.unhideAccount(accountId);
  });

  // Antigravity 实时额度：复用本机钥匙串 `gemini:antigravity` 与 CC Switch 账号表（只读）
  ctx.ipcMain.handle("antigravity-auth:list", () => {
    if (!ctx.agyQuotaStore) return { accounts: [], activeId: null };
    try { return ctx.agyQuotaStore.list(); }
    catch (e) { return { accounts: [], activeId: null, error: e.message }; }
  });
  ctx.ipcMain.handle("antigravity-auth:fetch", async (_event, accountId, opts) => {
    if (!ctx.agyQuotaStore) throw new Error("Antigravity 额度模块尚未就绪");
    const result = await ctx.agyQuotaStore.fetchQuota(accountId, opts || {});
    ctx.applyAntigravityQuota(ctx, result);
    return result;
  });
  ctx.ipcMain.handle("antigravity-auth:active", async (_event, opts) => {
    if (!ctx.agyQuotaStore) return null;
    const result = await ctx.agyQuotaStore.activeQuota(opts || {});
    if (result) ctx.applyAntigravityQuota(ctx, result);
    return result;
  });
}

function installAuthIpc(ctx) {
  ctx.registerCodexAuthHandlers = registerCodexAuthHandlers;
  return ctx;
}

module.exports = { installAuthIpc, registerCodexAuthHandlers };
