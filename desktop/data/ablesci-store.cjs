/**
 * 科研通（AbleSci）签到数据层
 *
 * 职责：
 *  - 多账号凭证的本地存储（邮箱明文 + 密码由 Electron safeStorage 加密，
 *    加密器由调用方注入，便于在纯 Node 测试里替换）
 *  - 签到状态记录（今日是否已签、积分、连续天数，非敏感，明文）
 *  - 登录 + 签到流程（GET 登录页取 meta csrf + 收 cookie → POST 登录 → GET /user/sign）
 *
 * 接口探测（2026-11-19）：
 *  - 登录页 GET https://www.ablesci.com/site/login → <meta name="csrf-token" content="...">
 *    同时下发 security_session_verify / advanced-frontend / _csrf 三个 cookie。
 *  - 登录 POST https://www.ablesci.com/site/login
 *    body: _csrf=<meta token>&email=<邮箱>&password=<密码>&remember=off
 *    header: X-Requested-With: XMLHttpRequest，Content-Type: application/x-www-form-urlencoded
 *    成功：JSON { code: 0, msg }；非 JSON 时响应含「退出」也算成功。
 *  - 签到 GET https://www.ablesci.com/user/sign （复用登录 session 的 cookie）
 *    成功：{ code: 0, msg: '签到成功，...', data: { points, sign_days } }
 *    已签：{ code: 非0, msg: '签到失败，您今天已于...' }
 *
 * Node 的 fetch 不会自动管理 cookie，这里手动维护一个 cookie jar。
 */

const BASE = "https://www.ablesci.com";
const LOGIN_URL = BASE + "/site/login";
const SIGN_URL = BASE + "/user/sign";
const HOME_URL = BASE + "/";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
  + "(KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";

const ACCOUNTS_VERSION = 1;
const STATE_VERSION = 1;

function nowIso() { return new Date().toISOString(); }

/** 北京时间日期 YYYY-MM-DD（签到「今天」按北京时间算） */
function beijingDate(d = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(d);
  return parts; // en-CA 输出 YYYY-MM-DD
}

