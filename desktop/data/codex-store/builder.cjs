"use strict";

/**
 * CodexStore / builder —— 构建与刷新编排
 *
 * buildFast / buildFull / buildDetail / init / refresh 只负责流程编排：
 * 文件发现与解析在 scan.cjs，聚合在 aggregate.cjs，缓存在 cache.cjs。
 * 所有状态（含 _buildPromise / _fullPromise / _detailPromise 并发闸门）都
 * 显式放在传入的 store 实例上，模块本身无全局可变状态，多实例不会串。
 */

const path = require("node:path");
const { TAIL_BYTES, FAST_FILE_COUNT } = require("./parse.cjs");

/** 快速快照：只处理最新几个文件，用于首屏 */
async function buildFast(store) {
  if (store._buildPromise) return store._buildPromise;
  store._buildPromise = (async () => {
    store.phase = "fast";
    const files = await store.listSessionFiles();
    store.sessionCount = files.length;
    const recent = files.slice(0, FAST_FILE_COUNT);
    for (const info of recent) {
      await store.ingestFile(info, { full: false, tailBytes: TAIL_BYTES });
    }
    // 让今日数据更可信：今天改动过的文件也纳入
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayFiles = files.filter(f => f.mtimeMs >= todayStart.getTime() && !recent.some(r => r.path === f.path));
    for (const info of todayFiles.slice(0, 12)) {
      await store.ingestFile(info, { full: false, tailBytes: TAIL_BYTES });
    }
    store.lastBuiltAt = new Date().toISOString();
    store.phase = "fast-done";
    store.saveCache();
    return store.snapshot();
  })();
  try {
    return await store._buildPromise;
  } finally {
    store._buildPromise = null;
  }
}

/** 全量构建：读所有文件全部内容，后台执行 */
async function buildFull(store) {
  if (store._fullPromise) return store._fullPromise;
  store._fullPromise = (async () => {
    store.phase = "full";
    const files = await store.listSessionFiles();
    store.sessionCount = files.length;
    for (const info of files) {
      await store.ingestFile(info, { full: true });
    }
    store.lastBuiltAt = new Date().toISOString();
    store.phase = "full-done";
    store.saveCache();
    return store.snapshot();
  })();
  try {
    return await store._fullPromise;
  } finally {
    store._fullPromise = null;
  }
}

async function init(store, { full = true } = {}) {
  store.loadCache();
  const cached = store.files.size > 0;
  if (!cached) {
    await store.buildFast();
  }
  if (full) {
    store.buildFull().catch(() => {});
  }
  return store.snapshot();
}

async function refresh(store, { full = false } = {}) {
  if (full) return store.buildFull();
  const files = await store.listSessionFiles();
  store.sessionCount = files.length;
  const recent = files.slice(0, FAST_FILE_COUNT);
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const active = files.filter(f => f.mtimeMs >= todayStart.getTime());
  const targets = [...recent, ...active].filter(
    (item, index, list) => list.findIndex(other => other.path === item.path) === index
  );
  for (const info of targets) {
    await store.ingestFile(info, { full: false });
  }
  store.lastBuiltAt = new Date().toISOString();
  store.saveCache();
  return store.snapshot();
}

/** 全量明细扫描（增量：按 size/mtime 跳过未变更文件） */
async function buildDetail(store, { onProgress } = {}) {
  if (store._detailPromise) return store._detailPromise;
  store._detailPromise = (async () => {
    const files = await store.listSessionFiles();
    store.sessionCount = files.length;
    let index = 0;
    let changed = false;
    for (const info of files) {
      index += 1;
      if (onProgress) onProgress({ index, total: files.length, name: path.basename(info.path) });
      const existing = store.detailFiles.get(info.path);
      if (existing && existing.size === info.size && existing.mtimeMs === info.mtimeMs && existing.detail) continue;
      try {
        const builder = store.createDetailBuilder(info.path);
        await store.scanFileDetail(info.path, info.size, builder.feed);
        store.detailFiles.set(info.path, {
          size: info.size,
          mtimeMs: info.mtimeMs,
          detail: builder.finish()
        });
        changed = true;
      } catch {
        /* 单个文件读取失败继续 */
      }
    }
    if (changed || !store.detailBuiltAt) store.detailBuiltAt = new Date().toISOString();
    if (changed) store.saveDetailCache();
    return store.detailSnapshot();
  })();
  try {
    return await store._detailPromise;
  } finally {
    store._detailPromise = null;
  }
}

module.exports = {
  buildFast,
  buildFull,
  buildDetail,
  init,
  refresh
};
