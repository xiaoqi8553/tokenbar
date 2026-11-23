"use strict";

/**
 * codex-auth-store.cjs — 复用本机 Codex 授权，向官方用量接口取「实时额度」
 *
 * 为什么需要它：TokenBar 过去的 5 小时 / 7 天额度是从本地 rollout 日志里的
 * token_count 事件读的快照。Codex CLI 只在会话里周期性写一次，且新版本常把
 * rate_limits 写成 null，于是额度会停在几小时前，甚至整个消失。CC Switch /
 * codex-auth 的做法是拿 auth.json 里的 access_token 直接问官方接口：
 *
 *   GET https://chatgpt.com/backend-api/wham/usage
 *   Authorization: Bearer <access_token>
 *   ChatGPT-Account-Id: <tokens.account_id>
 *   User-Agent: codex_cli_rs/0.1.0
 *
 * 返回体与 rollout 里 payload.rate_limits 同形（primary / secondary / credits /
 * plan_type），因此可直接复用 codex-store 的 normalizeRateLimits 口径。
 *
 * 设计要点：
 *  - 两种取得授权的方式：
 *    1) 复用本机已有 auth.json（~/.codex/auth.json 与 ~/.codex/XQ_acc 下各账号目录）；
 *    2) OAuth Device Code 授权：和 CC Switch / Codex CLI 同款流程——给用户一个一次性
 *       配对码和官方验证网址，在浏览器里授权后，token 只落到本机，不经过本应用服务器。
 *       端点（从 CC Switch 安装包与 openai/codex 源码核对，2026-11 实测）：
 *         POST https://auth.openai.com/api/accounts/deviceauth/usercode   {client_id}
 *         POST https://auth.openai.com/api/accounts/deviceauth/token      {device_auth_id,user_code} 轮询
 *         POST https://auth.openai.com/oauth/token   form: grant_type=authorization_code + PKCE
 *  - token 永不出进程：list()/status() 只回脱敏邮箱、有效期、额度，不回 token。
 *  - access_token 过期时用 refresh_token 走官方 oauth/token 换新，并把新 token
 *    原子写回原 auth.json（Codex CLI、CC Switch 下次启动即可复用）。
 *  - fetch / fs / 目录都可通过 options 注入，方便在纯 Node 测试里替换。
 */

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const USERCODE_URL = "https://auth.openai.com/api/accounts/deviceauth/usercode";
const DEVICE_TOKEN_URL = "https://auth.openai.com/api/accounts/deviceauth/token";
const VERIFY_URL = "https://auth.openai.com/codex/device";
const DEVICE_REDIRECT_URI = "https://auth.openai.com/deviceauth/callback";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"; // 从本机 id_token.aud 确认（与 Codex CLI 一致）
const UA = "codex_cli_rs/0.1.0";
const DEVICE_POLL_MAX_MS = 15 * 60 * 1000; // 官方配对码 15 分钟有效
const TOKEN_EXPIRY_SKEW_MS = 60_000; // 提前 1 分钟视为过期

/**
 * 默认 HTTP 传输用 curl，而不是 Node 的 fetch：
 *  - Node fetch（undici）不读 http_proxy/https_proxy，国内直连 chatgpt.com 通常不通；
 *  - curl 会读代理环境变量；Windows 系统代理（IE/WinINET 设置）curl 默认不读，
 *    这里显式从注册表取出来传给 -x，和 CC Switch / codex-auth 的行为一致。
 * 返回一个类似 Response 的最小对象，供上层 .ok/.status/.json() 使用。
 */
let cachedWindowsProxy;
function windowsSystemProxy() {
  if (cachedWindowsProxy !== undefined) return cachedWindowsProxy;
  cachedWindowsProxy = null;
  if (process.platform !== "win32") return null;
  try {
    const { execFileSync } = require("node:child_process");
    const out = execFileSync("reg", ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings", "/v", "ProxyEnable"],
      { encoding: "utf8", windowsHide: true, timeout: 3000 });
    if (!/ProxyEnable\s+REG_DWORD\s+0x1/.test(out)) return null;
    const srv = execFileSync("reg", ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings", "/v", "ProxyServer"],
      { encoding: "utf8", windowsHide: true, timeout: 3000 });
    const m = srv.match(/ProxyServer\s+REG_SZ\s+(\S+)/);
    if (m && m[1]) cachedWindowsProxy = "http://" + m[1];
  } catch {
    /* 读不到就返回 null，交给 curl 自己的环境变量逻辑 */
  }
  return cachedWindowsProxy;
}

