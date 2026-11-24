"use strict";

/**
 * CodexStore / cache —— 缓存层
 *
 * 轻量索引缓存（CACHE_VERSION）与明细缓存（DETAIL_CACHE_VERSION）互不干扰。
 * 这里所有函数都显式接收 store 作为第一个参数：实例状态只存在于 facade 的
 * CodexStore 实例上，模块本身无全局可变状态，多实例不会串。
 *
 * 版本注释（从原 codex-store.cjs 搬来）：
 *  - v4：快扫路径也做相邻重复快照去重（v3 逐行累加）
 *  - v7：明细带请求指纹，合并时与历史基线全局去重（v6 按天取大者，会把 fork 重放算多遍）
 */

const fs = require("node:fs");
const path = require("node:path");
const { CACHE_VERSION, DETAIL_CACHE_VERSION } = require("./parse.cjs");

function loadCache(store) {
  if (!store.cacheFile) return false;
  try {
    const raw = fs.readFileSync(store.cacheFile, "utf8");
    const data = JSON.parse(raw);
    if (!data || data.version !== CACHE_VERSION) return false;
    store.daily = new Map(Object.entries(data.daily || {}));
    store.rateLimits = data.rateLimits || null;
    store.rateLimitsAt = data.rateLimitsAt || null;
    store.lastEventAt = data.lastEventAt || null;
    store.sessionCount = Number(data.sessionCount) || 0;
    store.lastBuiltAt = data.lastBuiltAt || null;
    store.files = new Map();
    for (const entry of data.files || []) {
      store.files.set(entry.path, {
        size: Number(entry.size) || 0,
        mtimeMs: Number(entry.mtimeMs) || 0,
        offset: Number(entry.offset) || 0,
        sessionTotal: entry.sessionTotal || null,
        days: new Map(Object.entries(entry.days || {})),
        full: Boolean(entry.full)
      });
    }
    return true;
  } catch {
    return false;
  }
}

function saveCache(store) {
  if (!store.cacheFile) return;
  try {
    const payload = {
      version: CACHE_VERSION,
      savedAt: new Date().toISOString(),
      daily: Object.fromEntries(store.daily),
      rateLimits: store.rateLimits,
      rateLimitsAt: store.rateLimitsAt,
      lastEventAt: store.lastEventAt,
      sessionCount: store.sessionCount,
      lastBuiltAt: store.lastBuiltAt,
      files: [...store.files.entries()].map(([filePath, entry]) => ({
        path: filePath,
        size: entry.size,
        mtimeMs: entry.mtimeMs,
        offset: entry.offset,
        sessionTotal: entry.sessionTotal,
        days: Object.fromEntries(entry.days),
        full: Boolean(entry.full)
      }))
    };
    fs.mkdirSync(path.dirname(store.cacheFile), { recursive: true });
    fs.writeFileSync(store.cacheFile, JSON.stringify(payload), "utf8");
  } catch {
    /* 缓存失败不影响功能 */
  }
}

function clearCache(store) {
  store.files.clear();
  store.daily.clear();
  store.rateLimits = null;
  store.rateLimitsAt = null;
  store.lastEventAt = null;
  try {
    if (store.cacheFile) fs.rmSync(store.cacheFile, { force: true });
  } catch {
    /* ignore */
  }
}

function detailCacheFile(store) {
  return store.detailFile || null;
}

function loadDetailCache(store) {
  const file = detailCacheFile(store);
  if (!file) return false;
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!data || data.version !== DETAIL_CACHE_VERSION) return false;
    store.detailFiles = new Map();
    for (const entry of data.files || []) {
      store.detailFiles.set(entry.path, {
        size: Number(entry.size) || 0,
        mtimeMs: Number(entry.mtimeMs) || 0,
        detail: entry.detail || null
      });
    }
    // 缓存命中也要先算一遍日聚合，否则弹窗会在 detail 扫描前用快扫口径
    if (store.detailFiles.size) {
      try {
        store.detailSnapshot();
      } catch {
        /* 缓存结构异常时交给后续扫描重建 */
      }
    }
    return store.detailFiles.size > 0;
  } catch {
    return false;
  }
}

function saveDetailCache(store) {
  const file = detailCacheFile(store);
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      version: DETAIL_CACHE_VERSION,
      savedAt: new Date().toISOString(),
      files: [...store.detailFiles.entries()].map(([filePath, entry]) => ({
        path: filePath,
        size: entry.size,
        mtimeMs: entry.mtimeMs,
        detail: entry.detail
      }))
    }), "utf8");
  } catch {
    /* 缓存失败不影响功能 */
  }
}

module.exports = {
  loadCache,
  saveCache,
  clearCache,
  detailCacheFile,
  loadDetailCache,
  saveDetailCache
};
