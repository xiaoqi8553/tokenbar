const { contextBridge, ipcRenderer } = require("electron");

// 弹窗没有 Node 集成，所有需要特权的操作都经过这条显式白名单桥。
contextBridge.exposeInMainWorld("codexBar", {
  onStatus(callback) {
    if (typeof callback !== "function") return;
    ipcRenderer.on("popover:status", (_event, payload) => callback(payload));
  },
  refresh: () => ipcRenderer.invoke("popover:refresh"),
  setHeight: height => ipcRenderer.send("popover:set-height", Number(height) || 0),
  openDashboard: () => ipcRenderer.invoke("popover:open-dashboard"),
  openStatusPage: () => ipcRenderer.invoke("popover:open-status-page"),
  setLaunchAtLogin: enabled => ipcRenderer.invoke("popover:set-launch-at-login", Boolean(enabled)),
  getPrefs: () => ipcRenderer.invoke("popover:prefs"),
  quit: () => ipcRenderer.invoke("popover:quit"),
  close: () => ipcRenderer.invoke("popover:close"),
  // 科研通签到
  ablesciList: () => ipcRenderer.invoke("ablesci:list"),
  ablesciAdd: (email, password) => ipcRenderer.invoke("ablesci:add", email, password),
  ablesciRemove: id => ipcRenderer.invoke("ablesci:remove", id),
  ablesciSign: () => ipcRenderer.invoke("ablesci:sign"),
  ablesciOpenSite: () => ipcRenderer.invoke("ablesci:open-site"),
  onAbleSciChanged(callback) {
    if (typeof callback !== "function") return;
    ipcRenderer.on("ablesci:changed", () => callback());
  },
  // 实时额度（复用本机 Codex 授权）
  codexAuthList: () => ipcRenderer.invoke("codex-auth:list"),
  codexAuthFetch: (accountId, opts) => ipcRenderer.invoke("codex-auth:fetch", accountId, opts),
  codexAuthActive: opts => ipcRenderer.invoke("codex-auth:active", opts),
  codexAuthDeviceStart: () => ipcRenderer.invoke("codex-auth:device-start"),
  codexAuthDevicePoll: sessionId => ipcRenderer.invoke("codex-auth:device-poll", sessionId),
  codexAuthDeviceStatus: sessionId => ipcRenderer.invoke("codex-auth:device-status", sessionId),
  codexAuthDeviceCancel: sessionId => ipcRenderer.invoke("codex-auth:device-cancel", sessionId),
  codexAuthHide: accountId => ipcRenderer.invoke("codex-auth:hide", accountId),
  codexAuthUnhide: accountId => ipcRenderer.invoke("codex-auth:unhide", accountId)
});
