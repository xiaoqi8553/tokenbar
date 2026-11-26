  // ---------------------------------------------------------------------
  // 交互
  // ---------------------------------------------------------------------
  function buildRangeTabs() {
    const container = $("range");
    container.innerHTML = RANGES.map(item =>
      '<button type="button" data-key="' + item.key + '" aria-pressed="' + (item.key === state.range) + '">' + item.label + '</button>'
    ).join("");
    container.addEventListener("click", event => {
      const button = event.target.closest("button[data-key]");
      if (!button) return;
      state.range = Number(button.dataset.key);
      localStorage.setItem("codex.range", String(state.range));
      for (const node of container.querySelectorAll("button")) {
        node.setAttribute("aria-pressed", String(Number(node.dataset.key) === state.range));
      }
      renderChart();
      renderModels();
      renderProjects();
      renderHours();
    });
  }

  function buildHourTabs() {
    const container = $("hour-tabs");
    for (const node of container.querySelectorAll("button")) {
      node.setAttribute("aria-pressed", String(node.dataset.metric === state.hourMetric));
    }
    container.addEventListener("click", event => {
      const button = event.target.closest("button");
      if (!button || button.dataset.metric === state.hourMetric) return;
      state.hourMetric = button.dataset.metric;
      localStorage.setItem("codex.hourMetric", state.hourMetric);
      for (const node of container.querySelectorAll("button")) {
        node.setAttribute("aria-pressed", String(node.dataset.metric === state.hourMetric));
      }
      renderHours();
    });
  }

  /** WorkBuddy 今日用量：优先用弹窗快照，没有就退回明细 */
  function workbuddyTodayTokens() {
    const fromStatus = state.status && state.status.workbuddy && state.status.workbuddy.today;
    if (fromStatus && fromStatus.totalTokens) return fromStatus.totalTokens;
    const detail = state.data.workbuddy;
    return detail && detail.today ? detail.today.totalTokens : 0;
  }

  /** Antigravity 今日用量：优先用弹窗快照，没有就退回明细 */
  function antigravityTodayTokens() {
    const fromStatus = state.status && state.status.antigravity && state.status.antigravity.today;
    if (fromStatus && fromStatus.totalTokens) return fromStatus.totalTokens;
    const detail = state.data.antigravity;
    return detail && detail.today ? detail.today.totalTokens : 0;
  }

  function applySourceTabs() {
    for (const node of $("source").querySelectorAll("button")) {
      node.setAttribute("aria-pressed", String(node.dataset.source === state.source));
    }
  }

  function buildSourceTabs() {
    applySourceTabs();
    $("source").addEventListener("click", event => {
      const button = event.target.closest("button[data-source]");
      if (!button || button.dataset.source === state.source) return;
      state.source = button.dataset.source;
      localStorage.setItem("codex.source", state.source);
      applySourceTabs();
      state.hover = -1;
      if (state.data[state.source]) {
        state.detail = state.data[state.source];
        renderAll();
        return;
      }
      $("status-text").textContent = state.source === "workbuddy"
        ? "正在读取 WorkBuddy 日志…"
        : state.source === "antigravity"
          ? "正在读取 Antigravity 日志…"
          : "正在读取 Codex 日志…";
      loadSource(state.source).then(() => {
        state.detail = state.data[state.source];
        renderAll();
      }).catch(error => {
        $("status-text").textContent = "读取失败：" + (error && error.message ? error.message : error);
      });
    });
  }

  async function loadSource(source, { refresh } = {}) {
    const api = window.dashboard;
    let detail;
    if (source === "workbuddy") {
      if (!api.workbuddyDetail) throw new Error("当前版本不支持 WorkBuddy 数据源");
      detail = refresh && api.workbuddyRefresh ? await api.workbuddyRefresh() : await api.workbuddyDetail();
      if (!detail) throw new Error("WorkBuddy 数据层尚未初始化");
      state.data.workbuddy = detail;
    } else if (source === "antigravity") {
      if (!api.antigravityDetail) throw new Error("当前版本不支持 Antigravity 数据源");
      detail = refresh && api.antigravityRefresh ? await api.antigravityRefresh() : await api.antigravityDetail();
      if (!detail) throw new Error("Antigravity 数据层尚未初始化");
      state.data.antigravity = detail;
    } else {
      detail = refresh ? await api.refresh() : await api.getDetail();
      state.data.codex = detail;
    }
    return detail;
  }

  async function load({ refresh } = {}) {
    const button = $("btn-refresh");
    button.dataset.busy = "1";
    try {
      await loadSource("codex", { refresh });
      if (state.source !== "codex") {
        const label = state.source === "antigravity" ? "Antigravity" : "WorkBuddy";
        $("status-text").textContent = "正在读取 " + label + " 日志…";
        await loadSource(state.source, { refresh }).catch(() => {});
      }
      try {
        state.status = await window.dashboard.getStatus();
      } catch {
        /* 配额快照拿不到不影响其余部分 */
      }
      state.detail = state.data[state.source] || state.data.codex;
      $("app").hidden = false;
      renderAll();
      hideBoot();
      // 后台预热其余数据源，切换时不用等扫描
      for (const other of SOURCES) {
        if (other === state.source || state.data[other]) continue;
        loadSource(other).then(() => {
          if (state.source === other) {
            state.detail = state.data[other];
            renderAll();
          } else {
            renderStatus();
          }
        }).catch(() => {});
      }
    } catch (error) {
      $("boot-text").textContent = "读取失败：" + (error && error.message ? error.message : error);
      $("boot-hint").textContent = "请确认 ~/.codex/sessions、WorkBuddy 与 Antigravity 目录存在";
    } finally {
      button.dataset.busy = "0";
    }
  }

  function hideBoot() {
    const boot = $("boot");
    if (boot.classList.contains("done")) return;
    boot.classList.add("done");
    setTimeout(() => { boot.style.display = "none"; }, 320);
  }

  // --------------------------------------------------------------- 实时额度（本机 Codex 授权）
  function authMsg(text, isErr) {
    const node = $("a-msg");
    if (!node) return;
    node.textContent = text || "";
    node.hidden = !text;
    node.className = "m-msg" + (isErr ? " err" : "");
  }

  function fmtReset(resetsAt) {
    if (!resetsAt) return "";
    const d = new Date(Number(resetsAt) * 1000);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  }

  let lastCodexAuthData = { accounts: [] };

  function syncAuthTopLabel() {
    const label = $("auth-top-label");
    const dot = $("auth-dot");
    if (!label || !dot) return;
    if (state.source === "antigravity") {
      const agyQuota = state.status && state.status.antigravityQuota;
      const g = agyQuota && agyQuota.gemini && agyQuota.gemini.primary;
      const t = agyQuota && agyQuota.thirdParty && agyQuota.thirdParty.primary;
      const pick = g && t ? (g.usedPercent >= t.usedPercent ? g : t) : (g || t);
      if (pick) {
        label.textContent = "额度 " + Math.round(pick.usedPercent) + "%";
        dot.hidden = false;
        return;
      }
    }
    const accounts = Array.isArray(lastCodexAuthData.accounts) ? lastCodexAuthData.accounts : [];
    const active = accounts.find(a => a.id === lastCodexAuthData.activeId && a.quota);
    if (active && active.quota && active.quota.session) {
      label.textContent = "额度 " + Math.round(active.quota.session.usedPercent) + "%";
      dot.hidden = false;
      return;
    }
    const statusCodex = state.status && state.status.quota;
    if (statusCodex && statusCodex.source === "api" && statusCodex.session) {
      label.textContent = "额度 " + Math.round(statusCodex.session.usedPercent) + "%";
      dot.hidden = false;
      return;
    }
    label.textContent = "实时额度";
    dot.hidden = true;
  }

  async function loadAuthAccounts() {
    const d = window.dashboard;
    if (!d) return;
    try {
      const [codexData, agyData] = await Promise.all([
        d.codexAuthList ? d.codexAuthList() : Promise.resolve({ accounts: [] }),
        d.antigravityAuthList ? d.antigravityAuthList() : Promise.resolve({ accounts: [] })
      ]);
      renderAuthAccounts(codexData || { accounts: [] });
      renderAgyAuthAccounts(agyData || { accounts: [] });
    } catch (e) {
      $("a-badge").textContent = "读取失败";
      authMsg(String(e && e.message ? e.message : e), true);
    }
  }

  let showHiddenAccounts = false;

  function renderAuthAccounts(data) {
    lastCodexAuthData = data || { accounts: [] };
    const accounts = Array.isArray(data.accounts) ? data.accounts : [];
    const activeId = data.activeId;
    const hiddenCount = Number(data.hiddenCount) || accounts.filter(a => a.isHidden).length;
    const badge = $("a-badge");
    // 顶部标签：显示当前激活账号的实时额度来源（隐藏的账号不影响额度展示）
    const active = accounts.find(a => a.id === activeId && a.quota);
    if (active && active.quota && active.quota.session) {
      badge.textContent = "实时 · " + active.email;
      badge.className = "m-badge done";
    } else {
      badge.textContent = accounts.length ? accounts.length + " 个账号" : "未检测到账号";
      badge.className = "m-badge";
    }
    syncAuthTopLabel();

    // 隐藏账号数量条：有隐藏账号时给出恢复入口
    const hiddenBar = $("a-hidden-bar");
    hiddenBar.hidden = hiddenCount === 0;
    $("a-toggle-hidden").textContent = showHiddenAccounts
      ? "隐藏已显示的 " + hiddenCount + " 个账号"
      : "显示已隐藏的 " + hiddenCount + " 个账号";

    const list = $("a-accounts");
    const visible = accounts.filter(a => showHiddenAccounts || !a.isHidden);
    if (!visible.length) {
      list.innerHTML = '<div class="m-sub" style="margin:0 0 4px">' +
        (accounts.length ? "当前列表为空，点上方按钮可查看已隐藏账号。" : "没有检测到本机 Codex 授权。请先用 CC Switch 或 Codex CLI 登录。") + '</div>';
      return;
    }
    list.innerHTML = visible.map(a => {
      const q = a.quota;
      const live = Boolean(q && q.session);
      const tag = a.isHidden
        ? '<span class="q-tag">已隐藏</span>'
        : a.error ? '<span class="q-tag err">失败</span>'
        : live ? '<span class="q-tag live">实时</span>' : '<span class="q-tag">未查询</span>';
      const detail = live
        ? '<div class="q-quota">5 小时 <b>' + Math.round(q.session.usedPercent) + '%</b>' +
          (q.session.resetsAt ? ' · 重置 ' + fmtReset(q.session.resetsAt) : '') +
          (q.weekly ? ' ｜ 每周 <b>' + Math.round(q.weekly.usedPercent) + '%</b>' : '') +
          '</div>'
        : (a.error ? '<div class="q-quota">' + escapeHtml(a.error) + '</div>' : '<div class="q-quota">点击查询官方实时额度</div>');
      const hideBtn = '<button class="q-hide" data-hide="' + escapeHtml(a.id) + '" ' +
        (a.isHidden ? 'data-action="unhide"' : 'data-action="hide"') + ' title="' +
        (a.isHidden ? '恢复显示' : '从看板隐藏（不删本机文件）') + '">' +
        (a.isHidden ? '恢复' : '隐藏') + '</button>';
      return '<div class="m-acct q-acct' + (a.id === activeId ? ' is-active' : '') +
        (a.isHidden ? ' is-hidden' : '') + '" data-id="' + escapeHtml(a.id) + '">' +
        '<div style="flex:1;min-width:0">' +
        '<div class="m-mail">' + escapeHtml(a.email) + (a.id === activeId ? ' <span class="q-tag">当前</span>' : '') + '</div>' +
        detail + '</div>' + tag + hideBtn + '</div>';
    }).join("");
  }

  function renderAgyAuthAccounts(data) {
    const list = $("agy-accounts");
    const badge = $("agy-badge");
    if (!list || !badge) return;
    const accounts = Array.isArray(data && data.accounts) ? data.accounts : [];
    const activeId = data && data.activeId;
    const active = accounts.find(a => a.id === activeId && a.quota) || accounts.find(a => a.quota);
    if (active && active.quota) {
      badge.textContent = "实时" + (active.planType ? " · " + active.planType : "");
      badge.className = "m-badge done";
    } else {
      badge.textContent = accounts.length ? accounts.length + " 个账号" : "未检测到登录";
      badge.className = "m-badge";
    }

    if (!accounts.length) {
      list.innerHTML = '<div class="m-sub" style="margin:0 0 4px">没有检测到本机 Antigravity 登录凭据（gemini:antigravity）。</div>';
      return;
    }

    list.innerHTML = accounts.map(a => {
      const q = a.quota;
      const g = q && q.gemini;
      const t = q && q.thirdParty;
      const live = Boolean(q && (g || t));
      const tag = a.error ? '<span class="q-tag err">失败</span>'
        : live ? '<span class="q-tag live">' + escapeHtml(a.planType || "实时") + '</span>'
        : '<span class="q-tag">未查询</span>';
      let detail = '<div class="q-quota">点击查询 Antigravity 实时额度</div>';
      if (live) {
        const lines = [];
        if (g) {
          lines.push("Gemini: " + (g.fiveHour ? "5h 剩 <b>" + Math.round(g.fiveHour.remainingPercent) + "%</b>" : "") +
            (g.weekly ? (g.fiveHour ? " / " : "") + "周剩 <b>" + Math.round(g.weekly.remainingPercent) + "%</b>" : "") +
            (g.argonWeekly ? " / Argon <b>" + Math.round(g.argonWeekly.remainingPercent) + "%</b>" : ""));
        }
        if (t) {
          lines.push("Claude/GPT: " + (t.fiveHour ? "5h 剩 <b>" + Math.round(t.fiveHour.remainingPercent) + "%</b>" : "") +
            (t.weekly ? (t.fiveHour ? " / " : "") + "周剩 <b>" + Math.round(t.weekly.remainingPercent) + "%</b>" : ""));
        }
        detail = '<div class="q-quota">' + lines.join(" ｜ ") + '</div>';
      } else if (a.error) {
        detail = '<div class="q-quota">' + escapeHtml(a.error) + '</div>';
      }
      return '<div class="m-acct q-acct agy-acct' + (a.id === activeId ? ' is-active' : '') +
        '" data-agy-id="' + escapeHtml(a.id) + '">' +
        '<div style="flex:1;min-width:0">' +
        '<div class="m-mail">' + escapeHtml(a.email || "Antigravity") + (a.id === activeId ? ' <span class="q-tag">当前</span>' : '') + '</div>' +
        detail + '</div>' + tag + '</div>';
    }).join("");
  }

  async function doFetchAgyQuota(accountId) {
    const d = window.dashboard;
    if (!d || !d.antigravityAuthFetch) return;
    authMsg("正在向 Google 查询 Antigravity 额度…");
    try {
      const result = await d.antigravityAuthFetch(accountId, { force: true });
      authMsg("已更新 " + (result.email || "Antigravity") + " 的实时额度。");
      if (d.getStatus) {
        d.getStatus().then(status => {
          if (status) { state.status = status; renderStats(); renderStatus(); }
        }).catch(() => {});
      }
      loadAuthAccounts();
    } catch (e) {
      authMsg("Antigravity 查询失败：" + (e && e.message ? e.message : String(e)), true);
      loadAuthAccounts();
    }
  }

  function openAuthModal() { $("auth-modal").hidden = false; loadAuthAccounts(); }
  function closeAuthModal() { $("auth-modal").hidden = true; }

  async function doFetchQuota(accountId) {
    const d = window.dashboard;
    if (!d || !d.codexAuthFetch) return;
    authMsg("正在向官方查询额度…");
    try {
      const result = await d.codexAuthFetch(accountId, { force: true });
      authMsg("已更新 " + result.email + " 的实时额度，看板额度卡已同步。");
      // 用实时额度刷新看板顶部的状态与额度卡
      if (window.dashboard.getStatus) {
        window.dashboard.getStatus().then(status => {
          if (status) { state.status = status; renderStats(); renderStatus(); }
        }).catch(() => {});
      }
      loadAuthAccounts();
    } catch (e) {
      authMsg("查询失败：" + (e && e.message ? e.message : String(e)), true);
      loadAuthAccounts();
    }
  }

  // ---- OAuth 设备码授权（配对码只在主进程内存，界面只显示码与网址） ----
  let devSession = null;
  let devicePollTimer = null;
  let devicePolling = false;

  function devStatus(text, kind) {
    const node = $("a-dev-status");
    node.textContent = text;
    node.className = "dev-status" + (kind ? " " + kind : "");
  }

  // 幂等：启动新定时器前先清掉旧的；隐藏页面 / 关闭面板时也会调用
  function stopDevicePolling() {
    if (devicePollTimer) { clearInterval(devicePollTimer); devicePollTimer = null; }
  }

  async function closeDevicePanel(notifyMain) {
    stopDevicePolling();
    const sessionId = devSession;
    // 先断开会话：进行中的 poll 结果（以及取消导致的 reject）一律忽略
    devSession = null;
    if (sessionId && notifyMain && window.dashboard.codexAuthDeviceCancel) {
      try { await window.dashboard.codexAuthDeviceCancel(sessionId); } catch { /* 忽略 */ }
    }
    $("a-dev-panel").hidden = true;
  }

  async function startDeviceAuth() {
    const d = window.dashboard;
    if (!d || !d.codexAuthDeviceStart) return;
    authMsg("正在申请一次性配对码…");
    try {
      const session = await d.codexAuthDeviceStart();
      devSession = session.sessionId;
      $("a-dev-code").textContent = session.userCode;
      $("a-dev-url").href = session.verifyUrl;
      $("a-dev-url").textContent = session.verifyUrl;
      $("a-dev-panel").hidden = false;
      authMsg("");
      devStatus("等待你在浏览器完成授权（每 " + session.intervalSec + " 秒自动检查一次）…", "busy");
      // 打开官方验证页（新浏览器窗口；token 不会经过本应用）
      if (d.openExternal) d.openExternal(session.verifyUrl);
      const intervalMs = Math.max(3, Number(session.intervalSec) || 5) * 1000;
      stopDevicePolling();
      devicePollTimer = setInterval(() => pollDeviceAuth(), intervalMs);
    } catch (e) {
      authMsg("申请配对码失败：" + (e && e.message ? e.message : String(e)), true);
    }
  }

  async function pollDeviceAuth() {
    const d = window.dashboard;
    if (!devSession || !d || !d.codexAuthDevicePoll) return;
    if (devicePolling) return; // 上一轮还在飞就跳过，避免定时器重入
    devicePolling = true;
    const sessionId = devSession;
    try {
      const result = await d.codexAuthDevicePoll(sessionId);
      if (devSession !== sessionId) return; // 面板已关或已换会话，丢弃迟到结果
      if (result.status === "pending") {
        devStatus("尚未授权，等待中…", "busy");
        return;
      }
      if (result.status === "denied") {
        devStatus("已拒绝授权，请重新点「OAuth 授权添加账号」。", "");
        await closeDevicePanel(false);
        return;
      }
      if (result.status === "expired") {
        devStatus("配对码已过期，请重新点「OAuth 授权添加账号」。", "");
        await closeDevicePanel(false);
        return;
      }
      if (result.status === "success") {
        devStatus("授权成功，已保存到本机。", "done");
        authMsg("已授权 " + (result.email || "新账号") +
          (result.quota && result.quota.session ? "，5 小时已用 " + Math.round(result.quota.session.usedPercent) + "%" : (result.quotaError ? "（额度查询：" + result.quotaError + "）" : "")) + "。", false);
        await closeDevicePanel(false);
        loadAuthAccounts();
        // 若授权的是当前激活账号，顺手刷新看板实时额度
        if (window.dashboard.getStatus) {
          window.dashboard.getStatus().then(status => {
            if (status) { state.status = status; renderStats(); renderStatus(); }
          }).catch(() => {});
        }
      }
    } catch (e) {
      // 主进程 cancelDeviceAuth() 会让进行中的 poll reject：面板已关就静默忽略，
      // 不再每次取消都刷一条「检查失败」
      if (devSession === sessionId) {
        devStatus("检查失败：" + (e && e.message ? e.message : String(e)), "");
      }
    } finally {
      devicePolling = false;
    }
  }

  function bindAuth() {
    $("btn-auth").addEventListener("click", openAuthModal);
    $("a-close").addEventListener("click", () => { closeDevicePanel(true); closeAuthModal(); });
    $("auth-modal").addEventListener("click", event => { if (event.target === $("auth-modal")) { closeDevicePanel(true); closeAuthModal(); } });
    $("a-refresh").addEventListener("click", () => loadAuthAccounts());
    $("a-oauth-add").addEventListener("click", startDeviceAuth);
    $("a-toggle-hidden").addEventListener("click", () => {
      showHiddenAccounts = !showHiddenAccounts;
      loadAuthAccounts();
    });
    $("a-dev-cancel").addEventListener("click", () => { closeDevicePanel(true); authMsg("已取消授权。"); });
    $("a-dev-open").addEventListener("click", () => {
      const url = $("a-dev-url").href;
      if (window.dashboard.openExternal) window.dashboard.openExternal(url);
    });
    $("a-dev-copy").addEventListener("click", async () => {
      const code = $("a-dev-code").textContent;
      try { await navigator.clipboard.writeText(code); authMsg("配对码已复制。"); }
      catch { authMsg("复制失败，请手动选中配对码复制。", true); }
    });
    $("a-accounts").addEventListener("click", async event => {
      // 隐藏 / 恢复按钮：只改 TokenBar 的清单，不碰本机授权文件
      const hideBtn = event.target.closest(".q-hide");
      if (hideBtn) {
        event.stopPropagation();
        const id = hideBtn.getAttribute("data-hide");
        const restoring = hideBtn.getAttribute("data-action") === "unhide";
        const d = window.dashboard;
        if (!d || !(restoring ? d.codexAuthUnhide : d.codexAuthHide)) return;
        try {
          await (restoring ? d.codexAuthUnhide(id) : d.codexAuthHide(id));
          authMsg(restoring ? "已恢复显示该账号。" : "已从看板隐藏该账号（本机授权文件未改动）。");
          loadAuthAccounts();
        } catch (e) {
          authMsg("操作失败：" + (e && e.message ? e.message : String(e)), true);
        }
        return;
      }
      const row = event.target.closest(".q-acct");
      if (!row) return;
      doFetchQuota(row.getAttribute("data-id"));
    });
    const agyList = $("agy-accounts");
    if (agyList) {
      agyList.addEventListener("click", event => {
        const row = event.target.closest(".agy-acct");
        if (!row) return;
        doFetchAgyQuota(row.getAttribute("data-agy-id"));
      });
    }
    // 页面隐藏时停止设备码轮询，避免后台空转 / 取消时刷错误
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) stopDevicePolling();
    });
    document.addEventListener("keydown", event => {
      if (event.key === "Escape" && !$("auth-modal").hidden) { closeDevicePanel(true); closeAuthModal(); }
    });
  }
