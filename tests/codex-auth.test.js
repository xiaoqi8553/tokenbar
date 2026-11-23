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
  jwtClaim
} = require("../desktop/data/codex-auth-store.cjs");

/** 造一个假 JWT（payload 明文 base64url，测试只解析不校验） */
function fakeJwt(payload) {
  return "h." + Buffer.from(JSON.stringify(payload)).toString("base64url") + ".s";
}

/** 搭一个假的 CODEX_HOME：一个当前账号 + 一个多账号目录 */
function fakeCodexHome({ activeEmail = "xiaoqi8553@gmail.com", expired = false } = {}) {
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
    email: "xiaoqi8553@gmail.com",
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
  assert.equal(q.email, "xi***@gmail.com");
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
  assert.equal(maskEmail("xiaoqi8553@gmail.com"), "xi***@gmail.com");
});

test("discover/list 找到全部 chatgpt 账号并脱敏，token 不外泄", () => {
  const home = fakeCodexHome();
  const store = createCodexAuthStore({ codexHome: home });
  const list = store.list();
  assert.equal(list.accounts.length, 2); // 当前 + XQ_acc 里的 trevor，不含 apikey
  assert.equal(list.accounts[0].isActive, true);
  assert.equal(list.accounts[0].email, "xi***@gmail.com");
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
  assert.equal(result.email, "xi***@gmail.com");
  assert.ok(!JSON.stringify(result).includes("access_token"));

  // cachedQuotaFor 给主进程覆盖 status.quota 用
  const cached = store.cachedQuotaFor(list.activeId);
  assert.equal(cached.session.usedPercent, 41);
});

test("access_token 过期时用 refresh_token 换新并写回 auth.json", async () => {
  const home = fakeCodexHome({ expired: true });
  const authFile = path.join(home, "auth.json");
  const newToken = fakeJwt({ email: "xiaoqi8553@gmail.com", exp: Math.floor(Date.now() / 1000) + 7200 });
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
