"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  createAntigravityQuotaStore,
  decodeKeychainCredential,
  codeAssistPlan,
  parseIneligibleReason,
  parseProject,
  normalizeAgyQuota
} = require("../desktop/data/antigravity-quota-store.cjs");

test("decodeKeychainCredential 支持 go-keyring-base64 前缀与裸 JSON", () => {
  const sample = { token: { access_token: "a", refresh_token: "r" }, auth_method: "consumer" };
  const b64 = "go-keyring-base64:" + Buffer.from(JSON.stringify(sample), "utf8").toString("base64");
  assert.deepEqual(decodeKeychainCredential(b64), sample);
  assert.deepEqual(decodeKeychainCredential(JSON.stringify(sample)), sample);
  assert.equal(decodeKeychainCredential("[1,2]"), null);
  assert.equal(decodeKeychainCredential("go-keyring-base64:!!!"), null);
});

test("codeAssistPlan 与 parseIneligibleReason / parseProject 对齐 CC Switch", () => {
  assert.equal(codeAssistPlan({ paidTier: { id: "g1-pro-tier", name: "Google AI Pro" } }), "AI Pro");
  assert.equal(codeAssistPlan({ paidTier: { id: "g1-ultra-lite-tier", name: "Google AI Ultra" } }), "AI Ultra 5x");
  assert.equal(codeAssistPlan({ paidTier: { id: "g1-ultra-tier", name: "Google AI Ultra" } }), "AI Ultra 20x");
  assert.equal(codeAssistPlan({ currentTier: { id: "free-tier" } }), "Free");
  assert.equal(codeAssistPlan({ currentTier: { id: "standard-tier" } }), "Paid");
  assert.equal(codeAssistPlan({ paidTier: { id: "other", name: "Google AI" } }), "Google AI");

  assert.equal(
    parseIneligibleReason({
      currentTier: { id: "standard-tier" },
      ineligibleTiers: [{ tierId: "free-tier", reasonMessage: "Unsupported region" }]
    }),
    "Unsupported region"
  );
  assert.equal(
    parseIneligibleReason({
      gcpManaged: true,
      currentTier: { id: "standard-tier" },
      ineligibleTiers: [{ tierId: "free-tier", reasonMessage: "Enterprise managed" }]
    }),
    null
  );

  assert.equal(parseProject({ cloudaicompanionProject: "aicode-consumers" }), "aicode-consumers");
  assert.equal(parseProject({ cloudaicompanionProject: { id: "proj-1" } }), "proj-1");
  assert.equal(parseProject({ cloudaicompanionProject: { id: " ", projectId: "proj-2" } }), "proj-2");
  assert.equal(parseProject({}), null);
});

test("normalizeAgyQuota 按 Gemini 与 Claude/GPT 分组并取组内最高利用率档", () => {
  const normalized = normalizeAgyQuota({
    groups: [
      {
        buckets: [
          { bucketId: "gemini-weekly", remainingFraction: 0.85, resetTime: "2026-12-03T01:00:00Z" },
          { bucketId: "gemini-5h", remainingFraction: 0.4, resetTime: "2026-11-26T06:00:00Z" },
          { bucketId: "gemini-argon-wtu-weekly", remainingFraction: 0.25, resetTime: "2026-12-03T02:00:00Z" }
        ]
      },
      {
        buckets: [
          { bucketId: "3p-weekly", remainingFraction: 0.9, resetTime: "2026-12-03T03:00:00Z" },
          { bucketId: "3p-5h", remainingFraction: 1, resetTime: "2026-11-26T07:00:00Z" },
          { bucketId: "unknown-future", remainingFraction: 0.1 }
        ]
      }
    ]
  }, { plan: "AI Pro", email: "alice@example.com" });

  assert.equal(normalized.tiers.length, 5);
  assert.equal(normalized.planType, "AI Pro");
  assert.equal(normalized.email, "al***@example.com");
  assert.equal(normalized.gemini.primary.id, "gemini-argon-wtu-weekly");
  assert.equal(Math.round(normalized.gemini.primary.usedPercent), 75);
  assert.equal(Math.round(normalized.gemini.fiveHour.remainingPercent), 40);
  assert.equal(normalized.thirdParty.primary.id, "3p-weekly");
  assert.equal(Math.round(normalized.thirdParty.primary.usedPercent), 10);
  assert.equal(normalizeAgyQuota({ groups: [] }), null);
});

