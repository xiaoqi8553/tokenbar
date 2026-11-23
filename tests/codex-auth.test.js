const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  createCodexAuthStore,
  maskEmail,
  normalizeQuota,
  extractRateLimits,
  isTokenExpired,
  jwtClaim,
  chatgptAccountId
} = require("../desktop/data/codex-auth-store.cjs");

/** 造一个假 JWT（payload 明文 base64url，测试只解析不校验） */
function fakeJwt(payload) {
  return "h." + Buffer.from(JSON.stringify(payload)).toString("base64url") + ".s";
}

/** 搭一个假的 CODEX_HOME：一个当前账号 + 一个多账号目录 */
function fakeCodexHome({ activeEmail = "alice@example.com", expired = false } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "codex-auth-"));
  const exp = Math.floor(Date.now() / 1000) + (expired ? -100 : 3600);
  const active = {
    auth_mode: "chatgpt",
    tokens: {
      access_token: fakeJwt({ email: activeEmail, exp }),
      refresh_token: "refresh-active",
      id_token: fakeJwt({ email: activeEmail, aud: ["app_EMoamEEZ73f0CkXaXp7hrann"] }),
      account_id: "acct-active"
    }
  };
  fs.writeFileSync(path.join(base, "auth.json"), JSON.stringify(active));

  const stored = {
    auth_mode: "chatgpt",
    tokens: {
      access_token: fakeJwt({ email: "trevor@example.com", exp: Math.floor(Date.now() / 1000) + 3600 }),
      refresh_token: "refresh-stored",
      id_token: fakeJwt({ email: "trevor@example.com" }),
      account_id: "acct-stored"
    }
  };
  fs.mkdirSync(path.join(base, "XQ_acc", "trevor@example.com"), { recursive: true });
  fs.writeFileSync(path.join(base, "XQ_acc", "trevor@example.com", "auth.json"), JSON.stringify(stored));

  // 一个 API key 账号应被忽略
  fs.mkdirSync(path.join(base, "XQ_acc", "Rightcode"), { recursive: true });
  fs.writeFileSync(path.join(base, "XQ_acc", "Rightcode", "auth.json"),
    JSON.stringify({ auth_mode: "apikey", tokens: { access_token: "sk-fake" } }));

  return base;
}

const USAGE_BODY = {
  primary: { used_percent: 41, window_minutes: 300, resets_at: 1795415840 },
  secondary: { used_percent: 9, window_minutes: 10080, resets_at: 1795785893 },
  credits: { has_credits: false, unlimited: false, balance: "0" },
  plan_type: "plus",
  rate_limit_reached_type: null
};

function okResponse(json) {
  return { ok: true, status: 200, json: async () => json };
}

test("normalizeQuota 与 codex-store 同口径", () => {
  const q = normalizeQuota(USAGE_BODY, "2026-11-23T03:00:00.000Z");
  assert.equal(q.session.usedPercent, 41);
  assert.equal(q.session.remainingPercent, 59);
  assert.equal(q.session.windowMinutes, 300);
  assert.equal(q.weekly.usedPercent, 9);
  assert.equal(q.planType, "plus");
  assert.equal(q.sampledAt, "2026-11-23T03:00:00.000Z");
  // 越界百分比被钳制
  const clamped = normalizeQuota({ primary: { used_percent: 130 } });
  assert.equal(clamped.session.usedPercent, 100);
  assert.equal(normalizeQuota({}), null);
});

test("extractRateLimits 兼容直接 / 包一层的返回体", () => {
  assert.ok(extractRateLimits(USAGE_BODY));
  assert.ok(extractRateLimits({ rate_limits: USAGE_BODY }));
  assert.ok(extractRateLimits({ data: { rate_limits: USAGE_BODY } }));
  assert.equal(extractRateLimits({ unexpected: 1 }), null);
});

test("2.5.0 真实 wham/usage 响应：rate_limit.primary_window / reset_at / limit_window_seconds", () => {
  // 2026-11-23 从本机官方接口抓到的真实结构（ field 名与本地 rollout 不同）
  const REAL = {
    user_id: "user-xxx",
    account_id: "acct-active",
    email: "alice@example.com",
    plan_type: "plus",
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: { used_percent: 56, limit_window_seconds: 18000, reset_at: 1795415840 },
      secondary_window: { used_percent: 12, limit_window_seconds: 604800, reset_at: 1795785894 }
    },
    credits: { has_credits: false, unlimited: false, balance: "0" },
    rate_limit_reached_type: null
  };
  const q = normalizeQuota(extractRateLimits(REAL), "2026-11-23T03:00:00.000Z");
  assert.equal(q.planType, "plus");
  assert.equal(q.email, "al***@example.com");
  assert.equal(q.session.usedPercent, 56);
  assert.equal(q.session.windowMinutes, 300); // 18000 秒 → 300 分钟
  assert.equal(q.session.resetsAt, 1795415840); // reset_at 单数也要认
  assert.equal(q.weekly.usedPercent, 12);
  assert.equal(q.weekly.windowMinutes, 10080); // 604800 秒 → 7 天
  assert.equal(q.limitReached, false);
});

