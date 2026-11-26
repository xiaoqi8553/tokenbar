"use strict";

/**
 * 3.0 W4 A-E2E：IPC 契约锁死。
 *
 * 深度重构（main.cjs 220 行门面 + core/ipc/**）最容易引入的回归是
 * "preload 暴露了某个 channel，但主进程拆分时漏注册 handler"。
 * 这里把两端 channel 全部从源码提取出来做逐字比对，任何漂移都会 fail。
 */

const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { test } = require("node:test");

const root = path.resolve(__dirname, "..");
const read = rel => fs.readFileSync(path.join(root, rel), "utf8");

function channels(source, api, method) {
  const re = new RegExp(api + "\\." + method + "\\(\\s*[\"']([^\"']+)[\"']", "g");
  return [...source.matchAll(re)].map(match => match[1]);
}

function methods(source) {
  return [...source.matchAll(/^ {2}([A-Za-z_$][\w$]*)\s*[:(]/gm)].map(match => match[1]);
}

const dashboardPreload = read("desktop/dashboard-preload.cjs");
const popoverPreload = read("desktop/preload.cjs");
const ipcFileSources = [
  read("desktop/core/ipc/popover.cjs"),
  read("desktop/core/ipc/dashboard.cjs"),
  read("desktop/core/ipc/auth.cjs")
];
const ipcSources = ipcFileSources.join("\n");

// 主进程侧：invoke → handle，send/on → on
const mainInvokes = new Set(ipcFileSources.flatMap(src => channels(src, "ctx.ipcMain", "handle")));
const mainEvents = new Set(ipcFileSources.flatMap(src => channels(src, "ctx.ipcMain", "on")));

// 渲染侧 invoke 期望清单（逐字锁死，键名/拼写都不允许漂移）
const DASHBOARD_INVOKE = [
  "dashboard:get-detail", "dashboard:refresh", "dashboard:status", "dashboard:meta",
  "dashboard:workbuddy-detail", "dashboard:workbuddy-refresh", "dashboard:open-workbuddy",
  "dashboard:antigravity-detail", "dashboard:antigravity-refresh", "dashboard:open-antigravity",
  "dashboard:open-sessions", "dashboard:open-external",
  "ablesci:list", "ablesci:add", "ablesci:remove", "ablesci:sign", "ablesci:open-site",
  "codex-auth:list", "codex-auth:fetch", "codex-auth:active",
  "codex-auth:device-start", "codex-auth:device-poll", "codex-auth:device-status",
  "codex-auth:device-cancel", "codex-auth:hide", "codex-auth:unhide"
];
const DASHBOARD_METHODS = [
  "getDetail", "refresh", "getStatus", "getMeta", "workbuddyDetail", "workbuddyRefresh",
  "openWorkBuddy", "antigravityDetail", "antigravityRefresh", "openAntigravity",
  "onProgress", "onStatus", "openSessions", "openExternal",
  "ablesciList", "ablesciAdd", "ablesciRemove", "ablesciSign", "ablesciOpenSite",
  "codexAuthList", "codexAuthFetch", "codexAuthActive", "codexAuthDeviceStart",
  "codexAuthDevicePoll", "codexAuthDeviceStatus", "codexAuthDeviceCancel",
  "codexAuthHide", "codexAuthUnhide"
];
const CODEXBAR_INVOKE = [
  "popover:refresh", "popover:open-dashboard", "popover:open-status-page",
  "popover:set-launch-at-login", "popover:prefs", "popover:quit", "popover:close",
  "ablesci:list", "ablesci:add", "ablesci:remove", "ablesci:sign", "ablesci:open-site",
  "codex-auth:list", "codex-auth:fetch", "codex-auth:active",
  "codex-auth:device-start", "codex-auth:device-poll", "codex-auth:device-status",
  "codex-auth:device-cancel", "codex-auth:hide", "codex-auth:unhide"
];
const CODEXBAR_EVENTS = ["popover:status", "ablesci:changed"];
const CODEXBAR_SEND = ["popover:set-height"];

test("dashboard-preload 白名单逐字锁死：28 个方法、26 个 invoke channel", () => {
  const names = methods(dashboardPreload);
  assert.ok(names.length >= 22, `window.dashboard 方法数 ${names.length} < 22`);
  assert.deepEqual([...names].sort(), [...DASHBOARD_METHODS].sort());

  const invokes = channels(dashboardPreload, "ipcRenderer", "invoke");
  assert.deepEqual([...invokes].sort(), [...DASHBOARD_INVOKE].sort());
  assert.deepEqual([...new Set(channels(dashboardPreload, "ipcRenderer", "on"))].sort(),
    ["dashboard:progress", "dashboard:status"]);

  // 进度/状态推送必须带 unsubscribe，避免切窗口后重复注册
  assert.equal((dashboardPreload.match(/removeListener\(/g) || []).length, 2);
  assert.equal((dashboardPreload.match(/contextBridge\.exposeInMainWorld\("dashboard"/g) || []).length, 1);
});

test("preload codexBar 白名单逐字锁死：invoke/send/on 全部匹配", () => {
  const names = methods(popoverPreload);
  assert.ok(names.length >= 20, `window.codexBar 方法数 ${names.length} < 20`);
  const invokes = channels(popoverPreload, "ipcRenderer", "invoke");
  assert.deepEqual([...invokes].sort(), [...CODEXBAR_INVOKE].sort());
  assert.deepEqual(channels(popoverPreload, "ipcRenderer", "send"), CODEXBAR_SEND);
  assert.deepEqual(channels(popoverPreload, "ipcRenderer", "on"), CODEXBAR_EVENTS);
  assert.equal((popoverPreload.match(/contextBridge\.exposeInMainWorld\("codexBar"/g) || []).length, 1);
});

test("双向契约：渲染侧每个 invoke channel 都有主进程 handler（跨三组合并）", () => {
  const renderInvokes = new Set([
    ...channels(dashboardPreload, "ipcRenderer", "invoke"),
    ...channels(popoverPreload, "ipcRenderer", "invoke")
  ]);
  const orphan = [...renderInvokes].filter(channel => !mainInvokes.has(channel)).sort();
  assert.deepEqual(orphan, [], "preload 暴露了但 core/ipc/** 没有 handler：" + orphan.join(", "));

  // 反向：send/on 通道也必须能在主进程找到对应
  const renderEvents = new Set([
    ...channels(dashboardPreload, "ipcRenderer", "on"),
    ...channels(popoverPreload, "ipcRenderer", "on"),
    ...channels(popoverPreload, "ipcRenderer", "send")
  ]);
  // 部分事件是主进程 webContents.send 主动推送的，不需要 ipcMain.on；
  // 但必须能在 core/** 里找到真实的 send 调用（否则就是渲染侧在订阅空气）。
  const pushSources = fs.readdirSync(path.join(root, "desktop/core"))
    .filter(name => name.endsWith(".cjs"))
    .map(name => read(path.join("desktop/core", name)))
    .join("\n") + ipcSources;
  const pushOnly = new Set(["dashboard:progress", "popover:status", "dashboard:status", "ablesci:changed"]);
  const missingEvent = [...renderEvents].filter(channel =>
    !mainEvents.has(channel) &&
    !(pushOnly.has(channel) && pushSources.includes('webContents.send("' + channel + '"'))
  ).sort();
  assert.deepEqual(missingEvent, [], "渲染侧订阅的事件主进程没有来源：" + missingEvent.join(", "));

  // 主进程注册的 handler 不应该比渲染侧凭空多出来（含已删除通道的残留）
  const extra = [...mainInvokes].filter(channel => !renderInvokes.has(channel)).sort();
  assert.deepEqual(extra, [], "主进程存在无人调用的 handler：" + extra.join(", "));
});

test("已删除的旧版通道不得复活（openLegacy / openPricing）", () => {
  const production = [dashboardPreload, popoverPreload, ...ipcSources].join("\n");
  for (const dead of ["openLegacy", "openPricing", "legacy-dashboard", "open-legacy"]) {
    assert.equal(production.includes(dead), false, `已删除通道 ${dead} 不应出现在生产代码`);
  }
  // 门面不应直接注册 handler：全部下沉到 core/ipc/**
  const main = read("desktop/main.cjs");
  assert.equal(/ipcMain\.handle\(/.test(main), false);
  for (const name of ["installPopoverIpc", "installDashboardIpc", "installAuthIpc"]) {
    assert.ok(main.includes(name), `main.cjs 门面应安装 ${name}`);
  }
});

test("建窗安全配置逐字存在：contextIsolation/nodeIntegration/sandbox/webSecurity", () => {
  const windows = read("desktop/core/windows.cjs");
  for (const [snippet, minCount] of [
    ["contextIsolation: true", 2],
    ["nodeIntegration: false", 2],
    ["sandbox: true", 2],
    ["webSecurity: true", 2]
  ]) {
    const count = windows.split(snippet).length - 1;
    assert.ok(count >= minCount, `${snippet} 只出现 ${count} 次（看板窗口 + 弹窗各一次）`);
  }
  assert.equal(/nodeIntegration:\s*true/.test(windows), false);
  assert.equal(/sandbox:\s*false/.test(windows), false);
  assert.equal(/contextIsolation:\s*false/.test(windows), false);
});