test("createAntigravityQuotaStore 自动续期但绝不改写原钥匙串或 CC Switch 文件，且脱敏返回", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokenbar-agy-quota-"));
  const ccFile = path.join(tmp, "agy_accounts.json");
  const cacheFile = path.join(tmp, "antigravity-quota-cache.json");

  const originalCcContent = JSON.stringify({
    version: 1,
    accounts: {
      "sub-live": {
        sub: "sub-live",
        email: "alice@example.com",
        credential: {
          auth_method: "consumer",
          token: {
            access_token: "stale-cc-token",
            refresh_token: "rt-shared",
            expiry: "2020-01-01T00:00:00Z"
          }
        },
        authenticated_at: 100
      },
      "sub-second": {
        sub: "sub-second",
        email: "bob@example.com",
        credential: {
          auth_method: "consumer",
          token: {
            access_token: "bob-access",
            refresh_token: "rt-bob",
            expiry: "2099-01-01T00:00:00Z"
          }
        },
        authenticated_at: 200
      }
    }
  }, null, 2);
  fs.writeFileSync(ccFile, originalCcContent, "utf8");

  const calls = [];
  const fakeFetch = async (url, opts) => {
    calls.push({ url, headers: opts && opts.headers, body: opts && opts.body });
    if (url.includes("oauth2.googleapis.com/token")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: "fresh-access-123", expires_in: 3600 }),
        text: async () => "{}"
      };
    }
    if (url.endsWith(":loadCodeAssist")) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          cloudaicompanionProject: "aicode-consumers",
          currentTier: { id: "free-tier" },
          paidTier: { id: "g1-pro-tier", name: "Google AI Pro" }
        }),
        json: async () => ({})
      };
    }
    if (url.endsWith(":retrieveUserQuotaSummary")) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          groups: [
            { buckets: [{ bucketId: "gemini-5h", remainingFraction: 0.65, resetTime: "2026-11-26T06:00:00Z" }] },
            { buckets: [{ bucketId: "3p-5h", remainingFraction: 0.9, resetTime: "2026-11-26T07:00:00Z" }] }
          ]
        }),
        json: async () => ({})
      };
    }
    throw new Error("unexpected url: " + url);
  };

  try {
    const store = createAntigravityQuotaStore({
      cacheFile,
      ccSwitchAccountsFile: ccFile,
      appVersion: "3.2.0",
      agyVersion: "1.4.6",
      fetch: fakeFetch,
      nowMs: () => Date.parse("2026-11-26T02:00:00Z"),
      readLiveCredential: () => JSON.stringify({
        auth_method: "consumer",
        token: {
          access_token: "expired-live-token",
          refresh_token: "rt-shared",
          expiry: "2020-01-01T00:00:00Z"
        }
      })
    });

    const listed = store.list();
    assert.equal(listed.accounts.length, 2, "同 refresh_token 的账号去重合并为 2 个");
    assert.equal(listed.activeId, "cc:sub-live");
    assert.equal(listed.accounts.find(a => a.id === "cc:sub-live").isActive, true);

    const active = await store.activeQuota({ force: true });
    assert.equal(active.email, "al***@example.com");
    assert.equal(active.planType, "AI Pro");
    assert.equal(Math.round(active.quota.gemini.fiveHour.usedPercent), 35);
    assert.equal(Math.round(active.quota.thirdParty.fiveHour.remainingPercent), 90);

    // 不泄露任何 token 到返回值
    const dumped = JSON.stringify(active);
    assert.equal(dumped.includes("fresh-access-123"), false);
    assert.equal(dumped.includes("rt-shared"), false);

    // 请求携带正确的 UA 和 project
    const assistCall = calls.find(c => c.url.endsWith(":loadCodeAssist"));
    assert.match(assistCall.headers["User-Agent"], /^tokenbar\/3\.2\.0 \(antigravity\/cli\/1\.4\.6\)$/);
    assert.equal(assistCall.headers.Authorization, "Bearer fresh-access-123");
    const quotaCall = calls.find(c => c.url.endsWith(":retrieveUserQuotaSummary"));
    assert.deepEqual(JSON.parse(quotaCall.body), { project: "aicode-consumers" });

    // CC Switch 原文件完全保持未修改；续期结果落在 TokenBar 缓存文件
    assert.equal(fs.readFileSync(ccFile, "utf8"), originalCcContent);
    const savedCache = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    assert.equal(savedCache.tokens["cc:sub-live"].token.access_token, "fresh-access-123");

    // 30 秒缓存命中不再重复请求
    const countBefore = calls.length;
    const cached = await store.activeQuota();
    assert.equal(calls.length, countBefore);
    assert.equal(cached.quota.planType, "AI Pro");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("createAntigravityQuotaStore 在无 id_token 时通过 userinfo 补全脱敏邮箱并处理锁区原因", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokenbar-agy-info-"));
  const cacheFile = path.join(tmp, "cache.json");
  let mode = "ok";

  const fakeFetch = async url => {
    if (url.includes("userinfo")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ sub: "u-999", email: "carol@example.com" })
      };
    }
    if (url.endsWith(":loadCodeAssist")) {
      if (mode === "ineligible") {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            currentTier: { id: "standard-tier" },
            ineligibleTiers: [{ tierId: "free-tier", reasonMessage: "Not available in your location." }]
          })
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ currentTier: { id: "free-tier" } })
      };
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        groups: [{ buckets: [{ bucketId: "gemini-5h", remainingFraction: 0.8 }] }]
      })
    };
  };

  try {
    const store = createAntigravityQuotaStore({
      cacheFile,
      ccSwitchAccountsFile: path.join(tmp, "none.json"),
      fetch: fakeFetch,
      nowMs: () => Date.parse("2026-11-26T02:00:00Z"),
      readLiveCredential: () => JSON.stringify({
        auth_method: "consumer",
        token: {
          access_token: "live-tok",
          refresh_token: "rt-live",
          expiry: "2026-11-26T03:00:00Z"
        }
      })
    });

    const res = await store.activeQuota({ force: true });
    assert.equal(res.email, "ca***@example.com");
    assert.equal(res.planType, "Free");

    mode = "ineligible";
    await assert.rejects(() => store.activeQuota({ force: true }), /Not available in your location\./);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
