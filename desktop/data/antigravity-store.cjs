"use strict";

/**
 * AntigravityStore — Antigravity 用量数据层（计算口径对齐 CC Switch）
 *
 * 数据来源（自动扫描所有 Antigravity 根目录，按会话 id 去重）：
 *   - ~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript_full.jsonl
 *   - ~/.gemini/antigravity/brain/<id>/.system_generated/logs/transcript_full.jsonl
 *   - ~/.gemini/antigravity-acp/brain/<id>/.system_generated/logs/transcript_full.jsonl
 *   - ~/.cc-switch/agy/<provider>/antigravity-cli/brain/...
 *   - ~/.t3/{userdata,dev}/providers/antigravity/<instance>/antigravity-acp/brain/...
 *
 * 口径要点（完全对齐 CC Switch `session_usage_agy.rs` + `native_models.rs`）：
 *  1. 仅统计 `type === "PLANNER_RESPONSE"` 且 `status === "DONE"`、且存在非零 token 的记录。
 *  2. 同一 `step_index` 重复写入时，保留 JSONL 中最后一次出现的完整记录。
 *  3. Token 语义（与 Codex / WorkBuddy 的重要区别）：
 *     - Antigravity 原生导出中 `input_tokens` **不含**缓存读取（fresh input），
 *       `output_tokens` **已包含**思考 tokens（不再重复加减）。
 *     - 为与 TokenBar 全链路桶结构（`新增输入 = inputTokens - cachedInputTokens`）保持同构：
 *         inputTokens       = rawInput + cacheRead
 *         cachedInputTokens = cacheRead
 *         cacheWriteTokens  = cacheWrite
 *         outputTokens      = rawOutput
 *         totalTokens       = rawInput + cacheRead + cacheWrite + rawOutput
 *       这样「新增输入」「缓存命中」「命中率」「合计」「API 等价花费」与 CC Switch 严格一致。
 *  4. 模型归属优先级：
 *     - 显式 `row.model`（非 unknown） > 按 `step_index` 顺序继承的 `Model Selection` 切换事件
 *       > 伴生数据库 `conversations/<id>.db` 的 `steps -> gen_metadata`（含 Orchestrator 角色映射）。
 *  5. 速度（tok/s 与首字 TTFT）：
 *     - 从 `conversations/<id>.db` 的 `gen_metadata` 提取 `first_token_ms` 与 `streaming_ms`，
 *       `latencyMs = first_token_ms + streaming_ms`，据此计算 `tps` 与 `ttftMs` 中位数。
 *  6. 全局去重：按 `agy:${sessionId}:${stepIndex}` 去重，避免多根目录或重复扫描叠加计数。
 */

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { normalizeTable, costOfModels, describeTable } = require("./pricing.cjs");
const {
  modelIdOf,
  orchestratorMode,
  isOrchestrator,
  isOrchestratorWorker,
  isUnresolvedWorkerTarget,
  modelFromSettingsChange,
  nativeStateFingerprint,
  readGenerationsForTranscript,
  readSummariesIndex,
  isWithinDir
} = require("./antigravity-native.cjs");

const CACHE_VERSION = 1;
const SCAN_CHUNK_BYTES = 4 * 1024 * 1024;

function pad2(value) {
  return String(value).padStart(2, "0");
}

function dayKeyOf(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function projectNameOf(cwd) {
  if (!cwd) return null;
  const parts = String(cwd).split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : null;
}

function nonNegInt(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

function validSessionId(id) {
  return Boolean(id) && /^[A-Za-z0-9-]+$/.test(id);
}

function zeroBucket() {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    records: 0
  };
}

function addBucket(target, source, sign = 1) {
  for (const key of Object.keys(zeroBucket())) {
    target[key] = (target[key] || 0) + sign * (source[key] || 0);
  }
}

function knownModel(row) {
  const raw = row && typeof row.model === "string" ? row.model.trim() : "";
  if (!raw || raw.toLowerCase() === "unknown") return null;
  return raw;
}

function subdirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => path.join(dir, entry.name))
      .sort();
  } catch {
    return [];
  }
}

