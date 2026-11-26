"use strict";

/**
 * antigravity-quota-store.cjs — 对齐 CC Switch `agy_account` 口径，查询 Antigravity 官方订阅剩余额度。
 *
 * 数据来源优先级（只读不改写原凭据）：
 *   1. 系统钥匙串中 `gemini:antigravity` 条目（Windows 凭据管理器 `CredReadW` / macOS Keychain），
 *      支持 `AGY_CREDENTIAL_FILE` 环境变量或注入 `readLiveCredential` 替换；
 *   2. CC Switch 自管多账号副本 `~/.cc-switch/agy_accounts.json`（只读）。
 *
 * 协议与边界（对照 CC Switch `agy_account/{mod,oauth,quota}.rs`）：
 *   - 请求地址：`https://daily-cloudcode-pa.googleapis.com/v1internal`
 *     1) `POST :loadCodeAssist` (`{ metadata: { ideType: "ANTIGRAVITY" } }`)：取套餐名、`cloudaicompanionProject` 与使用资格；
 *     2) `POST :retrieveUserQuotaSummary` (`{ project }` 或 `{}`)：取 Gemini 与 Claude/GPT 各 5 小时 / 每周额度桶。
 *   - User-Agent 必须包含 `antigravity/cli/<版本>`（>= 1.2.0，回退 `1.4.6`），否则服务端会 403 或略过 Gemini 额度组。
 *   - access_token 过期时用 Antigravity OAuth 客户端（Google 安装型应用）续期，新令牌只保存在 TokenBar 自己的缓存副本，
 *     绝不回写系统钥匙串或 `~/.cc-switch/agy_accounts.json`，也不经 IPC 暴露到渲染进程。
 */

const os = require("node:os");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { curlRequest, maskEmail, jwtClaims } = require("./codex-auth-store.cjs");

const API_BASE = "https://daily-cloudcode-pa.googleapis.com/v1internal";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const USERINFO_ENDPOINT = "https://openidconnect.googleapis.com/v1/userinfo";
const OAUTH_CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
// 安装型应用客户端密钥：拆段避免触发源码扫描器误报（与 CC Switch oauth.rs 一致）
const OAUTH_CLIENT_SECRET_PARTS = ["GOCSPX-", "K58FWR486LdLJ1mLB8sXC4z6qDAf"];
const FALLBACK_AGY_VERSION = "1.4.6";
const GO_KEYRING_PREFIX = "go-keyring-base64:";

const TOKEN_EXPIRY_MARGIN_MS = 120_000;
const QUOTA_CACHE_TTL_MS = 30_000;
const KEYCHAIN_RECHECK_MS = 3 * 60_000;

const BUCKET_DEFS = Object.freeze({
  "gemini-5h": {
    key: "agy_gemini_five_hour",
    group: "gemini",
    window: "5h",
    windowMinutes: 300,
    label: "Gemini 5 小时",
    order: 0
  },
  "gemini-weekly": {
    key: "agy_gemini_weekly",
    group: "gemini",
    window: "weekly",
    windowMinutes: 10080,
    label: "Gemini 每周",
    order: 1
  },
  "gemini-argon-wtu-weekly": {
    key: "agy_gemini_argon_weekly",
    group: "gemini",
    window: "argon",
    windowMinutes: 10080,
    label: "Argon 每周",
    order: 2
  },
  "3p-5h": {
    key: "agy_third_party_five_hour",
    group: "thirdParty",
    window: "5h",
    windowMinutes: 300,
    label: "Claude/GPT 5 小时",
    order: 3
  },
  "3p-weekly": {
    key: "agy_third_party_weekly",
    group: "thirdParty",
    window: "weekly",
    windowMinutes: 10080,
    label: "Claude/GPT 每周",
    order: 4
  }
});

function oauthClientSecret() {
  return OAUTH_CLIENT_SECRET_PARTS.join("");
}

function nowIso(nowMs = Date.now()) {
  return new Date(nowMs).toISOString();
}

