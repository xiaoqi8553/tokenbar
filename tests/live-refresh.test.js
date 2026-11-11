const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const { test } = require("node:test");

const { WorkBuddyStore } = require("../desktop/data/workbuddy-store.cjs");

const main = fs.readFileSync(
  path.join(__dirname, "..", "desktop", "main.cjs"),
  "utf8"
);

test("托盘 30 秒轮询同时刷新 WorkBuddy，启动后新建的会话不会一直漏掉", () => {
  assert.match(main, /setInterval\(\(\) => \{ refreshTrayStatus\(\)/);

  const start = main.indexOf("async function refreshTrayStatus(");
  assert.ok(start > -1, "找到 refreshTrayStatus");
  const end = main.indexOf("\n  }", start);
  const body = main.slice(start, end);

  assert.match(body, /wbStore\.build\(\)/, "轮询里要触发 WorkBuddy 增量扫描");
  assert.match(body, /attachWorkBuddySummary\(\)/, "扫描完要把摘要挂回最新快照");
  assert.doesNotMatch(body, /await wbStore\.build\(\)/, "不阻塞托盘/弹窗的 Codex 刷新");
});

test("WorkBuddy 增量扫描只重扫 size/mtime 变过的文件", () => {
  const store = fs.readFileSync(
    path.join(__dirname, "..", "desktop", "data", "workbuddy-store.cjs"),
    "utf8"
  );
  assert.match(store, /if \(!force && existing && existing\.size === info\.size && existing\.mtimeMs === info\.mtimeMs/);
  assert.match(store, /if \(this\._promise\) return this\._promise;/);
});

function usageLine({ timestamp, traceId, stepSeq, totalTokens }) {
  return JSON.stringify({
    timestamp,
    cwd: "E:\\work\\demo",
    providerData: {
      traceId,
      stepSeq,
      model: "gpt-5",
      usage: {
        inputTokens: Math.round(totalTokens * 0.8),
        outputTokens: totalTokens - Math.round(totalTokens * 0.8),
        totalTokens,
        inputTokensDetails: [{ cached_tokens: 0 }],
        outputTokensDetails: [{ reasoning_tokens: 0 }]
      }
    }
  });
}

test("会话日志继续增长时，非强制重扫会补回新用量，且不阻塞并发调用", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokenbar-live-"));
  try {
    const root = path.join(tmp, "home");
    const projectDir = path.join(root, "projects", "demo-workspace");
    fs.mkdirSync(projectDir, { recursive: true });
    const file = path.join(projectDir, "session-a.jsonl");
    const cacheFile = path.join(tmp, "workbuddy-detail-cache.json");
    const t0 = Date.UTC(2026, 10, 11, 1, 0, 0);

    fs.writeFileSync(
      file,
      `${usageLine({ timestamp: t0, traceId: "trace-1", stepSeq: 1, totalTokens: 1000 })}\n`,
      "utf8"
    );

    const store = new WorkBuddyStore({ roots: [root], cacheFile });
    store.loadCache();
    const first = await store.build();
    assert.equal(first.totals.totalTokens, 1000, "首次启动扫到 1000");

    // 模拟用户继续对话：同一个会话文件追加新请求，size / mtime 变化
    fs.appendFileSync(
      file,
      `${usageLine({ timestamp: t0 + 60_000, traceId: "trace-2", stepSeq: 2, totalTokens: 2500 })}\n`,
      "utf8"
    );

    // 模拟 30 秒轮询：不 force，只看文件变化；两次并行调用也只扫一遍
    const [second, concurrent] = await Promise.all([store.build(), store.build()]);
    assert.equal(second.totals.totalTokens, 3500, "新增的 2500 被补回来");
    assert.equal(concurrent.totals.totalTokens, 3500, "并发调用复用同一个 _promise");
    assert.equal(store.summary().totals.totalTokens, 3500, "托盘/弹窗用的摘要也是新值");

    // 重启进程后从缓存恢复，不应回退到启动时刻的旧值
    const restarted = new WorkBuddyStore({ roots: [root], cacheFile });
    restarted.loadCache();
    const third = await restarted.build();
    assert.equal(third.totals.totalTokens, 3500, "缓存里存的是刷新后的明细");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