test("isTokenExpired / jwtClaim / maskEmail", () => {
  const now = Math.floor(Date.now() / 1000);
  assert.equal(isTokenExpired({ tokens: { access_token: fakeJwt({ exp: now + 3600 }) } }), false);
  assert.equal(isTokenExpired({ tokens: { access_token: fakeJwt({ exp: now - 10 }) } }), true);
  assert.equal(jwtClaim(fakeJwt({ email: "a@b.com" }), "email"), "a@b.com");
  assert.equal(maskEmail("alice@example.com"), "al***@example.com");
});

test("discover/list 找到全部 chatgpt 账号并脱敏，token 不外泄", () => {
  const home = fakeCodexHome();
  const store = createCodexAuthStore({ codexHome: home });
  const list = store.list();
  assert.equal(list.accounts.length, 2); // 当前 + XQ_acc 里的 trevor，不含 apikey
  assert.equal(list.accounts[0].isActive, true);
  assert.equal(list.accounts[0].email, "al***@example.com");
  assert.equal(list.activeId, path.join(home, "auth.json"));
  const serialized = JSON.stringify(list);
  assert.ok(!serialized.includes("refresh-active"), "不能包含 refresh_token");
  assert.ok(!serialized.includes("access_token"), "不能包含 access_token");
});

test("fetchQuota 用 access_token 查官方接口，并把实时额度写进缓存", async () => {
  const home = fakeCodexHome();
  const calls = [];
  const store = createCodexAuthStore({
    codexHome: home,
    fetch: async (url, opts) => {
      calls.push({ url, auth: opts.headers.Authorization, acct: opts.headers["ChatGPT-Account-Id"] });
      return okResponse(USAGE_BODY);
    }
  });
  const list = store.list();
  const result = await store.fetchQuota(list.activeId);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://chatgpt.com/backend-api/wham/usage");
  assert.ok(calls[0].auth.startsWith("Bearer "));
  assert.equal(calls[0].acct, "acct-active");
  assert.equal(result.quota.session.usedPercent, 41);
  assert.equal(result.quota.weekly.usedPercent, 9);
  assert.equal(result.email, "al***@example.com");
  assert.ok(!JSON.stringify(result).includes("access_token"));

  // cachedQuotaFor 给主进程覆盖 status.quota 用
  const cached = store.cachedQuotaFor(list.activeId);
  assert.equal(cached.session.usedPercent, 41);
});

test("access_token 过期时用 refresh_token 换新并写回 auth.json", async () => {
  const home = fakeCodexHome({ expired: true });
  const authFile = path.join(home, "auth.json");
  const newToken = fakeJwt({ email: "alice@example.com", exp: Math.floor(Date.now() / 1000) + 7200 });
  const calls = [];
  const store = createCodexAuthStore({
    codexHome: home,
    fetch: async (url, opts) => {
      calls.push(url);
      if (url.includes("oauth/token")) {
        assert.ok(opts.body.includes("grant_type=refresh_token"));
        assert.ok(opts.body.includes("refresh_token=refresh-active"));
        assert.ok(opts.body.includes("client_id=app_EMoamEEZ73f0CkXaXp7hrann"));
        return okResponse({ access_token: newToken, refresh_token: "refresh-rotated" });
      }
      return okResponse(USAGE_BODY);
    }
  });
  const list = store.list();
  await store.fetchQuota(list.activeId);
  assert.equal(calls.length, 2); // 先 refresh 再 usage
  const written = JSON.parse(fs.readFileSync(authFile, "utf8"));
  assert.equal(written.tokens.refresh_token, "refresh-rotated");
  assert.equal(jwtClaim(written.tokens.access_token, "exp") > Math.floor(Date.now() / 1000), true);
});