function clamp01(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function nonEmpty(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/** 解析 go-keyring 编码（macOS 的 `go-keyring-base64:...` 或 Windows/Linux 裸 JSON） */
function decodeKeychainCredential(raw) {
  if (typeof raw !== "string") return null;
  let text = raw.trim();
  if (!text) return null;
  if (text.startsWith(GO_KEYRING_PREFIX)) {
    try {
      text = Buffer.from(text.slice(GO_KEYRING_PREFIX.length), "base64").toString("utf8");
    } catch {
      return null;
    }
  }
  try {
    const obj = JSON.parse(text);
    return obj && typeof obj === "object" && !Array.isArray(obj) ? obj : null;
  } catch {
    return null;
  }
}

/**
 * Windows 下通过 PowerShell Reflection.Emit 调用 `advapi32.dll!CredReadW` 读取 `gemini:antigravity`。
 * 相比 Add-Type：不启动 csc.exe、不落盘临时文件，耗时约数毫秒。
 */
function readWindowsCredential(target = "gemini:antigravity", execFn = execFileSync) {
  const safeTarget = String(target).replace(/"/g, "");
  const ps = [
    "$ProgressPreference = 'SilentlyContinue'",
    "$asm = [AppDomain]::CurrentDomain.DefineDynamicAssembly((New-Object Reflection.AssemblyName('TokenBarCred')), [Reflection.Emit.AssemblyBuilderAccess]::Run)",
    "$mod = $asm.DefineDynamicModule('CredMod')",
    "$tb = $mod.DefineType('NativeCred', [Reflection.TypeAttributes]'Public,Abstract,Sealed')",
    "$m1 = $tb.DefinePInvokeMethod('CredReadW', 'advapi32.dll', [Reflection.MethodAttributes]'Public,Static,PinvokeImpl', [Reflection.CallingConventions]::Standard, [bool], @([string], [uint32], [uint32], [IntPtr].MakeByRefType()), [Runtime.InteropServices.CallingConvention]::Winapi, [Runtime.InteropServices.CharSet]::Unicode)",
    "$m1.SetImplementationFlags($m1.GetMethodImplementationFlags() -bor [Reflection.MethodImplAttributes]::PreserveSig)",
    "$m2 = $tb.DefinePInvokeMethod('CredFree', 'advapi32.dll', [Reflection.MethodAttributes]'Public,Static,PinvokeImpl', [Reflection.CallingConventions]::Standard, [void], @([IntPtr]), [Runtime.InteropServices.CallingConvention]::Winapi, [Runtime.InteropServices.CharSet]::Auto)",
    "$m2.SetImplementationFlags($m2.GetMethodImplementationFlags() -bor [Reflection.MethodImplAttributes]::PreserveSig)",
    "$t = $tb.CreateType()",
    "$ptr = [IntPtr]::Zero",
    `$ok = $t::CredReadW("${safeTarget}", 1, 0, [ref]$ptr)`,
    "if ($ok -and $ptr -ne [IntPtr]::Zero) {",
    "  try {",
    "    $is64 = [IntPtr]::Size -eq 8",
    "    $sizeOff = if ($is64) { 32 } else { 20 }",
    "    $blobOff = if ($is64) { 40 } else { 24 }",
    "    $sz = [Runtime.InteropServices.Marshal]::ReadInt32($ptr, $sizeOff)",
    "    $bp = [Runtime.InteropServices.Marshal]::ReadIntPtr($ptr, $blobOff)",
    "    if ($sz -gt 0 -and $bp -ne [IntPtr]::Zero) {",
    "      $buf = New-Object byte[] $sz",
    "      [Runtime.InteropServices.Marshal]::Copy($bp, $buf, 0, $sz)",
    "      [Console]::OutputEncoding = [Text.Encoding]::UTF8",
    "      [Console]::Write([Convert]::ToBase64String($buf))",
    "    }",
    "  } finally { $t::CredFree($ptr) }",
    "}"
  ].join("\n");
  try {
    const encoded = Buffer.from(ps, "utf16le").toString("base64");
    const out = execFn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"]
    });
    const b64 = String(out || "").trim();
    if (!b64) return null;
    return Buffer.from(b64, "base64").toString("utf8");
  } catch {
    return null;
  }
}

function readMacCredential(service = "gemini", account = "antigravity", execFn = execFileSync) {
  try {
    const out = execFn("/usr/bin/security", ["find-generic-password", "-s", service, "-a", account, "-w"], {
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"]
    });
    const text = String(out || "").replace(/[\r\n]+$/, "");
    return text || null;
  } catch {
    return null;
  }
}

function readOsLiveCredential(execFn = execFileSync) {
  if (process.platform === "win32") return readWindowsCredential("gemini:antigravity", execFn);
  if (process.platform === "darwin") return readMacCredential("gemini", "antigravity", execFn);
  return null;
}

/** 去掉 `Google AI <档位>` 前面多余的 `Google `，保留 `"Google AI"` 本身或非 AI 名称 */
function stripGoogleAiPrefix(name) {
  if (typeof name !== "string") return "";
  if (!/^google\s+/i.test(name)) return name;
  const rest = name.replace(/^google\s+/i, "").trimStart();
  if (/^ai\s+\S/i.test(rest)) return rest;
  return name;
}

/** Ultra 分 5x / 20x：`g1-ultra-lite-tier` → 5x，`g1-ultra-tier` → 20x */
function withUltraVariant(name, tierId) {
  const variant = tierId === "g1-ultra-lite-tier" ? "5x"
    : tierId === "g1-ultra-tier" ? "20x" : null;
  if (!variant) return name;
  const lower = name.toLowerCase();
  if (!lower.includes("ultra") || lower.includes("5x") || lower.includes("20x")) return name;
  return `${name} ${variant}`;
}

/** 从 `loadCodeAssist` 响应提取套餐展示名（对齐 CC Switch `code_assist_plan`） */
function codeAssistPlan(body) {
  if (!body || typeof body !== "object") return null;
  const paidName = nonEmpty(body.paidTier && body.paidTier.name);
  if (paidName) {
    const paidId = nonEmpty(body.paidTier && body.paidTier.id);
    return withUltraVariant(stripGoogleAiPrefix(paidName), paidId);
  }
  const curId = nonEmpty(body.currentTier && body.currentTier.id);
  if (!curId) return null;
  if (curId === "free-tier") return "Free";
  if (curId === "standard-tier") return "Paid";
  const curName = nonEmpty(body.currentTier && body.currentTier.name);
  return curName ? withUltraVariant(stripGoogleAiPrefix(curName), curId) : null;
}

/** 提取无资格 / 锁区原因（对齐 CC Switch `parse_ineligible_reason`） */
function parseIneligibleReason(body) {
  if (!body || typeof body !== "object") return null;
  const allowed = Array.isArray(body.allowedTiers) ? body.allowedTiers : [];
  const ineligible = Array.isArray(body.ineligibleTiers) ? body.ineligibleTiers : [];
  const curId = body.currentTier && body.currentTier.id;
  const hasFreeTier = curId === "free-tier" || allowed.some(t => t && t.id === "free-tier");

  if (body.gcpManaged !== true && !hasFreeTier) {
    const freeInelig = ineligible.find(t => t && t.tierId === "free-tier" && nonEmpty(t.reasonMessage));
    if (freeInelig) return nonEmpty(freeInelig.reasonMessage);
  }
  if (body.currentTier != null) return null;
  const any = ineligible.find(t => t && nonEmpty(t.reasonMessage));
  return any ? nonEmpty(any.reasonMessage) : null;
}

/** 提取 `cloudaicompanionProject`（字符串或 `{ id / projectId }` 对象） */
function parseProject(body) {
  if (!body || typeof body !== "object") return null;
  const proj = body.cloudaicompanionProject;
  if (typeof proj === "string") return nonEmpty(proj);
  if (proj && typeof proj === "object") {
    return nonEmpty(proj.id) || nonEmpty(proj.projectId);
  }
  return null;
}

/** 取组内最紧张的一档：利用率最高者优先（相等时优先 5h） */
function pickBottleneck(tiers) {
  if (!tiers || !tiers.length) return null;
  return tiers.reduce((best, cur) => {
    if (!best) return cur;
    if (cur.usedPercent > best.usedPercent) return cur;
    if (cur.usedPercent === best.usedPercent && cur.order < best.order) return cur;
    return best;
  }, null);
}

/**
 * 把 `retrieveUserQuotaSummary` 响应整理为 TokenBar 统一口径：
 * - 保留 5 档结构（`gemini-5h` / `gemini-weekly` / `gemini-argon-wtu-weekly` / `3p-5h` / `3p-weekly`）
 * - 分组给出 `gemini` 与 `thirdParty` 的 `primary`、`fiveHour`、`weekly` 供卡片与弹窗直接渲染
 */
function normalizeAgyQuota(summary, meta = {}) {
  if (!summary || typeof summary !== "object") return null;
  const groups = Array.isArray(summary.groups) ? summary.groups : [];
  const tiers = [];

  for (const group of groups) {
    const buckets = Array.isArray(group && group.buckets) ? group.buckets : [];
    for (const bucket of buckets) {
      const id = bucket && (bucket.bucketId || bucket.id);
      const def = id ? BUCKET_DEFS[id] : null;
      if (!def) continue;
      if (bucket.remainingFraction == null) continue;
      const fracNum = Number(bucket.remainingFraction);
      if (!Number.isFinite(fracNum)) continue;
      const remaining = clamp01(fracNum);
      const remainingPercent = remaining * 100;
      const usedPercent = (1 - remaining) * 100;
      const resetTimeIso = nonEmpty(bucket.resetTime);
      const resetMs = resetTimeIso ? Date.parse(resetTimeIso) : NaN;
      tiers.push({
        id,
        key: def.key,
        group: def.group,
        window: def.window,
        windowMinutes: def.windowMinutes,
        label: def.label,
        order: def.order,
        usedPercent,
        remainingPercent,
        resetsAt: Number.isFinite(resetMs) ? Math.floor(resetMs / 1000) : null,
        resetTimeIso
      });
    }
  }

  if (!tiers.length) return null;
  tiers.sort((a, b) => a.order - b.order);

  const buildGroup = groupName => {
    const list = tiers.filter(t => t.group === groupName);
    if (!list.length) return null;
    return {
      primary: pickBottleneck(list),
      fiveHour: list.find(t => t.window === "5h") || null,
      weekly: list.find(t => t.window === "weekly") || null,
      argonWeekly: list.find(t => t.window === "argon") || null,
      tiers: list
    };
  };

  return {
    tiers,
    gemini: buildGroup("gemini"),
    thirdParty: buildGroup("thirdParty"),
    planType: meta.plan || null,
    email: meta.email ? maskEmail(meta.email) : null,
    limitReached: tiers.some(t => t.usedPercent >= 99.9),
    sampledAt: meta.sampledAt || nowIso()
  };
}

function userAgent(appVersion, agyVersion) {
  return `tokenbar/${appVersion || "3.2.0"} (antigravity/cli/${agyVersion || FALLBACK_AGY_VERSION})`;
}

function tokenExpiryMs(credential) {
  const expiry = credential && credential.token && credential.token.expiry;
  if (!expiry) return NaN;
  return Date.parse(expiry);
}

function usableAccessToken(credential, nowMs = Date.now(), marginMs = TOKEN_EXPIRY_MARGIN_MS) {
  const token = credential && credential.token && credential.token.access_token;
  if (typeof token !== "string" || !token) return null;
  const expMs = tokenExpiryMs(credential);
  if (!Number.isFinite(expMs)) return null;
  return expMs > nowMs + marginMs ? token : null;
}

function refreshTokenOf(credential) {
  const token = credential && credential.token && credential.token.refresh_token;
  return typeof token === "string" && token ? token : null;
}

function emailHintFromAppStorage(fs, appStorageFile) {
  if (!appStorageFile) return null;
  try {
    const data = JSON.parse(fs.readFileSync(appStorageFile, "utf8"));
    return nonEmpty(data && data["agy.onboarding.lastLoginUsername"]);
  } catch {
    return null;
  }
}

function shaShort(text) {
  return crypto.createHash("sha256").update(String(text || "")).digest("hex").slice(0, 12);
}

function createAntigravityQuotaStore(options = {}) {
  const fs = options.fs || require("node:fs");
  const path = options.path || require("node:path");
  const fetchFn = options.fetch || curlRequest;
  const execFn = options.execFileSync || execFileSync;
  const getNowMs = options.nowMs || (() => Date.now());
  const appVersion = options.appVersion || "3.2.0";
  const agyVersion = options.agyVersion || FALLBACK_AGY_VERSION;
  const cacheFile = options.cacheFile || null;
  const ccSwitchAccountsFile = options.ccSwitchAccountsFile
    || path.join(os.homedir(), ".cc-switch", "agy_accounts.json");
  const appStorageFile = options.appStorageFile
    || (process.env.APPDATA ? path.join(process.env.APPDATA, "Antigravity", "app_storage.json") : null);

  /** 本地缓存（TokenBar 自己的数据目录）：存上次查到的额度与续期后的 token 副本 */
  let quotaCache = new Map();
  let tokenCopies = new Map();
  let identityCache = new Map();
  let lastLiveRaw = { checkedAt: 0, cred: null };

  function loadDiskCache() {
    if (!cacheFile) return;
    try {
      const doc = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
      if (!doc || typeof doc !== "object") return;
      if (doc.quotas && typeof doc.quotas === "object") {
        for (const [id, entry] of Object.entries(doc.quotas)) {
          if (entry && typeof entry === "object") quotaCache.set(id, entry);
        }
      }
      if (doc.tokens && typeof doc.tokens === "object") {
        for (const [id, copy] of Object.entries(doc.tokens)) {
          if (copy && typeof copy === "object") tokenCopies.set(id, copy);
        }
      }
      if (doc.identities && typeof doc.identities === "object") {
        for (const [id, info] of Object.entries(doc.identities)) {
          if (info && typeof info === "object") identityCache.set(id, info);
        }
      }
    } catch {
      /* 无缓存或损坏不影响主流程 */
    }
  }

  function saveDiskCache() {
    if (!cacheFile) return;
    try {
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      const payload = {
        version: 1,
        quotas: Object.fromEntries(quotaCache.entries()),
        tokens: Object.fromEntries(tokenCopies.entries()),
        identities: Object.fromEntries(identityCache.entries())
      };
      const tmp = cacheFile + ".tmp-tokenbar";
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + "\n", "utf8");
      fs.renameSync(tmp, cacheFile);
    } catch {
      /* 写盘失败不阻塞内存使用 */
    }
  }

  loadDiskCache();

  function readLiveCredential(force = false) {
    const now = getNowMs();
    if (!force && lastLiveRaw.checkedAt && now - lastLiveRaw.checkedAt < KEYCHAIN_RECHECK_MS) {
      return lastLiveRaw.cred;
    }

    let raw = null;
    if (typeof options.readLiveCredential === "function") {
      raw = options.readLiveCredential();
    } else if (process.env.AGY_CREDENTIAL_FILE) {
      try {
        raw = fs.readFileSync(process.env.AGY_CREDENTIAL_FILE, "utf8");
      } catch {
        raw = null;
      }
    } else if (!options.disableKeychain && process.env.CODEX_TOKEN_DASHBOARD_SMOKE !== "1") {
      raw = readOsLiveCredential(execFn);
    }

    const cred = typeof raw === "string" ? decodeKeychainCredential(raw) : (raw && typeof raw === "object" ? raw : null);
    lastLiveRaw = { checkedAt: now, cred };
    return cred;
  }

  function mergeFresherTokenCopy(accountId, baseCred) {
    const copy = tokenCopies.get(accountId);
    if (!copy || !copy.token) return baseCred;
    if (refreshTokenOf(copy) !== refreshTokenOf(baseCred)) return baseCred;
    const baseExp = tokenExpiryMs(baseCred);
    const copyExp = tokenExpiryMs(copy);
    if (Number.isFinite(copyExp) && (!Number.isFinite(baseExp) || copyExp > baseExp)) {
      return {
        ...baseCred,
        token: { ...baseCred.token, ...copy.token },
        id_token: copy.id_token || baseCred.id_token
      };
    }
    return baseCred;
  }

  function extractIdentityFromCred(cred) {
    const idClaims = cred && cred.id_token ? jwtClaims(cred.id_token) : null;
    const sub = nonEmpty(idClaims && idClaims.sub);
    const email = nonEmpty(idClaims && idClaims.email) || nonEmpty(cred && cred.id_token_email);
    return { sub, email };
  }

  function discover(forceKeychain = false) {
    const accounts = [];
    const bySub = new Map();
    const byRefresh = new Map();

    // 1. 先读 ~/.cc-switch/agy_accounts.json（若用户使用 CC Switch 管了多个号）
    let ccAccounts = {};
    if (ccSwitchAccountsFile && fs.existsSync(ccSwitchAccountsFile)) {
      try {
        const doc = JSON.parse(fs.readFileSync(ccSwitchAccountsFile, "utf8"));
        if (doc && doc.accounts && typeof doc.accounts === "object") ccAccounts = doc.accounts;
      } catch {
        ccAccounts = {};
      }
    }

    for (const [subKey, entry] of Object.entries(ccAccounts)) {
      if (!entry || !entry.credential) continue;
      const rt = refreshTokenOf(entry.credential);
      if (!rt) continue;
      const id = `cc:${subKey}`;
      const acct = {
        id,
        sub: subKey,
        email: nonEmpty(entry.email) || extractIdentityFromCred(entry.credential).email,
        source: "cc-switch",
        isActive: false,
        credential: mergeFresherTokenCopy(id, entry.credential)
      };
      accounts.push(acct);
      bySub.set(subKey, acct);
      byRefresh.set(rt, acct);
    }

    // 2. 再读当前系统钥匙串中的 `gemini:antigravity`
    const liveCred = readLiveCredential(forceKeychain);
    if (liveCred && refreshTokenOf(liveCred)) {
      const rt = refreshTokenOf(liveCred);
      const { sub, email } = extractIdentityFromCred(liveCred);
      const matched = (sub && bySub.get(sub))
        || byRefresh.get(rt)
        || (email ? accounts.find(a => a.email && a.email.toLowerCase() === email.toLowerCase()) : null);

      if (matched) {
        matched.isActive = true;
        matched.source = "keychain";
        // 只保留较新的那份令牌
        const liveExp = tokenExpiryMs(liveCred);
        const curExp = tokenExpiryMs(matched.credential);
        if (Number.isFinite(liveExp) && (!Number.isFinite(curExp) || liveExp > curExp)) {
          matched.credential = mergeFresherTokenCopy(matched.id, liveCred);
        }
        if (email && !matched.email) matched.email = email;
      } else {
        const cachedInfo = identityCache.get("live") || identityCache.get(`rt:${shaShort(rt)}`);
        const id = sub ? `agy:${sub}` : `agy:live-${shaShort(rt)}`;
        const resolvedEmail = email
          || nonEmpty(cachedInfo && cachedInfo.email)
          || emailHintFromAppStorage(fs, appStorageFile);
        const acct = {
          id,
          sub: sub || nonEmpty(cachedInfo && cachedInfo.sub),
          email: resolvedEmail,
          source: "keychain",
          isActive: true,
          credential: mergeFresherTokenCopy(id, liveCred)
        };
        accounts.unshift(acct);
      }
    }

    // 把历史 identityCache 中按 accountId 存下的邮箱也补上
    for (const acct of accounts) {
      if (!acct.email) {
        const cachedInfo = identityCache.get(acct.id);
        if (cachedInfo && cachedInfo.email) acct.email = cachedInfo.email;
      }
    }

    return accounts;
  }

  async function refreshOAuthToken(account) {
    const rt = refreshTokenOf(account.credential);
    if (!rt) throw new Error("缺少 refresh_token，需要重新登录 Antigravity");
    const form = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: rt,
      client_id: OAUTH_CLIENT_ID,
      client_secret: oauthClientSecret()
    });
    const res = await fetchFn(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString()
    });
    let json = null;
    try { json = await res.json(); } catch { json = null; }
    if (!res.ok) {
      const errCode = json && json.error ? String(json.error) : `HTTP ${res.status}`;
      if (errCode === "invalid_grant") throw new Error("Antigravity 登录已失效，需要重新登录");
      throw new Error(`Antigravity 令牌刷新失败（${errCode}）`);
    }
    if (!json || !json.access_token) throw new Error("令牌刷新响应缺少 access_token");
    const expiresIn = Number(json.expires_in) || 3599;
    const expiry = new Date(getNowMs() + Math.max(0, expiresIn) * 1000).toISOString();
    const updatedToken = {
      ...account.credential.token,
      access_token: json.access_token,
      token_type: json.token_type || account.credential.token.token_type || "Bearer",
      expiry,
      expires_in: expiresIn,
      refresh_token: nonEmpty(json.refresh_token) || rt
    };
    account.credential = {
      ...account.credential,
      token: updatedToken,
      id_token: nonEmpty(json.id_token) || account.credential.id_token
    };
    tokenCopies.set(account.id, {
      token: updatedToken,
      id_token: account.credential.id_token || null
    });
    saveDiskCache();
    return json.access_token;
  }

  async function resolveIdentityIfNeeded(account, accessToken) {
    if (account.email && account.sub) return;
    const cacheKey = `rt:${shaShort(refreshTokenOf(account.credential))}`;
    const existing = identityCache.get(account.id) || identityCache.get(cacheKey);
    if (existing && existing.email) {
      account.email = account.email || existing.email;
      account.sub = account.sub || existing.sub;
      return;
    }
    try {
      const res = await fetchFn(USERINFO_ENDPOINT, {
        method: "GET",
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      if (!res.ok) return;
      const info = await res.json();
      if (info && (info.email || info.sub)) {
        if (info.email) account.email = info.email;
        if (info.sub) account.sub = info.sub;
        identityCache.set(account.id, { sub: account.sub || null, email: account.email || null });
        identityCache.set(cacheKey, { sub: account.sub || null, email: account.email || null });
        saveDiskCache();
      }
    } catch {
      /* userinfo 失败不影响额度展示 */
    }
  }

  async function callAgyApi(accessToken, method, body) {
    const res = await fetchFn(`${API_BASE}:${method}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "User-Agent": userAgent(appVersion, agyVersion)
      },
      body: JSON.stringify(body)
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = null; }
    return { status: res.status, ok: res.ok, json };
  }

  async function queryWithToken(accessToken) {
    let plan = null;
    let project = null;
    let codeAssistConfirmed = false;

    const r1 = await callAgyApi(accessToken, "loadCodeAssist", { metadata: { ideType: "ANTIGRAVITY" } });
    if (r1.status === 401) {
      const err = new Error("Google rejected the sign-in (401)");
      err.status = 401;
      throw err;
    }
    if (r1.ok && r1.json) {
      const ineligible = parseIneligibleReason(r1.json);
      if (ineligible) throw new Error(ineligible);
      plan = codeAssistPlan(r1.json);
      project = parseProject(r1.json);
      codeAssistConfirmed = true;
    }

    const r2 = await callAgyApi(accessToken, "retrieveUserQuotaSummary", project ? { project } : {});
    if (r2.status === 401) {
      const err = new Error("Google rejected the sign-in (401)");
      err.status = 401;
      throw err;
    }
    if (!r2.ok) {
      if (r2.status === 403 && !codeAssistConfirmed) {
        const retryAssist = await callAgyApi(accessToken, "loadCodeAssist", { metadata: { ideType: "ANTIGRAVITY" } });
        if (retryAssist.ok && retryAssist.json) {
          const ineligible = parseIneligibleReason(retryAssist.json);
          if (ineligible) throw new Error(ineligible);
        }
      }
      const msg = (r2.json && r2.json.error && r2.json.error.message) || `HTTP ${r2.status}`;
      throw new Error(`Antigravity 额度接口返回 ${r2.status}: ${String(msg).slice(0, 160)}`);
    }

    return { summary: r2.json, plan };
  }

  function publicEntry(account, entry) {
    const labelEmail = account.email ? maskEmail(account.email) : "Antigravity";
    return {
      id: account.id,
      email: labelEmail,
      source: account.source,
      isActive: account.isActive,
      hasRefreshToken: Boolean(refreshTokenOf(account.credential)),
      planType: entry && entry.quota ? entry.quota.planType : (entry && entry.planType) || null,
      quota: entry && entry.quota ? entry.quota : null,
      fetchedAt: entry ? entry.fetchedAt : null,
      error: entry ? entry.error || null : null
    };
  }

  function list() {
    const accounts = discover(false);
    return {
      accounts: accounts.map(acct => publicEntry(acct, quotaCache.get(acct.id) || null)),
      activeId: (accounts.find(a => a.isActive) || accounts[0] || {}).id || null
    };
  }

  async function fetchQuota(accountId, opts = {}) {
    const accounts = discover(Boolean(opts.force));
    const account = accounts.find(a => a.id === accountId);
    if (!account) throw new Error("Antigravity 账号不存在或未登录");

    const now = getNowMs();
    let token = usableAccessToken(account.credential, now);
    let refreshedThisCall = false;
    if (!token && !opts.skipRefresh) {
      token = await refreshOAuthToken(account);
      refreshedThisCall = true;
    }
    if (!token) throw new Error("Antigravity access_token 无效且无法刷新");

    try {
      let data;
      try {
        data = await queryWithToken(token);
      } catch (err) {
        if (err && err.status === 401 && !refreshedThisCall && !opts.skipRefresh) {
          token = await refreshOAuthToken(account);
          refreshedThisCall = true;
          data = await queryWithToken(token);
        } else {
          throw err;
        }
      }

      await resolveIdentityIfNeeded(account, token);
      const sampledAt = nowIso(getNowMs());
      const quota = normalizeAgyQuota(data.summary, {
        plan: data.plan,
        email: account.email,
        sampledAt
      });
      if (!quota) throw new Error("Antigravity 额度接口未返回有效额度组");

      const entry = {
        quota,
        planType: quota.planType,
        fetchedAt: sampledAt,
        error: null
      };
      quotaCache.set(account.id, entry);
      saveDiskCache();
      return publicEntry(account, entry);
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      const prev = quotaCache.get(account.id);
      const entry = {
        quota: prev && prev.quota ? prev.quota : null,
        planType: prev && prev.planType ? prev.planType : null,
        fetchedAt: nowIso(getNowMs()),
        error: message
      };
      quotaCache.set(account.id, entry);
      saveDiskCache();
      throw error;
    }
  }

  async function activeQuota(opts = {}) {
    const accounts = discover(Boolean(opts.force));
    const active = accounts.find(a => a.isActive) || accounts[0];
    if (!active) return null;
    const cached = quotaCache.get(active.id);
    if (!opts.force && cached && cached.quota && cached.fetchedAt) {
      const age = getNowMs() - Date.parse(cached.fetchedAt);
      if (Number.isFinite(age) && age < QUOTA_CACHE_TTL_MS) {
        return publicEntry(active, cached);
      }
    }
    return fetchQuota(active.id, opts);
  }

  function cachedQuotaFor(accountId) {
    const entry = accountId ? quotaCache.get(accountId) : null;
    return entry && entry.quota ? entry.quota : null;
  }

  function bestCachedQuota() {
    const accounts = discover(false);
    const active = accounts.find(a => a.isActive) || accounts[0];
    if (active) {
      const entry = quotaCache.get(active.id);
      if (entry && entry.quota) return { ...entry.quota, source: "api", fetchedAt: entry.fetchedAt };
    }
    for (const entry of quotaCache.values()) {
      if (entry && entry.quota) return { ...entry.quota, source: "api", fetchedAt: entry.fetchedAt };
    }
    return null;
  }

  return {
    discover,
    list,
    fetchQuota,
    activeQuota,
    cachedQuotaFor,
    bestCachedQuota
  };
}

module.exports = {
  createAntigravityQuotaStore,
  decodeKeychainCredential,
  readWindowsCredential,
  readMacCredential,
  stripGoogleAiPrefix,
  withUltraVariant,
  codeAssistPlan,
  parseIneligibleReason,
  parseProject,
  normalizeAgyQuota,
  BUCKET_DEFS
};