function curlRequest(url, opts) {
  const { spawn } = require("node:child_process");
  // 凭证（Authorization / body）一律通过 --config - 从 stdin 传给 curl，
  // 绝不进 argv：否则 exec 报错会把整条命令（含 access_token）打进日志。
  const args = ["-sS", "-m", "20", "--retry", "3", "--retry-all-errors", "-w", "\n%{http_code}", "--config", "-"];
  const configLines = [];
  for (const [name, value] of Object.entries(opts.headers || {})) {
    configLines.push('header = "' + String(name + ": " + value).replace(/(["\\])/g, "\\$1") + '"');
  }
  if (opts.method && opts.method !== "GET") configLines.push('request = "' + opts.method + '"');
  if (opts.body) configLines.push('data-raw = "' + String(opts.body).replace(/(["\\])/g, "\\$1") + '"');
  configLines.push('url = "' + String(url).replace(/(["\\])/g, "\\$1") + '"');
  // 环境变量里有代理就交给 curl 自己处理；没有再用 Windows 系统代理
  const hasEnvProxy = Boolean(process.env.HTTPS_PROXY || process.env.https_proxy
    || process.env.HTTP_PROXY || process.env.http_proxy);
  if (!hasEnvProxy) {
    const sysProxy = windowsSystemProxy();
    if (sysProxy) configLines.push('proxy = "' + sysProxy.replace(/(["\\])/g, "\\$1") + '"');
  }

  return new Promise((resolve, reject) => {
    const child = spawn("curl", args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", () => reject(new Error("无法启动 curl，请确认系统 PATH 中有 curl")));
    child.on("close", code => {
      if (code !== 0) {
        // 只回退出码，不回命令行（命令行里没有 token，但 stderr 也可能带 URL，统一不回）
        return reject(new Error("用量请求失败（curl 退出码 " + code + "）：" + stderr.slice(0, 160)));
      }
      const text = String(stdout || "");
      const cut = text.lastIndexOf("\n");
      const body = cut >= 0 ? text.slice(0, cut) : "";
      const status = Number(cut >= 0 ? text.slice(cut + 1).trim() : 0) || 0;
      resolve({
        ok: status >= 200 && status < 300,
        status,
        json: async () => JSON.parse(body),
        text: async () => body
      });
    });
    // stdin 写完即关闭，curl 读完 config 才会真正发请求
    child.stdin.on("error", () => {});
    child.stdin.end(configLines.join("\n") + "\n");
  });
}

function nowIso() { return new Date().toISOString(); }

/** 生成随机 session id（只用来在主进程内索引一次授权会话，不是凭证） */
function newSessionId() {
  try {
    const crypto = require("node:crypto");
    return crypto.randomUUID();
  } catch {
    return "dev-" + Date.now() + "-" + Math.random().toString(36).slice(2);
  }
}

/** 目录名安全化：邮箱里的 @ / . / + 等不能出现在文件夹名里 */
function safeFolderName(value) {
  const s = String(value || "").trim().replace(/[^\w.@-]+/g, "_").replace(/^\.+|\.+$/g, "");
  return s || "oauth-account";
}

/** 邮箱脱敏：保留前两位，其余星号（例 alice@example.com → al***@example.com） */
function maskEmail(email) {
  const s = String(email || "");
  const at = s.indexOf("@");
  if (at <= 0) return s ? s.slice(0, 2) + "***" : "***";
  const head = s.slice(0, at);
  return (head.length > 2 ? head.slice(0, 2) : head) + "***" + s.slice(at);
}

/** 从 JWT 里取声明，失败返回 null（只是展示用，不做校验） */
function jwtClaim(token, name) {
  try {
    const part = String(token).split(".")[1];
    const payload = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return payload && payload[name] != null ? payload[name] : null;
  } catch {
    return null;
  }
}

/** 从 auth.json 里推断邮箱：id_token.email → 目录名 → null */
function emailOf(auth, folderName) {
  const fromJwt = jwtClaim(auth && auth.tokens && auth.tokens.id_token, "email");
  if (fromJwt) return String(fromJwt);
  const name = String(folderName || "");
  return name.includes("@") ? name : null;
}

/** access_token 是否过期（解析 exp，读不到就当过期，触发刷新） */
function isTokenExpired(auth, nowMs = Date.now()) {
  const exp = jwtClaim(auth && auth.tokens && auth.tokens.access_token, "exp");
  if (!Number.isFinite(Number(exp))) return true;
  return Number(exp) * 1000 - TOKEN_EXPIRY_SKEW_MS <= nowMs;
}

/**
 * 与 codex-store.normalizeRateLimits 同口径，兼容两种数据源：
 *  - 本地 rollout 的 rate_limits：primary / secondary.window_minutes / resets_at
 *  - 官方 wham/usage（2026-11 实测）：rate_limit.primary_window / secondary_window，
 *    用 limit_window_seconds 与 reset_at，外层还带 plan_type / credits / email
 */
function normalizeQuota(raw, sampledAt) {
  if (!raw || typeof raw !== "object") return null;
  const pick = window => {
    if (!window || typeof window !== "object") return null;
    const used = Number(window.used_percent);
    if (!Number.isFinite(used)) return null;
    const minutes = window.window_minutes != null
      ? Number(window.window_minutes)
      : (window.limit_window_seconds != null ? Number(window.limit_window_seconds) / 60 : NaN);
    return {
      usedPercent: Math.max(0, Math.min(100, used)),
      remainingPercent: Math.max(0, Math.min(100, 100 - used)),
      windowMinutes: Number.isFinite(minutes) ? minutes : null,
      // 本地 rollout 用 resets_at，官方 wham/usage 用 reset_at（单数）
      resetsAt: Number(window.resets_at) || Number(window.reset_at) || null
    };
  };
  const rl = raw.rate_limit && typeof raw.rate_limit === "object" ? raw.rate_limit : null;
  const session = pick(rl ? rl.primary_window : raw.primary);
  const weekly = pick(rl ? rl.secondary_window : raw.secondary);
  if (!session && !weekly) return null;
  const credits = raw.credits && typeof raw.credits === "object"
    ? {
      hasCredits: Boolean(raw.credits.has_credits),
      unlimited: Boolean(raw.credits.unlimited),
      balance: raw.credits.balance != null ? String(raw.credits.balance) : null
    }
    : null;
  return {
    session,
    weekly,
    credits,
    planType: raw.plan_type || null,
    email: raw.email ? maskEmail(raw.email) : null,
    limitReached: Boolean(raw.rate_limit_reached_type
      || (rl && (rl.limit_reached || rl.allowed === false))),
    sampledAt: sampledAt || nowIso()
  };
}

/**
 * 把 wham/usage 的响应整理成 normalizeQuota 能吃的形状。
 * 实测响应本身就是顶层带 rate_limit / plan_type / credits 的对象，
 * 它同时满足 normalizeQuota 的「直接」分支（里面有 rate_limit 键）。
 */
function extractRateLimits(json) {
  if (!json || typeof json !== "object") return null;
  if (json.rate_limit || json.primary || json.secondary || json.plan_type) return json;
  if (json.rate_limits && typeof json.rate_limits === "object") return json.rate_limits;
  if (json.data && typeof json.data === "object") {
    if (json.data.rate_limit || json.data.primary || json.data.secondary) return json.data;
    if (json.data.rate_limits && typeof json.data.rate_limits === "object") return json.data.rate_limits;
  }
  return null;
}

function createCodexAuthStore(options = {}) {
  const fs = options.fs || require("node:fs");
  const path = options.path || require("node:path");
  const fetchFn = options.fetch || curlRequest;
  const codexHome = options.codexHome
    || process.env.CODEX_HOME
    || path.join(require("node:os").homedir(), ".codex");
  const activeAuthFile = path.join(codexHome, "auth.json");
  const accountsDir = path.join(codexHome, "XQ_acc");

  /** 缓存：key = auth 文件绝对路径 */
  const cache = new Map();
  /** 进行中的设备码授权会话：key = sessionId，含 device_auth_id 等敏感值，绝不过桥 */
  const deviceSessions = new Map();

  function readJson(file) {
    try {
      const value = JSON.parse(fs.readFileSync(file, "utf8"));
      return value && typeof value === "object" ? value : null;
    } catch {
      return null;
    }
  }

  function writeJson(file, value) {
    const tmp = file + ".tmp-tokenbar";
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
    fs.renameSync(tmp, file);
  }

  /** 找出所有可用的 auth.json：当前激活的排第一，其余按目录名 */
  function discover() {
    const found = [];
    const seen = new Set();
    const push = (file, isActive, folderName) => {
      const resolved = path.resolve(file);
      if (seen.has(resolved)) return;
      const auth = readJson(resolved);
      if (!auth || !auth.tokens || !auth.tokens.access_token) return;
      if (auth.auth_mode && String(auth.auth_mode).toLowerCase() === "apikey") return;
      seen.add(resolved);
      found.push({
        id: resolved,
        file: resolved,
        isActive,
        folderName: folderName || path.basename(path.dirname(resolved)),
        email: emailOf(auth, folderName),
        accountId: auth.tokens.account_id ? String(auth.tokens.account_id) : null
      });
    };
    push(activeAuthFile, true, "当前账号");
    let dirs = [];
    try { dirs = fs.readdirSync(accountsDir, { withFileTypes: true }); } catch { /* 无多账号目录 */ }
    for (const entry of dirs) {
      if (!entry.isDirectory()) continue;
      push(path.join(accountsDir, entry.name, "auth.json"), false, entry.name);
    }
    return found;
  }

  /** 对外可见的账号列表：只有脱敏信息 + 已缓存额度的概要，绝不含 token */
  function list() {
    const accounts = discover().map(account => {
      const cached = cache.get(account.file);
      return {
        id: account.id,
        email: account.email ? maskEmail(account.email) : account.folderName,
        isActive: account.isActive,
        hasRefreshToken: Boolean(readJson(account.file)?.tokens?.refresh_token),
        quota: cached && cached.quota ? cached.quota : null,
        fetchedAt: cached ? cached.fetchedAt : null,
        error: cached ? cached.error : null
      };
    });
    return {
      codexHome,
      accounts,
      activeId: accounts.find(item => item.isActive)?.id || null
    };
  }

  /** 用 refresh_token 换新 access_token，并把新 token 写回 auth.json */
  async function refreshToken(auth, fetchOverride) {
    const refresh = auth.tokens && auth.tokens.refresh_token;
    if (!refresh) throw new Error("缺少 refresh_token，请在 CC Switch / Codex CLI 重新登录");
    const doFetch = fetchOverride || fetchFn;
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refresh,
      client_id: CLIENT_ID,
      scope: "openid profile email offline_access"
    });
    const response = await doFetch(TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": UA
      },
      body: body.toString(),
      signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) throw new Error(`令牌刷新失败 HTTP ${response.status}`);
    const json = await response.json();
    if (!json.access_token) throw new Error("令牌刷新响应缺少 access_token");
    return {
      access_token: json.access_token,
      refresh_token: json.refresh_token || refresh,
      id_token: json.id_token || auth.tokens.id_token,
      account_id: auth.tokens.account_id || null
    };
  }

  /**
   * 拉取单个账号的实时额度。
   * @param {string} accountId discover()/list() 里的 id（auth 文件绝对路径）
   * @param {{force?:boolean, fetch?:Function}} opts
   */
  async function fetchQuota(accountId, opts = {}) {
    const account = discover().find(item => item.id === accountId);
    if (!account) throw new Error("账号不存在（可能已被移除）");
    const auth = readJson(account.file);
    if (!auth || !auth.tokens) throw new Error("授权文件读取失败");

    let tokens = auth.tokens;
    if (isTokenExpired(auth) && !opts.skipRefresh) {
      try {
        tokens = await refreshToken(auth, opts.fetch);
        auth.tokens = tokens;
        writeJson(account.file, auth);
      } catch (error) {
        cache.set(account.file, {
          quota: null,
          fetchedAt: nowIso(),
          error: `令牌刷新失败：${error.message}`
        });
        throw error;
      }
    }

    const doFetch = opts.fetch || fetchFn;
    const headers = {
      Authorization: "Bearer " + tokens.access_token,
      "User-Agent": UA,
      Accept: "application/json"
    };
    if (tokens.account_id) headers["ChatGPT-Account-Id"] = String(tokens.account_id);

    const response = await doFetch(USAGE_URL, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) throw new Error(`用量接口返回 HTTP ${response.status}`);
    const json = await response.json();
    const raw = extractRateLimits(json);
    const quota = normalizeQuota(raw, nowIso());
    if (!quota) throw new Error("用量接口未返回可用额度数据");

    const entry = {
      quota,
      fetchedAt: nowIso(),
      error: null,
      planType: quota.planType
    };
    cache.set(account.file, entry);
    return publicEntry(account, entry);
  }

  /** 只返回可安全过桥到渲染进程的字段 */
  function publicEntry(account, entry) {
    return {
      id: account.id,
      email: account.email ? maskEmail(account.email) : account.folderName,
      isActive: account.isActive,
      quota: entry.quota,
      fetchedAt: entry.fetchedAt,
      error: entry.error || null
    };
  }

  /** 取当前激活账号的实时额度（供托盘/看板自动使用） */
  async function activeQuota(opts = {}) {
    const accounts = discover();
    const active = accounts.find(item => item.isActive) || accounts[0];
    if (!active) return null;
    const cached = cache.get(active.file);
    // 30 秒内不重复请求，避免 30 秒轮询打爆官方接口
    if (!opts.force && cached && cached.quota && cached.fetchedAt) {
      const age = Date.now() - Date.parse(cached.fetchedAt);
      if (Number.isFinite(age) && age < 30_000) return publicEntry(active, cached);
    }
    return fetchQuota(active.id, opts);
  }

  /** 让调用方把缓存的额度覆盖进 status.quota（主进程内用，不暴露 token） */
  function cachedQuotaFor(accountId) {
    const account = discover().find(item => item.id === accountId);
    if (!account) return null;
    const cached = cache.get(account.file);
    return cached && cached.quota ? cached.quota : null;
  }

  // ------------------------------------------------------------------
  // OAuth Device Code 授权（与 CC Switch / Codex CLI 同款，只落本机）
  // ------------------------------------------------------------------

  /**
   * 第一步：向官方申请一个一次性配对码。返回的 user_code 与验证网址给用户在浏览器里授权；
   * device_auth_id 只留在主进程的 deviceSessions 里，绝不过桥到渲染进程。
   */
  async function startDeviceAuth(opts = {}) {
    const doFetch = opts.fetch || fetchFn;
    const response = await doFetch(USERCODE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": UA },
      body: JSON.stringify({ client_id: CLIENT_ID }),
      signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) throw new Error(`申请配对码失败 HTTP ${response.status}`);
    const json = await response.json();
    if (!json.device_auth_id || !json.user_code) throw new Error("配对码响应缺少 device_auth_id / user_code");

    const id = newSessionId();
    const intervalSec = Math.max(1, Number(json.interval) || 5);
    const expiresAtMs = json.expires_at
      ? (Date.parse(json.expires_at) || Date.now() + DEVICE_POLL_MAX_MS)
      : Date.now() + DEVICE_POLL_MAX_MS;
    deviceSessions.set(id, {
      deviceAuthId: String(json.device_auth_id),
      userCode: String(json.user_code),
      intervalSec,
      expiresAtMs,
      startedAt: Date.now(),
      pkce: null
    });
    // 只回可展示的字段：配对码本身不是密钥，device_auth_id 永远不出去
    return {
      sessionId: id,
      userCode: String(json.user_code),
      verifyUrl: VERIFY_URL,
      intervalSec,
      expiresAt: new Date(expiresAtMs).toISOString()
    };
  }

  /** 查会话状态（渲染进程刷新/重开弹窗时用），只回可展示字段 */
  function deviceStatus(sessionId) {
    const s = deviceSessions.get(sessionId);
    if (!s) return null;
    return {
      sessionId,
      userCode: s.userCode,
      verifyUrl: VERIFY_URL,
      expiresAt: new Date(s.expiresAtMs).toISOString(),
      expired: Date.now() >= s.expiresAtMs
    };
  }

  /**
   * 第二步：轮询用户是否已在浏览器完成授权。
   * 403/404 = 用户还没点授权（pending）；200 = 拿到 authorization_code + PKCE。
   * 成功后立刻换 token、写成本机 auth.json，并清掉会话。
   */
  async function pollDeviceAuth(sessionId, opts = {}) {
    const session = deviceSessions.get(sessionId);
    if (!session) throw new Error("授权会话不存在或已结束");
    if (Date.now() >= session.expiresAtMs) {
      deviceSessions.delete(sessionId);
      return { status: "expired" };
    }
    const doFetch = opts.fetch || fetchFn;
    const response = await doFetch(DEVICE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": UA },
      body: JSON.stringify({ device_auth_id: session.deviceAuthId, user_code: session.userCode }),
      signal: AbortSignal.timeout(15000)
    });
    if (response.status === 403 || response.status === 404) return { status: "pending" };
    if (!response.ok) throw new Error(`查询授权结果失败 HTTP ${response.status}`);

    const grant = await response.json();
    if (!grant.authorization_code) throw new Error("授权响应缺少 authorization_code");

    // 第三步：authorization_code + PKCE 换 access/refresh/id token（form 编码）
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code: String(grant.authorization_code),
      redirect_uri: String(grant.redirect_uri || DEVICE_REDIRECT_URI),
      scope: "openid profile email offline_access"
    });
    if (grant.code_verifier) form.set("code_verifier", String(grant.code_verifier));
    if (grant.code_challenge) form.set("code_challenge", String(grant.code_challenge));

    const tokenResponse = await doFetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA },
      body: form.toString(),
      signal: AbortSignal.timeout(15000)
    });
    if (!tokenResponse.ok) throw new Error(`换取令牌失败 HTTP ${tokenResponse.status}`);
    const tokens = await tokenResponse.json();
    if (!tokens.access_token || !tokens.refresh_token || !tokens.id_token) {
      throw new Error("令牌响应缺少 access_token / refresh_token / id_token");
    }

    // 从 id_token 里取邮箱与 account_id，用于命名账号文件与查额度
    const email = jwtClaim(tokens.id_token, "email")
      || jwtClaim(tokens.id_token, "preferred_username") || null;
    const accountId = jwtClaim(tokens.id_token, "chatgpt_account_id")
      || jwtClaim(tokens.id_token, "account_id") || null;

    // 落盘：和 Codex 的 auth.json 完全同构，写进 XQ_acc/<email>/auth.json，
    // 不动当前激活的 auth.json（避免把用户正在用的登录挤掉）
    const folder = safeFolderName(email || ("oauth-" + Date.now()));
    const targetDir = path.join(accountsDir, folder);
    fs.mkdirSync(targetDir, { recursive: true });
    const authFile = path.join(targetDir, "auth.json");
    const authDoc = {
      auth_mode: "chatgpt",
      last_refresh: nowIso(),
      tokens: {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        id_token: tokens.id_token,
        account_id: accountId
      }
    };
    writeJson(authFile, authDoc);
    deviceSessions.delete(sessionId);

    // 立刻查一次额度，让 UI 一次拿到完整结果（失败也不影响授权本身）
    let quota = null;
    let quotaError = null;
    try {
      const result = await fetchQuota(path.resolve(authFile), { ...opts, skipRefresh: true });
      quota = result.quota;
    } catch (error) {
      quotaError = error.message;
    }
    return {
      status: "success",
      email: email ? maskEmail(email) : folder,
      accountId: accountId,
      quota,
      quotaError
    };
  }

  function cancelDeviceAuth(sessionId) {
    return deviceSessions.delete(sessionId);
  }

  return {
    discover,
    list,
    fetchQuota,
    activeQuota,
    cachedQuotaFor,
    startDeviceAuth,
    pollDeviceAuth,
    deviceStatus,
    cancelDeviceAuth,
    normalizeQuota,
    isTokenExpired,
    jwtClaim,
    _paths: { codexHome, activeAuthFile, accountsDir }
  };
}

module.exports = {
  createCodexAuthStore,
  maskEmail,
  normalizeQuota,
  extractRateLimits,
  isTokenExpired,
  jwtClaim
};