function readJson(file, fallback) {
  try {
    const text = require("node:fs").readFileSync(file, "utf8");
    const value = JSON.parse(text);
    return value && typeof value === "object" ? value : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  const fs = require("node:fs");
  const path = require("node:path");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** 脱敏邮箱：ab***@domain */
function maskEmail(email) {
  const s = String(email || "");
  const at = s.indexOf("@");
  if (at <= 0) return s ? s.slice(0, 2) + "***" : "***";
  const head = s.slice(0, at);
  return (head.length > 2 ? head.slice(0, 2) : head) + "***" + s.slice(at);
}

/** 极简 cookie jar：Node fetch 不自动带 cookie，登录会话要手动维护 */
function createCookieJar() {
  const jar = new Map();
  return {
    absorb(headers) {
      if (!headers) return;
      let lines = [];
      if (typeof headers.getSetCookie === "function") lines = headers.getSetCookie();
      else {
        const one = typeof headers.get === "function" ? headers.get("set-cookie") : null;
        if (one) lines = [one];
      }
      for (const line of lines) {
        const pair = String(line).split(";")[0];
        const idx = pair.indexOf("=");
        if (idx > 0) jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
      }
    },
    header() {
      return [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    },
    get size() { return jar.size; }
  };
}

function parseCsrf(html) {
  const text = String(html || "");
  // 优先 meta name="csrf-token" content="..."
  const meta = text.match(/<meta[^>]*name=["']csrf-token["'][^>]*content=["']([^"']+)["']/i)
    || text.match(/<meta[^>]*content=["']([^"']+)["'][^>]*name=["']csrf-token["']/i);
  if (meta && meta[1]) return meta[1];
  // 回退 input[name=_csrf]
  const input = text.match(/<input[^>]*name=["']_csrf["'][^>]*value=["']([^"']+)["']/i)
    || text.match(/<input[^>]*value=["']([^"']+)["'][^>]*name=["']_csrf["']/i);
  return input && input[1] ? input[1] : "";
}

/**
 * @param {object} options
 * @param {string} options.accountsFile 账号凭证文件路径
 * @param {string} options.stateFile 签到状态文件路径
 * @param {object} options.cipher { encrypt(str): string, decrypt(str): string } safeStorage 包装
 * @param {function} [options.fetchImpl] 可注入的 fetch（测试用），默认全局 fetch
 */
function createAbleSciStore({ accountsFile, stateFile, cipher, fetchImpl }) {
  const doFetch = fetchImpl || ((...args) => fetch(...args));
  if (!cipher || typeof cipher.encrypt !== "function" || typeof cipher.decrypt !== "function") {
    throw new Error("cipher 必须提供 encrypt/decrypt");
  }

  function loadAccounts() {
    const data = readJson(accountsFile, null);
    if (!data || !Array.isArray(data.accounts)) return { version: ACCOUNTS_VERSION, accounts: [] };
    return data;
  }

  function loadState() {
    const data = readJson(stateFile, null);
    if (!data || typeof data.records !== "object" || !data.records) {
      return { version: STATE_VERSION, records: {} };
    }
    return data;
  }

  function list() {
    const state = loadState();
    const today = beijingDate();
    return {
      // email 仅用于内部查状态，输出对象里只带 id/masked，明文不出数据层
      accounts: loadAccounts().accounts.map(a => {
        const rec = state.records[a.email] || {};
        return {
          id: a.id,
          masked: maskEmail(a.email),
          signedToday: rec.lastSignDate === today,
          lastResult: rec.lastResult || "",
          lastMsg: rec.lastMsg || "",
          lastSignDate: rec.lastSignDate || "",
          points: rec.points || "",
          signDays: rec.signDays || ""
        };
      }),
      today
    };
  }

  function addAccount(email, password) {
    const mail = String(email || "").trim();
    const pass = String(password || "");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) throw new Error("邮箱格式不正确");
    if (!pass) throw new Error("密码不能为空");
    const data = loadAccounts();
    if (data.accounts.some(a => a.email.toLowerCase() === mail.toLowerCase())) {
      throw new Error("该账号已存在");
    }
    data.version = ACCOUNTS_VERSION;
    data.accounts.push({ id: newId(), email: mail, secret: cipher.encrypt(pass) });
    writeJson(accountsFile, data);
    return list();
  }

  function removeAccount(id) {
    const data = loadAccounts();
    const before = data.accounts.length;
    data.accounts = data.accounts.filter(a => a.id !== id);
    if (data.accounts.length === before) throw new Error("未找到该账号");
    writeJson(accountsFile, data);
    return list();
  }

  /** 单个账号：登录 → 签到。fetchOverride 便于测试注入假网络层 */
  async function signOne(account, fetchOverride) {
    const fetchFn = typeof fetchOverride === "function" ? fetchOverride : doFetch;
    const started = Date.now();
    let password;
    try {
      password = cipher.decrypt(account.secret);
    } catch (e) {
      return { masked: maskEmail(account.email), ok: false, msg: "凭证解密失败，请删除后重新添加" };
    }

    try {
      // 1) 登录页：收 cookie + 取 csrf
      const pageResp = await fetchFn(LOGIN_URL, {
        headers: { "User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9" },
        redirect: "manual"
      });
      const jar = createCookieJar();
      jar.absorb(pageResp.headers);
      const html = await pageResp.text();
      const csrf = parseCsrf(html);
      if (!csrf) {
        return { masked: maskEmail(account.email), ok: false, msg: "登录页未找到令牌，站点可能改版" };
      }

      // 2) 登录
      const body = new URLSearchParams({
        _csrf: csrf, email: account.email, password, remember: "off"
      }).toString();
      const loginResp = await fetchFn(LOGIN_URL, {
        method: "POST",
        headers: {
          "User-Agent": UA,
          "Accept-Language": "zh-CN,zh;q=0.9",
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          "X-Requested-With": "XMLHttpRequest",
          "Referer": LOGIN_URL,
          "Cookie": jar.header()
        },
        body,
        redirect: "manual"
      });
      jar.absorb(loginResp.headers);
      const loginText = await loginResp.text();
      let loggedIn = false;
      let loginMsg = "";
      try {
        const j = JSON.parse(loginText);
        loggedIn = j.code === 0;
        loginMsg = j.msg || "";
      } catch {
        loggedIn = loginText.includes("退出");
      }
      if (!loggedIn) {
        const needCaptcha = /验证码|captcha|verify/i.test(loginText);
        return {
          masked: maskEmail(account.email),
          ok: false,
          msg: needCaptcha ? "登录触发验证码，请在浏览器手动签到一次" : (loginMsg || "登录失败，请检查邮箱和密码")
        };
      }

      // 3) 签到
      const signResp = await fetchFn(SIGN_URL, {
        headers: {
          "User-Agent": UA,
          "Accept-Language": "zh-CN,zh;q=0.9",
          "X-Requested-With": "XMLHttpRequest",
          "Referer": HOME_URL,
          "Cookie": jar.header()
        },
        redirect: "manual"
      });
      const signText = await signResp.text();
      let result;
      try {
        const j = JSON.parse(signText);
        const msg = String(j.msg || "");
        if (j.code === 0) {
          result = {
            ok: true,
            signed: true,
            msg: msg || "签到成功",
            points: j.data && j.data.points,
            signDays: j.data && (j.data.sign_days ?? j.data.signDays)
          };
        } else if (msg.includes("您今天已于")) {
          result = { ok: true, signed: false, msg: msg || "今日已签到", points: j.data && j.data.points, signDays: j.data && (j.data.sign_days ?? j.data.signDays) };
        } else {
          result = { ok: false, msg: msg || "签到失败" };
        }
      } catch {
        result = { ok: false, msg: "签到响应不是有效的 JSON" };
      }

      // 4) 落盘状态
      if (result.ok) {
        const state = loadState();
        state.version = STATE_VERSION;
        state.records[account.email] = {
          lastSignDate: beijingDate(),
          lastResult: result.signed ? "signed" : "already",
          lastMsg: result.msg,
          points: result.points || "",
          signDays: result.signDays || "",
          updatedAt: nowIso()
        };
        writeJson(stateFile, state);
      }
      return { masked: maskEmail(account.email), ms: Date.now() - started, ...result };
    } catch (e) {
      return {
        masked: maskEmail(account.email),
        ok: false,
        msg: "网络请求失败：" + (e && e.message ? e.message : String(e))
      };
    }
  }

  /** 签到账号（全部，或传 emails 指定）；fetchImpl 可临时覆盖网络层 */
  async function sign({ emails, fetchImpl: fetchOverride } = {}) {
    const accounts = loadAccounts().accounts;
    const picked = Array.isArray(emails) && emails.length
      ? accounts.filter(a => emails.includes(a.email))
      : accounts;
    if (!picked.length) return { results: [], summary: "还没有配置账号" };
    const results = [];
    // 串行，避免同站短时间并发触发风控
    for (const account of picked) {
      const r = await signOne(account, fetchOverride);
      results.push(r);
    }
    const signed = results.filter(r => r.ok && r.signed).length;
    const already = results.filter(r => r.ok && !r.signed).length;
    const failed = results.filter(r => !r.ok).length;
    const parts = [];
    if (signed) parts.push(`${signed} 个签到成功`);
    if (already) parts.push(`${already} 个今日已签`);
    if (failed) parts.push(`${failed} 个失败`);
    return { results, summary: parts.join(" · ") || "无结果", at: nowIso() };
  }

  return { list, addAccount, removeAccount, sign, signOne, _paths: { accountsFile, stateFile } };
}

module.exports = {
  createAbleSciStore,
  maskEmail,
  beijingDate,
  parseCsrf,
  createCookieJar
};