test("缺 refresh_token 时刷新失败并给出明确错误", async () => {
  const home = fakeCodexHome({ expired: true });
  const authFile = path.join(home, "auth.json");
  const auth = JSON.parse(fs.readFileSync(authFile, "utf8"));
  delete auth.tokens.refresh_token;
  fs.writeFileSync(authFile, JSON.stringify(auth));
  const store = createCodexAuthStore({ codexHome: home, fetch: async () => okResponse({}) });
  const list = store.list();
  await assert.rejects(() => store.fetchQuota(list.activeId), /refresh_token/);
});

test("activeQuota 30 秒内复用缓存，不重复打接口", async () => {
  const home = fakeCodexHome();
  let count = 0;
  const store = createCodexAuthStore({
    codexHome: home,
    fetch: async () => { count++; return okResponse(USAGE_BODY); }
  });
  await store.activeQuota();
  await store.activeQuota();
  assert.equal(count, 1);
  await store.activeQuota({ force: true });
  assert.equal(count, 2);
});

// ---------------------------------------------------------------------------
// 2.6.0 OAuth Device Code 授权（CC Switch / Codex CLI 同款）
// ---------------------------------------------------------------------------

/** 按 URL 分派的假 fetch，记录每次请求便于断言端点与字段 */
function fakeDeviceFetch() {
  const calls = [];
  const idToken = fakeJwt({
    email: "bob@example.net",
    chatgpt_account_id: "acct-oauth",
    exp: Math.floor(Date.now() / 1000) + 3600
  });
  const fetch = async (url, opts) => {
    calls.push({ url, opts });
    if (url.includes("/deviceauth/usercode")) {
      return okResponse({
        device_auth_id: "deviceauth_abc",
        user_code: "ABCD-EFGH",
        interval: "5",
        expires_at: new Date(Date.now() + 15 * 60_000).toISOString()
      });
    }
    if (url.includes("/deviceauth/token")) {
      return okResponse({
        authorization_code: "auth-code-1",
        code_verifier: "verifier-1",
        code_challenge: "challenge-1"
      });
    }
    if (url.includes("/oauth/token")) {
      return okResponse({
        access_token: fakeJwt({ email: "bob@example.net", exp: Math.floor(Date.now() / 1000) + 3600 }),
        refresh_token: "refresh-oauth",
        id_token: idToken
      });
    }
    if (url.includes("wham/usage")) return okResponse(USAGE_BODY);
    return { ok: false, status: 599, json: async () => ({}) };
  };
  return { fetch, calls };
}

test("2.6.0 设备码授权：申请配对码只回可展示字段，device_auth_id 不外泄", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-device-"));
  const { fetch, calls } = fakeDeviceFetch();
  const store = createCodexAuthStore({ codexHome: home, fetch });
  const started = await store.startDeviceAuth();

  assert.equal(calls[0].url, "https://auth.openai.com/api/accounts/deviceauth/usercode");
  assert.deepEqual(JSON.parse(calls[0].opts.body), { client_id: "app_EMoamEEZ73f0CkXaXp7hrann" });
  assert.equal(started.userCode, "ABCD-EFGH");
  assert.equal(started.verifyUrl, "https://auth.openai.com/codex/device");
  const serialized = JSON.stringify(started);
  assert.ok(!serialized.includes("deviceauth_abc"), "device_auth_id 绝不能出数据层");
  assert.ok(!serialized.includes("access_token"));
});

test("2.6.0 pending 状态：用户还没在浏览器授权时返回 pending，不落盘", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-device-"));
  const startedFetch = fakeDeviceFetch();
  const store = createCodexAuthStore({ codexHome: home, fetch: startedFetch.fetch });
  const { sessionId } = await store.startDeviceAuth();
  const result = await store.pollDeviceAuth(sessionId, {
    fetch: async () => ({ ok: false, status: 403, json: async () => ({}) })
  });
  assert.equal(result.status, "pending");
  assert.ok(!fs.existsSync(path.join(home, "XQ_acc", "bob@example.net", "auth.json")));
});