function defaultAntigravityRoots() {
  const envHome = (process.env.ANTIGRAVITY_HOME || process.env.AGY_HOME || "").trim();
  if (envHome) {
    const candidates = [
      envHome,
      path.join(envHome, "antigravity-cli"),
      path.join(envHome, "antigravity"),
      path.join(envHome, "antigravity-acp")
    ];
    const existing = candidates.filter(dir => fs.existsSync(path.join(dir, "brain")));
    return existing.length ? [...new Set(existing)] : [envHome];
  }

  const home = os.homedir();
  const candidates = [
    path.join(home, ".gemini", "antigravity-cli"),
    path.join(home, ".gemini", "antigravity"),
    path.join(home, ".gemini", "antigravity-acp")
  ];

  // CC Switch 私有 API Key 配置目录：~/.cc-switch/agy/<provider>/antigravity-cli
  const ccSwitchAgy = path.join(home, ".cc-switch", "agy");
  for (const dir of subdirs(ccSwitchAgy)) {
    candidates.push(path.join(dir, "antigravity-cli"));
  }

  // T3 Code ACP 隔离目录：$T3CODE_HOME 或 ~/.t3/{userdata,dev}/providers/antigravity/<instance>/antigravity-acp
  const t3Homes = [];
  const t3Env = (process.env.T3CODE_HOME || "").trim();
  if (t3Env) t3Homes.push(t3Env);
  t3Homes.push(path.join(home, ".t3"));
  for (const t3Home of [...new Set(t3Homes)]) {
    for (const stateDir of ["userdata", "dev"]) {
      const instancesRoot = path.join(t3Home, stateDir, "providers", "antigravity");
      for (const instanceDir of subdirs(instancesRoot)) {
        candidates.push(path.join(instanceDir, "antigravity-acp"));
      }
    }
  }

  const out = [];
  const seen = new Set();
  for (const dir of candidates) {
    if (!fs.existsSync(path.join(dir, "brain"))) continue;
    let key = path.resolve(dir);
    try {
      key = fs.realpathSync(dir);
    } catch {
      /* ignore */
    }
    if (process.platform === "win32") key = key.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(dir);
  }
  return out.length ? out : [path.join(home, ".gemini", "antigravity")];
}

class AntigravityStore {
  /**
   * @param {{root?:string, roots?:string[], cacheFile?:string, pricing?:object}} options
   */
  constructor(options = {}) {
    const roots = Array.isArray(options.roots) && options.roots.length
      ? options.roots.filter(Boolean)
      : (options.root ? [options.root] : defaultAntigravityRoots());
    this.roots = [...new Set(roots)];
    this.root = this.roots[0];
    this.pricing = normalizeTable(options.pricing || {});
    this.cacheFile = options.cacheFile || null;
    /** @type {Map<string, {size:number,mtimeMs:number,nativeStamp:string,project:string,cwd:?string,detail:object}>} */
    this.files = new Map();
    this.rootsInfo = [];
    this.builtAt = null;
    this.phase = "idle";
    this._promise = null;
  }

  /**
   * 发现所有 Antigravity 根目录下的 brain/<sessionId>/.system_generated/logs/transcript_full.jsonl，
   * 同会话 id 在多根目录存在时保留体积更大（或更新）的那份，避免重复统计。
   */
  listFiles() {
    /** @type {Map<string, {path:string,sessionId:string,root:string,size:number,mtimeMs:number}>} */
    const bySession = new Map();
    const info = [];

    for (const root of this.roots) {
      const brainDir = path.join(root, "brain");
      let canonicalBrain = null;
      try {
        if (fs.existsSync(brainDir)) canonicalBrain = fs.realpathSync(brainDir);
      } catch {
        canonicalBrain = null;
      }

      let entries = [];
      try {
        entries = fs.readdirSync(brainDir, { withFileTypes: true });
      } catch {
        entries = [];
      }

      let found = 0;
      const rootSessions = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const sessionId = entry.name;
        if (!validSessionId(sessionId)) continue;
        const filePath = path.join(brainDir, sessionId, ".system_generated", "logs", "transcript_full.jsonl");
        try {
          if (!fs.existsSync(filePath)) continue;
          const realFile = fs.realpathSync(filePath);
          if (canonicalBrain && !isWithinDir(realFile, canonicalBrain)) continue;
          const stat = fs.statSync(realFile);
          if (!stat.isFile()) continue;
          found += 1;
          rootSessions.push({ path: filePath, sessionId, root, size: stat.size, mtimeMs: stat.mtimeMs });
        } catch {
          /* 边扫边删或权限不足的日志跳过 */
        }
      }

      let kept = 0;
      for (const item of rootSessions) {
        const prev = bySession.get(item.sessionId);
        const wins = !prev
          || item.size > prev.size
          || (item.size === prev.size && item.mtimeMs > prev.mtimeMs);
        if (!wins) continue;
        bySession.set(item.sessionId, item);
        kept += 1;
      }
      info.push({ root, files: found, kept });
    }

