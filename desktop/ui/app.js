  // --------------------------------------------------------------- 科研通签到
  function signMsg(text, isErr) {
    const node = $("m-msg");
    if (!node) return;
    node.textContent = text || "";
    node.hidden = !text;
    node.className = "m-msg" + (isErr ? " err" : "");
  }

  async function loadAbleSci() {
    const d = window.dashboard;
    if (!d || !d.ablesciList) return;
    try {
      const data = await d.ablesciList();
      renderAbleSci(data || { accounts: [] });
    } catch {
      $("m-badge").textContent = "读取失败";
    }
  }

  function renderAbleSci(data) {
    const accounts = Array.isArray(data.accounts) ? data.accounts : [];
    const signed = accounts.filter(a => a.signedToday).length;
    // 顶栏按钮状态
    const dot = $("sign-dot");
    if (accounts.length === 0) {
      $("sign-top-label").textContent = "科研通签到";
      dot.hidden = true;
    } else if (signed === accounts.length) {
      $("sign-top-label").textContent = "今日已签 ✓";
      dot.hidden = false;
    } else {
      $("sign-top-label").textContent = `签到 ${signed}/${accounts.length}`;
      dot.hidden = true;
    }
    // 徽标
    const badge = $("m-badge");
    if (!accounts.length) { badge.textContent = "未配置"; badge.className = "m-badge"; }
    else if (signed === accounts.length) { badge.textContent = "今日已签 ✓"; badge.className = "m-badge done"; }
    else { badge.textContent = `${signed}/${accounts.length} 已签`; badge.className = "m-badge todo"; }
    $("m-sub").textContent = accounts.length
      ? `${accounts.length} 个账号 · ${signed} 已签`
      : "本机加密保存";
    $("m-sign").textContent = accounts.length ? "立即签到" : "添加账号";
    // 账号列表
    const list = $("m-accounts");
    if (!accounts.length) {
      list.innerHTML = '<div class="m-sub" style="margin:0 0 4px">还没有账号，在下方添加。</div>';
    } else {
      list.innerHTML = accounts.map(a => {
        const meta = [];
        if (a.points !== "" && a.points != null) meta.push('积分 <b>' + escapeHtml(a.points) + '</b>');
        if (a.signDays !== "" && a.signDays != null) meta.push('连续 ' + escapeHtml(a.signDays) + ' 天');
        if (!meta.length) meta.push('积分待更新 · 点签到获取');
        return [
          '<div class="m-acct">',
          '  <span style="flex:1;min-width:0">',
          '    <span class="m-mail">' + escapeHtml(a.masked) + '</span>',
          '    <div class="m-meta">' + meta.join(' · ') + '</div>',
          '  </span>',
          '  <span class="m-state' + (a.signedToday ? ' ok' : '') + '">' + (a.signedToday ? '今日已签 ✓' : '待签到') + '</span>',
          '  <button class="m-del" data-id="' + escapeHtml(a.id) + '" title="删除账号" aria-label="删除">×</button>',
          '</div>'
        ].join("");
      }).join("");
    }
  }

  function openSignModal() { $("sign-modal").hidden = false; loadAbleSci(); }
  function closeSignModal() { $("sign-modal").hidden = true; }

  async function doSign() {
    const d = window.dashboard;
    const btn = $("m-sign");
    const state = await d.ablesciList().catch(() => ({ accounts: [] }));
    if (!state.accounts || !state.accounts.length) {
      $("m-email").focus();
      signMsg("请先在下方添加一个科研通账号", true);
      return;
    }
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = "签到中…";
    signMsg("");
    try {
      const result = await d.ablesciSign();
      if (!result || !result.results) { signMsg(result && result.summary || "签到未返回结果", true); return; }
      const lines = result.results.map(r => {
        const extra = (r.points !== "" && r.points != null)
          ? "（积分 " + r.points + (r.signDays !== "" && r.signDays != null ? " · 连续 " + r.signDays + " 天" : "") + "）"
          : "";
        return (r.ok ? "✓ " : "✗ ") + (r.masked || "账号") + "  " + r.msg + extra;
      });
      signMsg(result.summary + "\n" + lines.join("\n"), result.results.some(r => !r.ok));
      await loadAbleSci();
    } catch (e) {
      signMsg("签到失败：" + (e && e.message ? e.message : String(e)), true);
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  }

  async function addAbleSciAccount() {
    const d = window.dashboard;
    const email = $("m-email").value.trim();
    const password = $("m-password").value;
    if (!email || !password) { signMsg("请填写邮箱和密码", true); return; }
    const btn = $("m-add");
    btn.disabled = true;
    try {
      const data = await d.ablesciAdd(email, password);
      $("m-email").value = "";
      $("m-password").value = "";
      renderAbleSci(data || { accounts: [] });
      signMsg("账号已添加，密码已加密保存在本机");
    } catch (e) {
      signMsg("添加失败：" + (e && e.message ? e.message : String(e)), true);
    } finally {
      btn.disabled = false;
    }
  }

  function bindSign() {
    $("btn-sign").addEventListener("click", openSignModal);
    $("m-close").addEventListener("click", closeSignModal);
    $("sign-modal").addEventListener("click", event => { if (event.target === $("sign-modal")) closeSignModal(); });
    $("m-sign").addEventListener("click", doSign);
    $("m-add").addEventListener("click", addAbleSciAccount);
    $("m-email").addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); addAbleSciAccount(); } });
    $("m-password").addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); addAbleSciAccount(); } });
    $("m-open-site").addEventListener("click", () => window.dashboard.ablesciOpenSite && window.dashboard.ablesciOpenSite());
    $("m-accounts").addEventListener("click", async event => {
      const del = event.target.closest(".m-del");
      if (!del) return;
      try {
        const data = await window.dashboard.ablesciRemove(del.getAttribute("data-id"));
        renderAbleSci(data || { accounts: [] });
        signMsg("账号已删除");
      } catch (e) {
        signMsg("删除失败：" + (e && e.message ? e.message : String(e)), true);
      }
    });
    document.addEventListener("keydown", event => { if (event.key === "Escape" && !$("sign-modal").hidden) closeSignModal(); });
  }

  function bindButtons() {
    $("btn-refresh").addEventListener("click", () => load({ refresh: true }));
    // 会话汇总 / 请求明细两个视图，选择会记住；切视图时收起行内展开
    $("session-tabs").addEventListener("click", event => {
      const button = event.target.closest("button[data-view]");
      if (!button) return;
      state.logView = button.dataset.view;
      localStorage.setItem("codex.logView", state.logView);
      state.openSession = null;
      renderSessions();
    });
    // 点分布行展开四档明细；两个容器共用，重渲染不会重复绑定
    const toggleBarDetail = event => {
      const row = event.target.closest(".bar-row");
      if (!row || !row.querySelector(".bar-detail")) return;
      const key = event.currentTarget === $("models") ? "models" : "projects";
      const name = row.dataset.name;
      state.openBars[key] = state.openBars[key] === name ? null : name;
      if (key === "models") renderModels();
      else renderProjects();
    };
    $("models").addEventListener("click", toggleBarDetail);
    $("projects").addEventListener("click", toggleBarDetail);

    // V3.5：多 Agent 汇总条点击跳转、趋势形态/指标切换、环形图联动、会话筛选
    const syncPressed = (container, attr, val) => {
      if (!container) return;
      for (const btn of container.querySelectorAll("button")) {
        btn.setAttribute("aria-pressed", String(btn.getAttribute(attr) === val));
      }
    };
    const chartTypeEl = $("chart-type");
    if (chartTypeEl) {
      syncPressed(chartTypeEl, "data-type", state.chartType);
      chartTypeEl.addEventListener("click", event => {
        const btn = event.target.closest("button[data-type]");
        if (!btn || btn.dataset.type === state.chartType) return;
        state.chartType = btn.dataset.type;
        localStorage.setItem("codex.chartType", state.chartType);
        syncPressed(chartTypeEl, "data-type", state.chartType);
        renderChart();
      });
    }
    const chartMetricEl = $("chart-metric");
    if (chartMetricEl) {
      syncPressed(chartMetricEl, "data-metric", state.chartMetric);
      chartMetricEl.addEventListener("click", event => {
        const btn = event.target.closest("button[data-metric]");
        if (!btn || btn.dataset.metric === state.chartMetric) return;
        state.chartMetric = btn.dataset.metric;
        localStorage.setItem("codex.chartMetric", state.chartMetric);
        syncPressed(chartMetricEl, "data-metric", state.chartMetric);
        renderChart();
      });
    }
    const agentStrip = $("agent-strip");
    if (agentStrip) {
      agentStrip.addEventListener("click", event => {
        const jump = event.target.closest("[data-jump]");
        if (!jump) return;
        const btn = $("source").querySelector('button[data-source="' + jump.dataset.jump + '"]');
        if (btn) btn.click();
      });
    }
    const bindDonut = (donutId, barKey, listId, renderer) => {
      const box = $(donutId);
      if (!box) return;
      box.addEventListener("click", event => {
        const pick = event.target.closest("[data-pick]");
        if (!pick) return;
        const name = pick.dataset.pick;
        state.openBars[barKey] = state.openBars[barKey] === name ? null : name;
        renderer();
        const row = [...$(listId).querySelectorAll(".bar-row")].find(r => r.dataset.name === name);
        if (row) row.scrollIntoView({ block: "nearest", behavior: "smooth" });
      });
      box.addEventListener("mouseover", event => {
        const node = event.target.closest("[data-idx]");
        if (!node) return;
        const idx = node.dataset.idx;
        for (const s of box.querySelectorAll(".donut-slice")) {
          s.classList.toggle("is-dim", s.dataset.idx !== idx);
        }
      });
      box.addEventListener("mouseleave", () => {
        for (const s of box.querySelectorAll(".donut-slice")) s.classList.remove("is-dim");
      });
    };
    bindDonut("model-donut", "models", "models", renderModels);
    bindDonut("project-donut", "projects", "projects", renderProjects);

    const searchInput = $("session-search");
    if (searchInput) {
      searchInput.addEventListener("input", () => {
        state.sessionQuery = searchInput.value;
        renderSessions();
      });
    }
    // 点会话行展开该会话的模型明细（对齐 CC Switch 请求日志的点开形式）
    $("session-body").addEventListener("click", event => {
      const row = event.target.closest("tr.session-row");
      if (!row) return;
      const id = row.dataset.session;
      state.openSession = state.openSession === id ? null : id;
      renderSessionRows();
    });
    $("theme-switch").addEventListener("click", event => {
      const btn = event.target.closest("button[data-theme]");
      if (!btn || !btn.dataset.theme) return;
      state.theme = btn.dataset.theme;
      localStorage.setItem("codex.theme", state.theme);
      themeExplicit = true;
      applyTheme();
      renderAll();
    });
    $("btn-sessions").addEventListener("click", () => {
      if (state.source === "workbuddy" && window.dashboard.openWorkBuddy) window.dashboard.openWorkBuddy();
      else if (state.source === "antigravity" && window.dashboard.openAntigravity) window.dashboard.openAntigravity();
      else window.dashboard.openSessions();
    });
    // 版本号可点：直接在浏览器打开仓库，方便确认「这是哪一版」
    $("app-ver").addEventListener("click", () => {
      const repo = state.meta && state.meta.repo;
      if (repo && window.dashboard.openExternal) window.dashboard.openExternal(repo);
    });
  }

  let resizeTimer;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (state.detail) renderChart();
    }, 120);
  });

  // ---------------------------------------------------------------------
  // 启动
  // ---------------------------------------------------------------------
  // 系统主题变了就跟随；用户手动选过「月之亮面 / 月之暗面」则尊重显式偏好
  if (themeQuery) {
    const onSystemThemeChange = event => {
      if (themeExplicit) return;
      state.theme = event.matches ? "dark" : "light";
      applyTheme();
      renderAll();
    };
    if (themeQuery.addEventListener) themeQuery.addEventListener("change", onSystemThemeChange);
    else if (themeQuery.addListener) themeQuery.addListener(onSystemThemeChange);
  }
  applyTheme();
  buildRangeTabs();
  buildHourTabs();
  buildSourceTabs();
  bindButtons();
  bindSign();
  bindAuth();
  loadAbleSci();
  bindChartHover();

  if (window.dashboard) {
    window.dashboard.onProgress(progress => {
      if (!progress || !progress.total) return;
      const percent = Math.max(6, Math.round((progress.index / progress.total) * 100));
      $("boot-fill").style.width = percent + "%";
      $("boot-text").textContent = "正在解析日志 " + progress.index + " / " + progress.total;
    });
    window.dashboard.getMeta().then(meta => {
      state.meta = meta;
      if (meta && meta.version) $("app-ver").textContent = "v" + meta.version;
    }).catch(() => {});
    window.dashboard.getStatus().then(status => {
      state.status = status;
      if (status) renderStats();
    }).catch(() => {});
    // 主进程后台取到实时额度后会推 status；订阅进来让额度卡自动变「实时」
    if (window.dashboard.onStatus) {
      window.dashboard.onStatus(status => {
        if (!status) return;
        state.status = status;
        renderStats();
      });
    }
    load().catch(() => {});
  } else {
    $("boot-text").textContent = "桥接未加载：请通过桌面应用启动";
  }
})();