test("2.6.0 授权成功：换 token → 本机落盘 → 脱敏邮箱与额度，token 不出结果", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-device-"));
  const { fetch, calls } = fakeDeviceFetch();
  const store = createCodexAuthStore({ codexHome: home, fetch });
  const { sessionId } = await store.startDeviceAuth();
  const result = await store.pollDeviceAuth(sessionId);

  assert.equal(result.status, "success");
  assert.equal(result.email, "bo***@example.net");
  assert.equal(result.accountId, "acct-oauth");
  assert.equal(result.quota.session.usedPercent, 41);

  // 端点与表单字段
  const pollCall = calls.find(c => c.url.includes("/deviceauth/token"));
  assert.deepEqual(JSON.parse(pollCall.opts.body), {
    device_auth_id: "deviceauth_abc",
    user_code: "ABCD-EFGH"
  });
  const exchange = calls.find(c => c.url.includes("/oauth/token"));
  const form = new URLSearchParams(exchange.opts.body);
  assert.equal(form.get("grant_type"), "authorization_code");
  assert.equal(form.get("code"), "auth-code-1");
  assert.equal(form.get("code_verifier"), "verifier-1");
  assert.equal(form.get("redirect_uri"), "https://auth.openai.com/deviceauth/callback");

  // 落盘文件：与 Codex auth.json 同构，且不动当前激活文件
  const saved = JSON.parse(fs.readFileSync(path.join(home, "XQ_acc", "bob@example.net", "auth.json"), "utf8"));
  assert.equal(saved.auth_mode, "chatgpt");
  assert.equal(saved.tokens.refresh_token, "refresh-oauth");
  assert.equal(saved.tokens.account_id, "acct-oauth");
  assert.ok(!fs.existsSync(path.join(home, "auth.json")), "不能覆盖当前激活的 auth.json");

  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes("refresh-oauth"), "refresh_token 不能出现在返回值");
  assert.ok(!serialized.includes("access_token"));

  // 新账号能被 discover() 找到
  assert.ok(store.discover().some(a => a.email === "bob@example.net"));
});

test("2.6.0 会话取消与过期", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-device-"));
  const { fetch } = fakeDeviceFetch();
  const store = createCodexAuthStore({ codexHome: home, fetch });
  const { sessionId } = await store.startDeviceAuth();
  assert.ok(store.deviceStatus(sessionId));
  assert.equal(store.cancelDeviceAuth(sessionId), true);
  assert.equal(store.deviceStatus(sessionId), null);
  await assert.rejects(() => store.pollDeviceAuth(sessionId), /会话不存在/);
});

test("2.6.0 bugfix: chatgpt_account_id 在 id_token 的嵌套 claim 里（真实授权失败根因）", () => {
  // 真实 id_token 把 chatgpt_account_id 放在 https://api.openai.com/auth 命名空间下
  const idToken = fakeJwt({
    email: "bob@example.net",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct-nested-123",
      chatgpt_user_id: "user-456"
    }
  });
  assert.equal(chatgptAccountId(idToken, null), "acct-nested-123");
  // 顶层旧格式仍兼容
  assert.equal(chatgptAccountId(fakeJwt({ chatgpt_account_id: "acct-top" }), null), "acct-top");
  // access_token 里也要能找到
  assert.equal(chatgptAccountId(null, fakeJwt({
    "https://api.openai.com/auth": { chatgpt_account_id: "acct-access" }
  })), "acct-access");
  assert.equal(chatgptAccountId(null, null), null);
});

test("2.6.1 隐藏账号：只写本地清单，不碰真实 auth 文件，可恢复", () => {
  const home = fakeCodexHome();
  const hiddenFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "codex-hidden-")), "data", "hidden.json");
  const store = createCodexAuthStore({ codexHome: home, hiddenFile });
  const before = store.list();
  assert.equal(before.hiddenCount, 0);
  const victim = before.accounts.find(a => !a.isActive);
  assert.ok(victim, "需要一个可隐藏的非激活账号");

  store.hideAccount(victim.id);
  const afterHide = store.list();
  assert.equal(afterHide.hiddenCount, 1);
  assert.equal(afterHide.accounts.find(a => a.id === victim.id).isHidden, true);

  // 真实 auth 文件一个字节都没动
  const stillThere = JSON.parse(fs.readFileSync(victim.id, "utf8"));
  assert.ok(stillThere.tokens && stillThere.tokens.access_token, "本机授权文件必须原样保留");
  // 清单落盘且不含 token
  const doc = JSON.parse(fs.readFileSync(hiddenFile, "utf8"));
  assert.deepEqual(doc.ids, [victim.id]);
  assert.ok(!JSON.stringify(doc).includes("access_token"));

  store.unhideAccount(victim.id);
  assert.equal(store.list().hiddenCount, 0);
  // 新实例也能读到（持久化生效）
  const store2 = createCodexAuthStore({ codexHome: home, hiddenFile });
  store2.hideAccount(victim.id);
  assert.equal(createCodexAuthStore({ codexHome: home, hiddenFile }).list().hiddenCount, 1);
});
