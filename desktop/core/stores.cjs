'use strict';

/**
 * 数据层初始化（W3 拆分自 main.cjs）：历史基线 + 各 Store 装配。
 * 依赖 ctx 里的 store 构造与其他函数，函数间调用走 ctx.xxx(ctx, ...)。
 */

/**
 * 历史基线：usage-index.json 里存着本机历史上扫到的每条请求，包含 Codex
 * 已经清理掉的早期日志。没有它，累计会少算一大半。
 */
function resolveBaseline(ctx, paths) {
  const { fs, loadBaseline, baselineIsFresh, buildBaseline, saveBaseline } = ctx;
  const indexPath = paths.usageIndex;
  if (!fs.existsSync(indexPath)) return null;
  const cached = loadBaseline(paths.baseline);
  if (cached && baselineIsFresh(cached, indexPath)) return cached;
  try {
    const started = Date.now();
    const baseline = buildBaseline(indexPath);
    saveBaseline(paths.baseline, baseline);
    ctx.log(ctx, `history baseline: ${baseline.records} records, ${(baseline.totalTokens / 1e9).toFixed(2)}B, ${Object.keys(baseline.days).length} days, ${Date.now() - started}ms`);
    return baseline;
  } catch (error) {
    ctx.log(ctx, `history baseline failed: ${error.message}`);
    return cached || null;
  }
}

async function initStore(ctx, paths, baseline) {
  const { ensureTableFile, loadTable, path } = ctx;
  // 科研通签到：凭证用 safeStorage 加密，账号/状态落在 userData/data 下
  ctx.ablesciStore = ctx.createAbleSciStore({
    accountsFile: paths.ablesciAccounts,
    stateFile: paths.ablesciState,
    cipher: ctx.makeCipher(ctx)
  });

  // 实时额度：只读本机已有的 Codex auth.json，首次拉取后立即覆盖本地快照
  ctx.codexAuthStore = ctx.createCodexAuthStore({ hiddenFile: paths.codexHiddenAccounts });
  ctx.refreshLiveQuota(ctx, true).catch(() => {});

  // 单价数据：首次运行把内置表写到 userData，之后用户改文件即可更新价格
  ensureTableFile(paths.pricing);
  const pricing = loadTable(paths.pricing);
  ctx.log(ctx, `pricing: ${pricing.entries.length} models, USD→CNY ${pricing.usdCny}`);

  ctx.store = new ctx.CodexStore({
    sessionsDir: ctx.sessionsDir(ctx),
    cacheFile: paths.usageCache,
    detailCacheFile: paths.detailCache,
    baseline,
    pricing
  });
  // 明细缓存先读盘：看板第二次打开可以秒出
  ctx.store.loadDetailCache();

  ctx.wbStore = new ctx.WorkBuddyStore({
    roots: ctx.workBuddyRoots(ctx),
    cacheFile: paths.workbuddyCache,
    pricing
  });
  ctx.wbStore.loadCache();
  // WorkBuddy 日志量小（本机 38MB / 千条请求），并行构建，几十毫秒
  ctx.wbStore.build()
    .then(() => {
      const summary = ctx.wbStore.summary();
      const sources = (summary.roots || []).filter(item => item.files > 0).map(item => `${path.basename(item.root)}:${item.files}`).join(" + ");
      ctx.log(ctx, `workbuddy: ${ctx.wbStore.files.size} files (${sources}), ${(summary.totals.totalTokens / 1e6).toFixed(1)}M tokens`);
      ctx.attachWorkBuddySummary(ctx);
    })
    .catch(error => ctx.log(ctx, `workbuddy scan failed: ${error.message}`));

  const snapshot = await ctx.store.init({ full: false });
  ctx.latestStatus = snapshot;
  ctx.attachLiveQuota(ctx);
  ctx.updateTray(ctx);
  ctx.pushStatusToPopover(ctx);
  // 后台补齐历史：先让弹窗秒开，再静默把全量索引跑完并推一次更新
  ctx.store.buildFull()
    .then(fullSnapshot => {
      ctx.latestStatus = fullSnapshot;
      ctx.attachLiveQuota(ctx);
      ctx.updateTray(ctx);
      ctx.pushStatusToPopover(ctx);
      // 再补一次明细：拿到「线程累计」口径（含被清理的早期历史），
      // 弹窗与看板才能显示同一个总量
      return ctx.store.buildDetail().then(() => {
        ctx.latestStatus = ctx.store.snapshot();
        ctx.attachLiveQuota(ctx);
        ctx.updateTray(ctx);
        ctx.pushStatusToPopover(ctx);
      });
    })
    .catch(error => {
      ctx.startupError = `历史索引构建失败：${error.message}`;
      ctx.updateTray(ctx);
    });
}

function installStores(ctx) {
  ctx.resolveBaseline = resolveBaseline;
  ctx.initStore = initStore;
  return ctx;
}

module.exports = { installStores, resolveBaseline, initStore };
