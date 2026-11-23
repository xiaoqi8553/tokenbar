const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { test } = require("node:test");

const ROOT = path.join(__dirname, "..");
const dashboard = fs.readFileSync(path.join(ROOT, "desktop", "dashboard.html"), "utf8");
const popover = fs.readFileSync(path.join(ROOT, "desktop", "popover.html"), "utf8");

test("2.5.0 看板所有金额以美元显示，不再出现人民币符号", () => {
  // 没有任何「¥」字面量（注释也不留，避免日后复制粘贴复活）
  assert.ok(!dashboard.includes("¥"), "dashboard.html 不应再出现 ¥");
  assert.ok(!popover.includes("¥"), "popover.html 不应再出现 ¥");
  // fmtMoney 在展示边界把人民币 canonical 折成美元
  assert.match(dashboard, /function fmtMoney\(cny\)\s*\{\s*return fmtUsd\(Number\(cny\) \/ moneyRate\(\)\)/);
  assert.match(dashboard, /function moneyRate\(\)/);
  // 单价 tooltip 也用 $
  assert.match(dashboard, /"输入 \$" \+ \(unit\.input \/ rate\)\.toFixed\(2\)/);
  // 弹窗的 formatMoney 同样折算
  assert.match(popover, /function formatMoney\(cny\)\s*\{\s*const n = Number\(cny\) \/ costRate\(\)/);
});

test("2.5.0 实时额度 UI 与 IPC 桥接齐全", () => {
  // 看板：顶栏按钮、弹窗、事件绑定
  assert.ok(dashboard.includes('id="btn-auth"'));
  assert.ok(dashboard.includes('id="auth-modal"'));
  assert.ok(dashboard.includes("function bindAuth()"));
  assert.ok(dashboard.includes("function doFetchQuota(accountId)"));
  assert.ok(dashboard.includes("bindAuth();"));
  // 额度卡标注「实时」
  assert.match(dashboard, /quota\.source === "api" \? " · 实时"/);
  // preload 暴露的方法
  const dashPreload = fs.readFileSync(path.join(ROOT, "desktop", "dashboard-preload.cjs"), "utf8");
  const popPreload = fs.readFileSync(path.join(ROOT, "desktop", "preload.cjs"), "utf8");
  for (const file of [dashPreload, popPreload]) {
    assert.ok(file.includes("codexAuthList"));
    assert.ok(file.includes("codexAuthFetch"));
    assert.ok(file.includes("codexAuthActive"));
  }
});