    this.rootsInfo = info;
    const out = [...bySession.values()];
    out.sort((a, b) => a.mtimeMs - b.mtimeMs);
    return out;
  }

  loadCache() {
    if (!this.cacheFile) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.cacheFile, "utf8"));
      if (!raw || raw.version !== CACHE_VERSION || !Array.isArray(raw.files)) return;
      for (const entry of raw.files) {
        if (!entry || !entry.path || !entry.detail) continue;
        this.files.set(entry.path, {
          size: entry.size,
          mtimeMs: entry.mtimeMs,
          nativeStamp: entry.nativeStamp || "none",
          project: entry.project || "Antigravity",
          cwd: entry.cwd || null,
          detail: entry.detail
        });
      }
      this.builtAt = raw.savedAt || null;
    } catch {
      /* 缓存损坏按空缓存重扫 */
    }
  }

  saveCache() {
    if (!this.cacheFile) return;
    try {
      fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true });
      fs.writeFileSync(this.cacheFile, JSON.stringify({
        version: CACHE_VERSION,
        savedAt: new Date().toISOString(),
        files: [...this.files.entries()].map(([filePath, entry]) => ({
          path: filePath,
          size: entry.size,
          mtimeMs: entry.mtimeMs,
          nativeStamp: entry.nativeStamp,
          project: entry.project,
          cwd: entry.cwd,
          detail: entry.detail
        }))
      }), "utf8");
    } catch {
      /* 写盘失败不影响本次展示 */
    }
  }

  async readJsonlSteps(filePath, size) {
    const steps = new Map();
    const handle = await fsp.open(filePath, "r");
    try {
      let remainder = Buffer.alloc(0);
      let position = 0;
      const feedChunk = text => {
        for (const rawLine of text.split("\n")) {
          const line = rawLine.trim();
          if (line.length < 16) continue;
          let parsed;
          try {
            parsed = JSON.parse(line);
          } catch {
            continue; // 容忍尾部未写完的行
          }
          if (!parsed || typeof parsed !== "object") continue;
          const idx = parsed.step_index;
          if (typeof idx === "number" && Number.isInteger(idx) && idx >= 0) {
            // 同 step_index 后写的完整记录覆盖前一条（如 RUNNING -> DONE）
            steps.set(idx, parsed);
          }
        }
      };

      while (position < size) {
        const length = Math.min(SCAN_CHUNK_BYTES, size - position);
        const chunk = Buffer.allocUnsafe(length);
        const { bytesRead } = await handle.read(chunk, 0, length, position);
        if (!bytesRead) break;
        position += bytesRead;

        const joined = remainder.length
          ? Buffer.concat([remainder, chunk.subarray(0, bytesRead)])
          : chunk.subarray(0, bytesRead);
        const lastBreak = joined.lastIndexOf(0x0a);
        if (lastBreak === -1) {
          remainder = Buffer.from(joined);
          continue;
        }
        feedChunk(joined.subarray(0, lastBreak).toString("utf8"));
        remainder = Buffer.from(joined.subarray(lastBreak + 1));
      }
      if (remainder.length) feedChunk(remainder.toString("utf8"));
    } finally {
      await handle.close();
    }

    return [...steps.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, row]) => row);
  }

  async parseSession(info, summaryMeta, previousDetail) {
    const rows = await this.readJsonlSteps(info.path, info.size);
    const sessionId = info.sessionId;
    const cwd = (summaryMeta && summaryMeta.cwd) || null;
    const project = projectNameOf(cwd) || "Antigravity";

    const detail = {
      file: info.path,
      sessionId,
      cwd,
      project,
      firstAt: null,
      lastAt: null,
      tokens: zeroBucket(),
      models: {},
      modelDays: {},
      days: {},
      hours: {},
      keys: [],
      modelByKey: {},
      timingByKey: {},
      throughput: null
    };

    // Pass 1：按 step_index 升序追踪 Model Selection 切换事件，给每个响应继承当时选中的模型
    let currentModel = null;
    const modelByStep = new Map();
    for (const row of rows) {
      if (row.created_at) {
        const stamp = Date.parse(row.created_at);
        if (Number.isFinite(stamp)) {
          const iso = new Date(stamp).toISOString();
          if (!detail.firstAt || iso < detail.firstAt) detail.firstAt = iso;
          if (!detail.lastAt || iso > detail.lastAt) detail.lastAt = iso;
        }
      }
      if (row.type === "USER_INPUT") {
        const changed = modelFromSettingsChange(row.content);
        if (changed) currentModel = changed;
      } else if (row.type === "PLANNER_RESPONSE" && currentModel && !modelByStep.has(row.step_index)) {
        modelByStep.set(row.step_index, currentModel);
      }
    }

    // 收集需要从伴生 conversations/<id>.db 查询模型与耗时的步骤
    const doneSteps = [];
    for (const row of rows) {
      if (row.type !== "PLANNER_RESPONSE" || row.status !== "DONE") continue;
      const rawInput = nonNegInt(row.input_tokens);
      const output = nonNegInt(row.output_tokens);
      const cacheRead = nonNegInt(row.cache_read_tokens);
      const cacheWrite = nonNegInt(row.cache_write_tokens);
      if (rawInput === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0) continue;
      doneSteps.push(row.step_index);
    }

    const nativeGenerations = doneSteps.length
      ? readGenerationsForTranscript(info.path, doneSteps)
      : new Map();

    // 若原生库暂时不可读，保留上次恢复的模型与计时（对齐 session_usage_agy.rs）
    const prevModelByKey = (previousDetail && previousDetail.modelByKey) || {};
    const prevTimingByKey = (previousDetail && previousDetail.timingByKey) || {};

    const speed = {
      turns: 0,
      outputTokens: 0,
      durationMs: 0,
      ttft: [],
      days: {},
      models: {},
      hours: {},
      dayHours: {},
      modelDays: {}
    };
    const speedCellOf = (target, key) => {
      if (!target[key]) target[key] = { turns: 0, outputTokens: 0, durationMs: 0, ttft: [] };
      return target[key];
    };

    for (const row of rows) {
      if (row.type !== "PLANNER_RESPONSE" || row.status !== "DONE") continue;
      const step = row.step_index;
      const rawInput = nonNegInt(row.input_tokens);
      const output = nonNegInt(row.output_tokens);
      const cacheRead = nonNegInt(row.cache_read_tokens);
      const cacheWrite = nonNegInt(row.cache_write_tokens);
      if (rawInput === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0) continue;

      const key = `agy:${sessionId}:${step}`;
      detail.keys.push(key);

      const nativeGen = nativeGenerations.get(step);
      const nativeModel = nativeGen && nativeGen.model ? nativeGen.model : null;

      // 模型归属优先级（完全对齐 session_usage_agy.rs:299-360）
      const display = knownModel(row)
        || modelByStep.get(step)
        || nativeModel
        || "unknown";
      const usableWorkerModel = nativeModel && !isUnresolvedWorkerTarget(nativeModel) ? nativeModel : null;
      const workerWithoutNative = isOrchestratorWorker(display) && !usableWorkerModel;

      let actual;
      if (isOrchestrator(display)) {
        actual = nativeModel || display;
      } else if (isOrchestratorWorker(display)) {
        actual = usableWorkerModel || "gemini-4-hydrogen";
      } else {
        actual = display;
      }
      let model = modelIdOf(actual);

      if ((model === "unknown" || isOrchestrator(model) || workerWithoutNative) && prevModelByKey[key]) {
        const old = prevModelByKey[key];
        if (old.model && old.model !== "unknown") {
          if (model === "unknown") {
            model = old.model;
          } else if (workerWithoutNative && (
            (isOrchestratorWorker(old.display) && !isUnresolvedWorkerTarget(old.model))
            || (isOrchestrator(old.display) && old.model.startsWith("gemini-4-hydrogen"))
          )) {
            model = old.model;
          } else if (!workerWithoutNative
            && !isOrchestrator(old.model)
            && !isOrchestratorWorker(old.model)
            && orchestratorMode(old.display) === orchestratorMode(display)) {
            model = old.model;
          }
        }
      }
      detail.modelByKey[key] = { model, display };

      // 对齐 TokenBar 统一桶口径：
      // Antigravity 的 rawInput 是 fresh input（不含 cacheRead），
      // 映射到 inputTokens = rawInput + cacheRead 后：
      //   新增输入 = inputTokens - cachedInputTokens = rawInput
      //   缓存命中率 = cachedInputTokens / inputTokens = cacheRead / (rawInput + cacheRead)
      //   总用量 = rawInput + cacheRead + cacheWrite + output
      const inputTokens = rawInput + cacheRead;
      const totalTokens = rawInput + cacheRead + cacheWrite + output;
      const bucket = {
        inputTokens,
        cachedInputTokens: cacheRead,
        cacheWriteTokens: cacheWrite,
        outputTokens: output,
        reasoningOutputTokens: 0,
        totalTokens,
        records: 1
      };

      addBucket(detail.tokens, bucket);

      if (!detail.models[model]) detail.models[model] = zeroBucket();
      addBucket(detail.models[model], bucket);

      const stampMs = row.created_at ? Date.parse(row.created_at) : NaN;
      const date = Number.isFinite(stampMs) ? new Date(stampMs) : null;
      if (date) {
        const day = dayKeyOf(date);
        const hour = date.getHours();
        if (!detail.days[day]) detail.days[day] = zeroBucket();
        addBucket(detail.days[day], bucket);

        if (!detail.modelDays[day]) detail.modelDays[day] = {};
        if (!detail.modelDays[day][model]) detail.modelDays[day][model] = zeroBucket();
        addBucket(detail.modelDays[day][model], bucket);

        const hourKey = `${day}T${pad2(hour)}`;
        detail.hours[hourKey] = (detail.hours[hourKey] || 0) + totalTokens;

        const timing = (nativeGen && nativeGen.timing) || prevTimingByKey[key] || null;
        if (timing && timing.latencyMs > 0) {
          detail.timingByKey[key] = timing;
          if (output > 0) {
            const cells = [
              speed,
              speedCellOf(speed.days, day),
              speedCellOf(speed.models, model),
              speedCellOf(speed.hours, String(hour))
            ];
            if (!speed.dayHours[day]) speed.dayHours[day] = {};
            cells.push(speedCellOf(speed.dayHours[day], String(hour)));
            if (!speed.modelDays[day]) speed.modelDays[day] = {};
            cells.push(speedCellOf(speed.modelDays[day], model));
            for (const cell of cells) {
              cell.turns += 1;
              cell.outputTokens += output;
              cell.durationMs += timing.latencyMs;
              if (timing.firstTokenMs !== null && timing.firstTokenMs !== undefined) {
                cell.ttft.push(timing.firstTokenMs);
              }
            }
          }
        }
      }
    }

    detail.throughput = speed.turns > 0 ? speed : null;
    return detail;
  }

  async build({ onProgress, force = false } = {}) {
    if (this._promise) return this._promise;
    this._promise = (async () => {
      this.phase = "scanning";
      const files = this.listFiles();

      // 为每个出现文件的根目录加载一次 conversation_summaries.db，避免每会话重复开库
      const summariesByRoot = new Map();
      for (const info of files) {
        if (!summariesByRoot.has(info.root)) {
          summariesByRoot.set(info.root, readSummariesIndex(info.root));
        }
      }

      let index = 0;
      let changed = false;

      for (const info of files) {
        index += 1;
        if (onProgress) onProgress({ index, total: files.length, name: path.basename(info.path) });
        const summaryMap = summariesByRoot.get(info.root);
        const summaryMeta = summaryMap ? summaryMap.get(info.sessionId) : null;
        const nativeStamp = nativeStateFingerprint(info.path);
        const expectedCwd = (summaryMeta && summaryMeta.cwd) || null;
        const expectedProject = projectNameOf(expectedCwd) || "Antigravity";
        const existing = this.files.get(info.path);

        if (
          !force
          && existing
          && existing.size === info.size
          && existing.mtimeMs === info.mtimeMs
          && existing.nativeStamp === nativeStamp
          && existing.project === expectedProject
          && existing.detail
        ) {
          continue;
        }

        try {
          const detail = await this.parseSession(info, summaryMeta, existing && existing.detail);
          this.files.set(info.path, {
            size: info.size,
            mtimeMs: info.mtimeMs,
            nativeStamp,
            project: detail.project,
            cwd: detail.cwd,
            detail
          });
          changed = true;
        } catch {
          /* 单文件读取失败继续处理其余会话 */
        }
      }

      for (const key of [...this.files.keys()]) {
        if (!files.some(info => info.path === key)) {
          this.files.delete(key);
          changed = true;
        }
      }

      if (changed || !this.builtAt) this.builtAt = new Date().toISOString();
      if (changed) this.saveCache();
      this.phase = "ready";
      return this.snapshot();
    })();

    try {
      return await this._promise;
    } finally {
      this._promise = null;
    }
  }

  /**
   * 聚合全部会话，输出与 CodexStore.detailSnapshot() / WorkBuddyStore.snapshot() 同构对象。
   */
  snapshot() {
    const sessionsById = new Map();
    const days = new Map();
    const modelDays = {};
    const projectDays = {};
    const projectModelDays = {};
    const dailyHours = {};
    const sum = zeroBucket();
    const seenKeys = new Set();
    const priceTable = this.pricing;
    const speed = {
      turns: 0,
      outputTokens: 0,
      durationMs: 0,
      ttft: [],
      days: {},
      models: {},
      hours: {},
      dayHours: {},
      modelDays: {},
      projectDays: {},
      projects: {}
    };

    for (const entry of this.files.values()) {
      const detail = entry.detail;
      if (!detail) continue;

      const projectKey = detail.project || "Antigravity";
      const duplicate = (detail.keys || []).length > 0 && (detail.keys || []).every(key => seenKeys.has(key));
      for (const key of detail.keys || []) seenKeys.add(key);
      if (duplicate) continue;

      const sessionKey = detail.sessionId || detail.file;
      let session = sessionsById.get(sessionKey);
      if (!session) {
        session = {
          id: sessionKey,
          sessionId: detail.sessionId,
          project: projectKey,
          cwd: detail.cwd,
          firstAt: detail.firstAt,
          lastAt: detail.lastAt,
          ...zeroBucket(),
          models: new Set(),
          modelBuckets: {},
          speedTurns: 0,
          speedOutput: 0,
          speedDuration: 0
        };
        sessionsById.set(sessionKey, session);
      }
      addBucket(session, detail.tokens);
      for (const [model, bucket] of Object.entries(detail.models || {})) {
        if (!session.modelBuckets[model]) session.modelBuckets[model] = zeroBucket();
        addBucket(session.modelBuckets[model], bucket);
        session.models.add(model);
      }
      if (detail.firstAt && (!session.firstAt || detail.firstAt < session.firstAt)) session.firstAt = detail.firstAt;
      if (detail.lastAt && (!session.lastAt || detail.lastAt > session.lastAt)) session.lastAt = detail.lastAt;

      const fileSpeed = detail.throughput;
      if (fileSpeed && fileSpeed.turns) {
        session.speedTurns += fileSpeed.turns;
        session.speedOutput += fileSpeed.outputTokens;
        session.speedDuration += fileSpeed.durationMs;
        speed.turns += fileSpeed.turns;
        speed.outputTokens += fileSpeed.outputTokens;
        speed.durationMs += fileSpeed.durationMs;
        if (Array.isArray(fileSpeed.ttft)) speed.ttft.push(...fileSpeed.ttft);

        const mergeSpeedCell = (target, key, cell) => {
          const dest = target[key] || (target[key] = { turns: 0, outputTokens: 0, durationMs: 0, ttft: [] });
          dest.turns += cell.turns;
          dest.outputTokens += cell.outputTokens;
          dest.durationMs += cell.durationMs;
          if (Array.isArray(cell.ttft)) dest.ttft.push(...cell.ttft);
        };
        for (const [day, cell] of Object.entries(fileSpeed.days || {})) mergeSpeedCell(speed.days, day, cell);
        for (const [model, cell] of Object.entries(fileSpeed.models || {})) mergeSpeedCell(speed.models, model, cell);
        for (const [hour, cell] of Object.entries(fileSpeed.hours || {})) mergeSpeedCell(speed.hours, hour, cell);
        for (const [day, hours] of Object.entries(fileSpeed.dayHours || {})) {
          if (!speed.dayHours[day]) speed.dayHours[day] = {};
          for (const [hour, cell] of Object.entries(hours)) mergeSpeedCell(speed.dayHours[day], hour, cell);
        }
        for (const [day, byModel] of Object.entries(fileSpeed.modelDays || {})) {
          if (!speed.modelDays[day]) speed.modelDays[day] = {};
          for (const [model, cell] of Object.entries(byModel)) mergeSpeedCell(speed.modelDays[day], model, cell);
        }
        for (const [day, cell] of Object.entries(fileSpeed.days || {})) {
          if (!speed.projectDays[day]) speed.projectDays[day] = {};
          mergeSpeedCell(speed.projectDays[day], projectKey, cell);
          mergeSpeedCell(speed.projects, projectKey, cell);
        }
      }

      addBucket(sum, detail.tokens);

      for (const [day, bucket] of Object.entries(detail.days || {})) {
        if (!days.has(day)) days.set(day, { day, ...zeroBucket() });
        addBucket(days.get(day), bucket);

        if (!modelDays[day]) modelDays[day] = {};
        if (!projectModelDays[day]) projectModelDays[day] = {};
        if (!projectModelDays[day][projectKey]) projectModelDays[day][projectKey] = {};
        for (const [model, cell] of Object.entries(detail.modelDays[day] || {})) {
          if (!modelDays[day][model]) modelDays[day][model] = zeroBucket();
          addBucket(modelDays[day][model], cell);
          if (!projectModelDays[day][projectKey][model]) projectModelDays[day][projectKey][model] = zeroBucket();
          addBucket(projectModelDays[day][projectKey][model], cell);
        }

        if (!projectDays[day]) projectDays[day] = {};
        if (!projectDays[day][projectKey]) projectDays[day][projectKey] = zeroBucket();
        addBucket(projectDays[day][projectKey], bucket);

        if (!dailyHours[day]) dailyHours[day] = new Array(24).fill(0);
        for (const [hourKey, tokens] of Object.entries(detail.hours || {})) {
          const [dayPart, hourPart] = hourKey.split("T");
          if (dayPart !== day) continue;
          dailyHours[day][Number(hourPart)] += tokens;
        }
      }
    }

    const merged = zeroBucket();
    for (const bucket of days.values()) addBucket(merged, bucket);

    const hourly = new Array(24).fill(0);
    for (const row of Object.values(dailyHours)) {
      for (let hour = 0; hour < 24; hour += 1) hourly[hour] += row[hour] || 0;
    }

    const series = [...days.values()]
      .map(item => ({ ...item }))
      .sort((a, b) => a.day.localeCompare(b.day));

    for (const item of series) {
      item.cost = costOfModels(modelDays[item.day] || {}, priceTable).cny;
    }

    const modelTotals = {};
    for (const byModel of Object.values(modelDays)) {
      for (const [model, bucket] of Object.entries(byModel)) {
        if (!modelTotals[model]) modelTotals[model] = { model, ...zeroBucket() };
        addBucket(modelTotals[model], bucket);
      }
    }
    const modelCost = costOfModels(modelTotals, priceTable);
    const models = Object.values(modelTotals)
      .map(item => {
        const cell = modelCost.perModel[item.model] || {};
        const sc = speed.models[item.model] || {};
        return {
          ...item,
          share: merged.totalTokens ? item.totalTokens / merged.totalTokens : 0,
          cost: cell.unit ? cell.cny : null,
          unit: cell.unit || null,
          estimated: Boolean(cell.estimated),
          turns: sc.turns || 0,
          tps: sc.durationMs > 0 ? (sc.outputTokens || 0) * 1000 / sc.durationMs : null
        };
      })
      .sort((a, b) => b.totalTokens - a.totalTokens);

    const projectTotals = {};
    for (const byProject of Object.values(projectDays)) {
      for (const [project, bucket] of Object.entries(byProject)) {
        if (!projectTotals[project]) projectTotals[project] = { project, ...zeroBucket(), sessions: 0 };
        addBucket(projectTotals[project], bucket);
      }
    }
    const projects = Object.values(projectTotals)
      .map(item => ({ ...item, share: merged.totalTokens ? item.totalTokens / merged.totalTokens : 0 }))
      .sort((a, b) => b.totalTokens - a.totalTokens);

    const todayKey = dayKeyOf(new Date());
    const sessionList = [...sessionsById.values()]
      .filter(item => item.records > 0 && item.totalTokens > 0)
      .map(item => {
        const { models: modelSet, modelBuckets, speedTurns, speedOutput, speedDuration, ...rest } = item;
        const buckets = modelBuckets || {};
        const sCost = costOfModels(buckets, priceTable);
        const modelDetails = Object.entries(buckets)
          .map(([model, bucket]) => ({
            model,
            inputTokens: bucket.inputTokens || 0,
            cachedInputTokens: bucket.cachedInputTokens || 0,
            cacheWriteTokens: bucket.cacheWriteTokens || 0,
            outputTokens: bucket.outputTokens || 0,
            totalTokens: bucket.totalTokens || 0,
            records: bucket.records || 0,
            cost: (sCost.perModel[model] || {}).cny || 0,
            estimated: Boolean((sCost.perModel[model] || {}).estimated)
          }))
          .sort((a, b) => b.totalTokens - a.totalTokens);
        return {
          ...rest,
          models: modelDetails.map(entry => entry.model),
          modelDetails,
          cost: sCost.cny,
          turns: speedTurns || 0,
          tps: speedDuration > 0 ? (speedOutput || 0) * 1000 / speedDuration : null
        };
      })
      .sort((a, b) => String(b.lastAt || "").localeCompare(String(a.lastAt || "")));

    const median = list => {
      if (!list || !list.length) return null;
      const sorted = [...list].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    };

    const speedCell = cell => ({
      turns: cell.turns,
      outputTokens: cell.outputTokens,
      durationMs: cell.durationMs,
      tps: cell.durationMs > 0 ? cell.outputTokens * 1000 / cell.durationMs : null,
      ttftMs: median(cell.ttft || [])
    });

    const throughput = speed.durationMs > 0
      ? {
        turns: speed.turns,
        outputTokens: speed.outputTokens,
        durationMs: speed.durationMs,
        tps: speed.outputTokens * 1000 / speed.durationMs,
        ttftMs: median(speed.ttft),
        days: Object.fromEntries(Object.entries(speed.days).map(([day, cell]) => [day, speedCell(cell)])),
        models: Object.entries(speed.models)
          .map(([model, cell]) => ({ model, ...speedCell(cell) }))
          .sort((a, b) => b.turns - a.turns),
        hours: Array.from({ length: 24 }, (_, hour) => {
          const cell = speed.hours[String(hour)];
          return cell ? speedCell(cell) : { turns: 0, outputTokens: 0, durationMs: 0, tps: null, ttftMs: null };
        }),
        dayHours: Object.fromEntries(Object.entries(speed.dayHours).map(([day, byHour]) => [
          day,
          Array.from({ length: 24 }, (_, hour) => {
            const cell = byHour[String(hour)];
            return cell ? speedCell(cell) : null;
          })
        ])),
        modelDays: Object.fromEntries(Object.entries(speed.modelDays).map(([day, byModel]) => [
          day,
          Object.fromEntries(Object.entries(byModel).map(([model, cell]) => [model, speedCell(cell)]))
        ])),
        projects: Object.entries(speed.projects)
          .map(([project, cell]) => ({ project, ...speedCell(cell) }))
          .sort((a, b) => b.turns - a.turns),
        projectDays: Object.fromEntries(Object.entries(speed.projectDays).map(([day, byProject]) => [
          day,
          Object.fromEntries(Object.entries(byProject).map(([project, cell]) => [project, speedCell(cell)]))
        ]))
      }
      : null;

    return {
      ok: true,
      source: "antigravity",
      builtAt: this.builtAt,
      sessions: sessionList.length,
      scannedFiles: this.files.size,
      roots: this.rootsInfo,
      baseline: null,
      throughput,
      totals: { ...merged, sessions: sessionList.length, cost: modelCost.cny },
      cost: {
        cny: modelCost.cny,
        usd: modelCost.cny / priceTable.usdCny,
        todayCny: (series.find(item => item.day === todayKey) || {}).cost || 0,
        estimatedTokens: modelCost.estimatedTokens,
        rate: priceTable.usdCny,
        updatedAt: priceTable.updatedAt,
        note: priceTable.note,
        sources: priceTable.sources
      },
      pricing: describeTable(priceTable, models.map(item => item.model)),
      series,
      models,
      projects,
      modelDays,
      projectDays,
      projectModelDays,
      hourly,
      dailyHours,
      sessionList,
      today: series.find(item => item.day === todayKey) || null
    };
  }

  summary() {
    const snap = this.snapshot();
    return {
      ok: snap.ok,
      sessions: snap.sessions,
      days: snap.series.length,
      today: snap.today ? {
        day: snap.today.day,
        totalTokens: snap.today.totalTokens,
        records: snap.today.records,
        outputTokens: snap.today.outputTokens,
        cachedInputTokens: snap.today.cachedInputTokens,
        inputTokens: snap.today.inputTokens
      } : null,
      totals: {
        totalTokens: snap.totals.totalTokens,
        records: snap.totals.records,
        inputTokens: snap.totals.inputTokens,
        cachedInputTokens: snap.totals.cachedInputTokens,
        outputTokens: snap.totals.outputTokens,
        cost: snap.totals.cost
      },
      roots: snap.roots,
      cost: snap.cost ? { cny: snap.cost.cny, usd: snap.cost.usd, todayCny: snap.cost.todayCny } : null
    };
  }
}

module.exports = { AntigravityStore, CACHE_VERSION, defaultAntigravityRoots };
