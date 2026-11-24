"use strict";

/**
 * 3.0 W4 A-E2E：OAuth 状态机与指纹的补充边界。
 *
 * tests/oauth-state.test.js（A-Auth）已覆盖单飞锁、denied/expired、cancel+AbortController、
 * 锁释放后的第二轮 poll。这里只补它没碰到的：枚举导出、指纹/碰撞计数、瞬时错误重试、
 * TTL 过期、申请配对码的入参校验与返回字段脱敏。全部用假 fetch，绝不联网。
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const { test } = require("node:test");

const { createCodexAuthStore, DEVICE_AUTH_STATE } = require("../desktop/data/codex-auth-store.cjs");
const {
  fingerprintOf, noteCollision, collisionStats, resetCollisionStats
} = require("../desktop/data/event-dedupe.cjs");

function response(status, body = {}) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function fakeJwt(payload) {
  return "h." + Buffer.from(JSON.stringify(payload)).toString("base64url") + ".s";
}

const USAGE = {
  primary: { used_percent: 12, window_minutes: 300, resets_at: 1795415840 },
  secondary: { used_percent: 3, window_minutes: 10080, resets_at: 1795785893 }
};
const GRANT = { authorization_code: "code-ext", code_verifier: "verifier-ext" };

function tokens() {
  const idToken = fakeJwt({ email: "carol@example.net", chatgpt_account_id: "acct-ext" });
  return {
    access_token: fakeJwt({ email: "carol@example.net" }),
    refresh_token: "refresh-ext",
    id_token: idToken
  };
}

function makeStore(handlers = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "oauth-ext-"));
  const calls = [];
  const fetch = async (url, opts) => {
    calls.push({ url, opts });
    if (url.includes("/deviceauth/usercode")) {
      return handlers.usercode
        ? handlers.usercode(url, opts)
        : response(200, { device_auth_id: "dev-ext", user_code: "ABCD-EFGH", interval: "1" });
    }
    if (url.includes("/deviceauth/token")) {
      return handlers.poll ? handlers.poll(url, opts, calls) : response(200, GRANT);
    }
    if (url.includes("/oauth/token")) {
      return handlers.token ? handlers.token(url, opts) : response(200, tokens());
    }
    if (url.includes("wham/usage")) {
      return handlers.usage ? handlers.usage(url, opts) : response(200, USAGE);
    }
    return response(599, {});
  };
  return { home, calls, store: createCodexAuthStore({ codexHome: home, fetch }) };
}

test("DEVICE_AUTH_STATE 枚举导出存在且五态逐字正确、不可篡改", () => {
  assert.ok(DEVICE_AUTH_STATE && typeof DEVICE_AUTH_STATE === "object");
  assert.equal(Object.isFrozen(DEVICE_AUTH_STATE), true);
  assert.deepEqual({ ...DEVICE_AUTH_STATE }, {
    PENDING: "pending",
    DENIED: "denied",
    EXPIRED: "expired",
    SUCCESS: "success",
    ERROR: "error"
  });
  assert.deepEqual(Object.values(DEVICE_AUTH_STATE).sort(),
    ["denied", "error", "expired", "pending", "success"]);
});

test("fingerprintOf：request_id 稳定且可区分；无 id 时只拼真实存在的字段", () => {
  resetCollisionStats();
  const base = { i: 10, c: 2, o: 3, t: 13, r: 1 };

  const a = { ...base, request_id: "req-alpha" };
  const b = { ...base, requestId: "req-alpha" }; // 兼容 camelCase
  const c = { ...base, id: "req-beta" };
  assert.equal(fingerprintOf(a), "rid:req-alpha");
  assert.equal(fingerprintOf(b), fingerprintOf(a), "同 id 的指纹必须稳定");
  assert.notEqual(fingerprintOf(c), fingerprintOf(a), "不同 id 必须区分");

  // 缺 id 时回退：不臆造字段，只拼日志里实际存在的 thread/seq/timestamp
  assert.equal(fingerprintOf(base), "sig:10:2:3:13:1");
  const rich = {
    ...base,
    thread_id: "thread-7",
    seq: 42,
    timestamp: "2026-11-24T09:00:00Z"
  };
  const fp = fingerprintOf(rich);
  assert.ok(fp.startsWith("sig:10:2:3:13:1|thread=thread-7|seq=42|ts=2026-11-24T09:00:00Z"), fp);
  assert.equal(/\|d=/.test(fp), false, "没有 date 字段就不能臆造");
  assert.equal(/\|m=/.test(fp), false, "没有 model 字段就不能臆造");

  // 上下文对象里的 thread 也算真实字段
  assert.ok(fingerprintOf(base, { conversation_id: "ctx-thread" }).includes("thread=ctx-thread"));
});

test("noteCollision / collisionStats / resetCollisionStats 计数正确", () => {
  resetCollisionStats();
  assert.deepEqual(collisionStats(), { total: 0, keys: {} });

  const first = noteCollision("base-five-tuple");
  assert.equal(first.count, 1);
  assert.match(first.warning, /第 1 次/);
  assert.equal(noteCollision("base-five-tuple").count, 2);
  assert.equal(noteCollision("another-base").count, 1);

  const stats = collisionStats();
  assert.equal(stats.total, 3);
  assert.deepEqual(stats.keys, { "base-five-tuple": 2, "another-base": 1 });

  resetCollisionStats();
  assert.deepEqual(collisionStats(), { total: 0, keys: {} });
  assert.equal(noteCollision(undefined).key, "*", "无 key 时归入通配桶");
});

test("瞬时网络错误记为 error 且保留会话，下一轮可重试成功", async () => {
  let polls = 0;
  const { calls, store } = makeStore({
    poll: () => {
      polls += 1;
      if (polls === 1) throw new Error("网络抖动");
      return response(403, {});
    }
  });
  const { sessionId } = await store.startDeviceAuth();

  await assert.rejects(() => store.pollDeviceAuth(sessionId), /网络抖动/);
  const errored = store.deviceStatus(sessionId);
  assert.ok(errored, "瞬时错误不应清会话");
  assert.equal(errored.state, DEVICE_AUTH_STATE.ERROR);
  assert.match(errored.error, /网络抖动/);

  const retry = await store.pollDeviceAuth(sessionId);
  assert.equal(retry.status, DEVICE_AUTH_STATE.PENDING);
  assert.equal(store.deviceStatus(sessionId).state, DEVICE_AUTH_STATE.PENDING);
  assert.equal(calls.filter(call => call.url.includes("/deviceauth/token")).length, 2);
});

test("expires_at 已过期的会话 poll 直接返回 expired，不发网络请求", async () => {
  const past = new Date(Date.now() - 60_000).toISOString();
  const { calls, store } = makeStore({
    usercode: () => response(200, {
      device_auth_id: "dev-expired-ttl",
      user_code: "WXYZ-1234",
      interval: "1",
      expires_at: past
    })
  });
  const started = await store.startDeviceAuth();
  assert.equal(started.expiresAt, past);

  const result = await store.pollDeviceAuth(started.sessionId);
  assert.equal(result.status, DEVICE_AUTH_STATE.EXPIRED);
  assert.equal(result.state, DEVICE_AUTH_STATE.EXPIRED);
  assert.equal(store.deviceStatus(started.sessionId), null, "过期会话立即清理");
  assert.equal(calls.filter(call => call.url.includes("/deviceauth/token")).length, 0,
    "TTL 已过就不该再打官方接口");
});

test("申请配对码校验响应字段；start/status 只回可展示字段，device_auth_id 永不过桥", async () => {
  const bad = makeStore({ usercode: () => response(200, { device_auth_id: "dev-1" }) }).store;
  await assert.rejects(() => bad.startDeviceAuth(), /缺少 device_auth_id/);

  const missingUserCode = makeStore({ usercode: () => response(200, { user_code: "ABCD" }) }).store;
  await assert.rejects(() => missingUserCode.startDeviceAuth(), /缺少 device_auth_id/);

  const { store } = makeStore();
  const started = await store.startDeviceAuth();
  assert.deepEqual(Object.keys(started).sort(),
    ["expiresAt", "intervalSec", "sessionId", "userCode", "verifyUrl"].sort());
  assert.equal(JSON.stringify(started).includes("dev-ext"), false);

  const status = store.deviceStatus(started.sessionId);
  assert.deepEqual(Object.keys(status).sort(),
    ["error", "expired", "expiresAt", "sessionId", "state", "userCode", "verifyUrl"].sort());
  assert.equal(status.state, DEVICE_AUTH_STATE.PENDING);
  assert.equal(status.expired, false);
  assert.equal(JSON.stringify(status).includes("dev-ext"), false);
  assert.equal(store.deviceStatus("unknown-session"), null);
});
