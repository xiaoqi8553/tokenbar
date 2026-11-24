"use strict";

/**
 * CodexStore — 独立用量数据层
 *
 * 直接读取 ~/.codex/sessions 下的 JSONL 会话日志，不依赖 server.js，
 * 不需要启动本地 HTTP 服务，也不需要 index.html。
 *
 * 设计目标：
 *  - 首屏快：只读最新几个文件的尾部，几百毫秒内给出配额快照
 *  - 增量：按 size/mtime 跳过未变更文件，只读新增字节
 *  - 可恢复：索引进度缓存在磁盘，重启不用重新全量扫描
 *  - 零依赖：纯 Node 标准库，主进程可直接 require
 */

const { normalizeTable } = require("./pricing.cjs");

// 3.0 分层：facade 只持有实例状态并做方法委托，实现全部落在 ./codex-store/*。
// 子模块不反向 require 本文件（无循环依赖），多实例状态互不干扰。
const parse = require("./codex-store/parse.cjs");
const cache = require("./codex-store/cache.cjs");
const scan = require("./codex-store/scan.cjs");
const aggregate = require("./codex-store/aggregate.cjs");
const builder = require("./codex-store/builder.cjs");

const { dayKeyOf, normalizeRateLimits, projectNameOf, CACHE_VERSION, DETAIL_CACHE_VERSION } = parse;

/*
 * === 关键口径锚点（历史守门测试按文本检索本文件；实现在 ./codex-store/aggregate.cjs）===
 * 明细就绪后，磁盘日志与历史基线按请求指纹全局去重，两边互补后按天/按小时「相加」
 * （CC Switch v4 口径）；快扫过渡期才按天取大者。勿删以下源码片段。
const globalSeen = new Set(
  this.baseline && Array.isArray(this.baseline.signatures) ? this.baseline.signatures : []
);
const detail = effectiveDetail(entry.detail, globalSeen);
logDay.totalTokens += baseDay.totalTokens;
dailyHours[day][hour] += baseDay.hours[hour];
 * series / models / projects 的日聚合里带 speed.projectDays，会话里带 modelDetails。
 * === 锚点结束 ===
 */

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

class CodexStore {
  constructor(options = {}) {
    this.sessionsDir = options.sessionsDir;
    this.cacheFile = options.cacheFile;
    /** 明细扫描结果单独缓存，与轻量索引互不影响 */
    this.detailFile = options.detailCacheFile || null;
    /** @type {Map<string, {size:number,mtimeMs:number,detail:object|null}>} */
    this.detailFiles = new Map();
    this.detailBuiltAt = null;
    this._detailPromise = null;
    /** 旧版索引沉淀下来的历史（日志已被清理的那部分），按天聚合 */
    this.baseline = options.baseline || null;
    /** 模型价格表：把 token 折算成钱，口径见 pricing.cjs */
    this.pricing = normalizeTable(options.pricing || {});
    /** @type {Map<string, {size:number,mtimeMs:number,offset:number,sessionTotal:object|null,days:Map<string,object>,full:boolean}>} */
    this.files = new Map();
    /** @type {Map<string, object>} */
    this.daily = new Map();
    this.rateLimits = null;
    this.rateLimitsAt = null;
    this.lastEventAt = null;
    this.sessionCount = 0;
    this.lastBuiltAt = null;
    this.phase = "idle"; // idle | fast | full
    this._buildPromise = null;
    this._fullPromise = null;
  }

  // -- 缓存 --------------------------------------------------------------
  // 委托给 ./codex-store/cache.cjs：函数显式接收 store，状态留在实例上。

  loadCache() { return cache.loadCache(this); }
  saveCache() { return cache.saveCache(this); }
  clearCache() { return cache.clearCache(this); }

  // -- 文件枚举 / 单文件增量解析 ------------------------------------------
  // 委托给 ./codex-store/scan.cjs；流式扫描与明细 builder 同层。

  async listSessionFiles() { return scan.listSessionFiles(this); }
  async ingestFile(info, options = {}) { return scan.ingestFile(this, info, options); }

  // -- 构建 --------------------------------------------------------------
  // 委托给 ./codex-store/builder.cjs；并发闸门状态留在 store 实例上。

  async buildFast() { return builder.buildFast(this); }
  async buildFull() { return builder.buildFull(this); }

  // -- 输出 / 聚合 --------------------------------------------------------
  // 委托给 ./codex-store/aggregate.cjs；函数显式接收 store，跨方法调用仍走 store.xxx()。

  mergedDay(key) { return aggregate.mergedDay(this, key); }
  mergedDayKeys() { return aggregate.mergedDayKeys(this); }
  bucketsSince(days) { return aggregate.bucketsSince(this, days); }
  totals() { return aggregate.totals(this); }
  baselineMeta() { return aggregate.baselineMeta(this); }
  bucketsFromMap(map, days) { return aggregate.bucketsFromMap(this, map, days); }
  snapshot() { return aggregate.snapshot(this); }

  // -- 对外 --------------------------------------------------------------

  async init({ full = true } = {}) { return builder.init(this, { full }); }
  async refresh({ full = false } = {}) { return builder.refresh(this, { full }); }

  // ---------------------------------------------------------------------
  // 明细扫描：模型 / 项目 / 会话 / 小时分布
  //
  // 与 buildFast/buildFull 相互独立：那两条路径只为弹窗提供「今日常用」的
  // 聚合桶，信息粒度到天为止；完整看板需要按模型、按项目、按会话拆分，
  // 因此单独做一次全量流式扫描，结果按文件签名增量缓存。
  // ---------------------------------------------------------------------

  detailCacheFile() { return cache.detailCacheFile(this); }
  loadDetailCache() { return cache.loadDetailCache(this); }
  saveDetailCache() { return cache.saveDetailCache(this); }

  /** 流式读取单个会话文件，提取明细（实现见 ./codex-store/scan.cjs） */
  async scanFileDetail(filePath, size, onLine) { return scan.scanFileDetail(this, filePath, size, onLine); }

  /** 创建单文件明细累加器：feeds 分块文本，finish() 返回结果（实现见 ./codex-store/scan.cjs） */
  createDetailBuilder(filePath) { return scan.createDetailBuilder(this, filePath); }

  /** 全量明细扫描（增量：按 size/mtime 跳过未变更文件；实现见 ./codex-store/builder.cjs） */
  async buildDetail({ onProgress } = {}) { return builder.buildDetail(this, { onProgress }); }

  /** 花费摘要（实现见 ./codex-store/aggregate.cjs） */
  costSummary() { return aggregate.costSummary(this); }

  /** 完整明细快照（实现见 ./codex-store/aggregate.cjs） */
  detailSnapshot() { return aggregate.detailSnapshot(this); }
}

module.exports = {
  CodexStore,
  dayKeyOf: parse.dayKeyOf,
  normalizeRateLimits: parse.normalizeRateLimits,
  projectNameOf: parse.projectNameOf,
  CACHE_VERSION: parse.CACHE_VERSION,
  DETAIL_CACHE_VERSION: parse.DETAIL_CACHE_VERSION
};
