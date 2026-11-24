"use strict";

/**
 * 3.0 W1 A-Auth：OAuth 设备码状态机单测。
 * 全部用假 fetch，绝不联网；只覆盖主进程侧状态机，不碰 dashboard。
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const { test } = require("node:test");

const { createCodexAuthStore, DEVICE_AUTH_STATE } = require("../desktop/data/codex-auth-store.cjs");

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

const GRANT = { authorization_code: "code-1", code_verifier: "verifier-1" };

function tokens() {
  const idToken = fakeJwt({ email: "bob@example.net", chatgpt_account_id: "acct-oauth" });
  return {
    access_token: fakeJwt({ email: "bob@example.net" }),
    refresh_token: "refresh-oauth",
    id_token: idToken
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** handlers.poll 可覆盖轮询响应；handlers.usercode / token / usage 同理 */
function makeStore(handlers = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "oauth-state-"));
  const calls = [];
  const fetch = async (url, opts) => {
    calls.push({ url, opts });
    if (url.includes("/deviceauth/usercode")) {
      return handlers.usercode
        ? handlers.usercode(url, opts)
        : response(200, { device_auth_id: "dev-1", user_code: "ABCD-EFGH", interval: "1" });
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

function pollCalls(calls) {
  return calls.filter(call => call.url.includes("/deviceauth/token"));
}

test("3.0 A-Auth：并发 poll 共享同一个 in-flight promise，绝不发起第二次网络请求", async () => {
  const polls = [];
  const { calls, store } = makeStore({
    poll: () => {
      polls.push(deferred());
      return polls[polls.length - 1].promise;
    }
  });
  const { sessionId } = await store.startDeviceAuth();

  const p1 = store.pollDeviceAuth(sessionId);
  const p2 = store.pollDeviceAuth(sessionId);
  const p3 = store.pollDeviceAuth(sessionId);
  assert.strictEqual(p2, p1, "重复调用必须返回同一个 promise");
  assert.strictEqual(p3, p1);
  assert.equal(pollCalls(calls).length, 1, "只发了一次 /deviceauth/token 请求");

  polls[0].resolve(response(403, {})); // 403 默认仍是 pending（兼容原行为）
  const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
  assert.equal(r1.status, "pending");
  assert.equal(r1.state, DEVICE_AUTH_STATE.PENDING);
  assert.equal(r2, r1);
  assert.equal(r3, r1);
  assert.equal(store.deviceStatus(sessionId).state, "pending");
});

test("3.0 A-Auth：服务端 denied 响应不被误判为 pending，立即清理会话", async () => {
  const outcomes = [
    response(403, { error: "access_denied", error_description: "User rejected" }),
    response(400, { error: { code: "access_denied" } })
  ];
  for (const outcome of outcomes) {
    const { calls, store } = makeStore({ poll: () => outcome });
    const { sessionId } = await store.startDeviceAuth();

    const result = await store.pollDeviceAuth(sessionId);
    assert.equal(result.status, "denied");
    assert.equal(result.state, DEVICE_AUTH_STATE.DENIED);
    assert.equal(result.error, "access_denied");
    assert.equal(store.deviceStatus(sessionId), null, "终态立即清会话，不等 TTL");
    assert.equal(pollCalls(calls).length, 1);
    assert.equal(calls.some(call => call.url.includes("/oauth/token")), false, "拒绝后不能继续换 token");
  }
});

test("3.0 A-Auth：expired 响应置 expired 并立即清理会话", async () => {
  const { calls, store } = makeStore({
    poll: () => response(400, { error: "expired_token" })
  });
  const { sessionId } = await store.startDeviceAuth();

  const result = await store.pollDeviceAuth(sessionId);
  assert.equal(result.status, "expired");
  assert.equal(result.state, DEVICE_AUTH_STATE.EXPIRED);
  assert.equal(store.deviceStatus(sessionId), null);
  assert.equal(pollCalls(calls).length, 1);

  // 410 Gone 也属于明确过期
  const store2 = makeStore({ poll: () => response(410, {}) }).store;
  const { sessionId: id2 } = await store2.startDeviceAuth();
  assert.equal((await store2.pollDeviceAuth(id2)).status, "expired");
});

test("3.0 A-Auth：cancel 用 AbortController 终止 in-flight 轮询", async () => {
  const entered = deferred();
  const { calls, store } = makeStore({
    poll: (url, opts) => new Promise((resolve, reject) => {
      const abort = () => reject(opts.signal.reason || new Error("aborted"));
      if (opts.signal.aborted) abort();
      else opts.signal.addEventListener("abort", abort, { once: true });
      entered.resolve();
    })
  });
  const { sessionId } = await store.startDeviceAuth();

  const pending = store.pollDeviceAuth(sessionId);
  await entered.promise;
  assert.ok(store.deviceStatus(sessionId), "轮询中会话仍然存在");
  assert.equal(store.cancelDeviceAuth(sessionId), true);
  assert.equal(store.deviceStatus(sessionId), null, "cancel 立即从状态表移除");
  await assert.rejects(pending, /取消|aborted/);

  assert.equal(pollCalls(calls).length, 1, "取消后不应重新发起请求");
  assert.equal(calls.some(call => call.url.includes("/oauth/token")), false);
  await assert.rejects(() => store.pollDeviceAuth(sessionId), /会话不存在/);
});

test("3.0 A-Auth：单飞锁在 promise settle 后释放，下一轮能正常发起请求", async () => {
  const { calls, store } = makeStore({ poll: () => response(404, {}) });
  const { sessionId } = await store.startDeviceAuth();

  const first = await store.pollDeviceAuth(sessionId);
  assert.equal(first.status, "pending");
  assert.equal(pollCalls(calls).length, 1);

  const second = await store.pollDeviceAuth(sessionId);
  assert.equal(second.status, "pending");
  assert.equal(pollCalls(calls).length, 2, "上一轮 settle 后锁已释放，下一轮必须重新请求");

  // 成功路径也要保留原有返回结构，并带上 state
  const store2 = makeStore().store;
  const { sessionId: id2 } = await store2.startDeviceAuth();
  const success = await store2.pollDeviceAuth(id2);
  assert.equal(success.status, "success");
  assert.equal(success.state, DEVICE_AUTH_STATE.SUCCESS);
  assert.equal(store2.deviceStatus(id2), null);
});
