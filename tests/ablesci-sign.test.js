const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  createAbleSciStore,
  maskEmail,
  beijingDate,
  parseCsrf,
  parseUserInfo,
  createCookieJar
} = require("../desktop/data/ablesci-store.cjs");

function tmpFiles() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ablesci-"));
  return {
    dir,
    accountsFile: path.join(dir, "accounts.json"),
    stateFile: path.join(dir, "state.json")
  };
}

// 测试用可逆「加密」，真实运行用 Electron safeStorage
const cipher = {
  encrypt: s => "enc:" + Buffer.from(s).toString("base64"),
  decrypt: s => Buffer.from(String(s).replace(/^enc:/, ""), "base64").toString("utf8")
};

function headerBag(entries = {}) {
  return {
    getSetCookie: () => entries["set-cookie"] || [],
    get: name => entries[name] || null
  };
}

test("maskEmail 脱敏", () => {
  assert.equal(maskEmail("alice@example.com"), "al***@example.com");
  assert.equal(maskEmail("ab@x.io"), "ab***@x.io");
  assert.equal(maskEmail(""), "***");
});

test("parseCsrf 兼容 meta 与 input 两种页面结构", () => {
  assert.equal(parseCsrf('<meta name="csrf-token" content="TOKEN1">'), "TOKEN1");
  assert.equal(parseCsrf('<meta content="TOKEN2" name="csrf-token">'), "TOKEN2");
  assert.equal(parseCsrf('<input type="hidden" name="_csrf" value="TOKEN3">'), "TOKEN3");
  assert.equal(parseCsrf("<html>nothing</html>"), "");
});

test("cookie jar 保存并拼接 cookie", () => {
  const jar = createCookieJar();
  jar.absorb(headerBag({ "set-cookie": ["a=1; Path=/; HttpOnly", "b=2; Path=/"] }));
  assert.equal(jar.header(), "a=1; b=2");
  assert.equal(jar.size, 2);
});

test("多账号增删：密码加密落盘，列表返回脱敏邮箱", () => {
  const f = tmpFiles();
  const store = createAbleSciStore({ ...f, cipher });
  store.addAccount("alice@example.com", "pass123");
  store.addAccount("bob@example.net", "pass456");
  assert.throws(() => store.addAccount("alice@example.com", "x"), /已存在/);
  assert.throws(() => store.addAccount("not-an-email", "x"), /邮箱格式/);

  const raw = JSON.parse(fs.readFileSync(f.accountsFile, "utf8"));
  assert.equal(raw.accounts.length, 2);
  assert.ok(!JSON.stringify(raw).includes("pass123"), "明文密码不能落盘");
  assert.ok(raw.accounts[0].secret.startsWith("enc:"));

  const list = store.list();
  assert.equal(list.accounts.length, 2);
  assert.equal(list.accounts[0].masked, "al***@example.com");
  assert.ok(!JSON.stringify(list).includes("pass123"), "列表不能泄露明文密码");
  assert.ok(!JSON.stringify(list).includes("bob@example.net"));

  const id = list.accounts[0].id;
  store.removeAccount(id);
  assert.equal(store.list().accounts.length, 1);
});

test("签到全流程：登录→签到→记录今日已签（假 fetch 复刻站点响应）", async () => {
  const f = tmpFiles();
  const store = createAbleSciStore({ ...f, cipher });
  store.addAccount("user@example.com", "mypassword");

  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, method: (options && options.method) || "GET", options });
    if (url.endsWith("/site/login") && (!options || options.method !== "POST")) {
      return {
        headers: headerBag({ "set-cookie": ["security_session_verify=sv1; HttpOnly", "_csrf=cookieToken; Path=/"] }),
        text: async () => '<html><meta name="csrf-token" content="metaToken123"></html>'
      };
    }
    if (url.endsWith("/site/login") && options.method === "POST") {
      assert.match(options.body, /_csrf=metaToken123/);
      assert.match(options.body, /email=user%40example\.com/);
      assert.match(options.body, /password=mypassword/);
      assert.match(options.headers.Cookie, /_csrf=cookieToken/);
      return {
        headers: headerBag({}),
        text: async () => JSON.stringify({ code: 0, msg: "登录成功" })
      };
    }
    if (url.endsWith("/user/sign")) {
      assert.match(options.headers.Cookie, /security_session_verify=sv1/);
      return {
        headers: headerBag({}),
        text: async () => JSON.stringify({ code: 0, msg: "签到成功，获得10积分", data: { points: 260, sign_days: 12 } })
      };
    }
    throw new Error("unexpected url " + url);
  };

  const out = await store.sign({ fetchImpl });
  assert.equal(calls.length, 3);
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[1].method, "POST");
  assert.equal(calls[2].method, "GET");
  assert.equal(out.results.length, 1);
  assert.equal(out.results[0].ok, true);
  assert.equal(out.results[0].signed, true);
  assert.match(out.summary, /1 个签到成功/);

  const list = store.list();
  assert.equal(list.accounts[0].signedToday, true);
  assert.equal(list.accounts[0].points, 260);
  assert.equal(list.accounts[0].signDays, 12);
  assert.equal(list.accounts[0].lastResult, "signed");
});

test("已签到 / 登录失败 / 验证码 分支", async () => {
  const f = tmpFiles();
  const store = createAbleSciStore({ ...f, cipher });
  store.addAccount("a@example.com", "p");

  const base = (signText, loginText) => async (url, options) => {
    if (url.endsWith("/site/login") && (!options || options.method !== "POST")) {
      return { headers: headerBag({}), text: async () => '<meta name="csrf-token" content="t">' };
    }
    if (options && options.method === "POST") {
      return { headers: headerBag({}), text: async () => loginText || JSON.stringify({ code: 0 }) };
    }
    return { headers: headerBag({}), text: async () => signText };
  };

  const already = await store.sign({ fetchImpl: base(JSON.stringify({ code: 1, msg: "签到失败，您今天已于 08:30 签到" })) });
  assert.equal(already.results[0].ok, true);
  assert.equal(already.results[0].signed, false);
  assert.match(already.summary, /今日已签/);

  const badLogin = await store.sign({ fetchImpl: base(JSON.stringify({ code: 1, msg: "签到成功" }), JSON.stringify({ code: 1, msg: "密码错误" })) });
  assert.equal(badLogin.results[0].ok, false);
  assert.match(badLogin.results[0].msg, /密码错误/);

  const captcha = await store.sign({ fetchImpl: base("", '<html>请输入验证码</html>') });
  assert.equal(captcha.results[0].ok, false);
  assert.match(captcha.results[0].msg, /验证码/);
});

test("多账号串行签到，汇总分别统计", async () => {
  const f = tmpFiles();
  const store = createAbleSciStore({ ...f, cipher });
  store.addAccount("one@example.com", "p1");
  store.addAccount("two@example.com", "p2");
  let n = 0;
  const fetchImpl = async (url, options) => {
    if (url.endsWith("/site/login") && (!options || options.method !== "POST")) {
      return { headers: headerBag({}), text: async () => '<meta name="csrf-token" content="t">' };
    }
    if (options && options.method === "POST") {
      return { headers: headerBag({}), text: async () => JSON.stringify({ code: 0 }) };
    }
    n += 1;
    return {
      headers: headerBag({}),
      text: async () => n === 1
        ? JSON.stringify({ code: 0, msg: "签到成功" })
        : JSON.stringify({ code: 1, msg: "您今天已于 07:40 签到" })
    };
  };
  const out = await store.sign({ fetchImpl });
  assert.equal(out.results.length, 2);
  assert.match(out.summary, /1 个签到成功/);
  assert.match(out.summary, /1 个今日已签/);
});

test("parseUserInfo 从首页解析积分与连续签到天数", () => {
  const html = '<div class="u"><b id="user-point-now">2,205</b></div>'
    + '<span id="sign-count">4</span>';
  const info = parseUserInfo(html);
  assert.equal(info.points, 2205, "千分位逗号要去掉");
  assert.equal(info.signDays, 4);
  const none = parseUserInfo("<html>anonymous</html>");
  assert.equal(none.points, "");
  assert.equal(none.signDays, "");
});

test("签到响应不带积分时，用登录会话抓首页补上积分/连续天数", async () => {
  const f = tmpFiles();
  const store = createAbleSciStore({ ...f, cipher });
  store.addAccount("user@example.com", "p");
  let homeCalled = false;
  const fetchImpl = async (url, options) => {
    if (url.endsWith("/site/login") && (!options || options.method !== "POST")) {
      return {
        headers: headerBag({ "set-cookie": ["advanced-frontend=xyz; Path=/"] }),
        text: async () => '<meta name="csrf-token" content="t">'
      };
    }
    if (options && options.method === "POST") {
      return { headers: headerBag({}), text: async () => JSON.stringify({ code: 0 }) };
    }
    if (url.endsWith("/user/sign")) {
      // data 里没有积分，积分只在首页 HTML 里
      return { headers: headerBag({}), text: async () => JSON.stringify({ code: 0, msg: "签到成功" }) };
    }
    if (url.endsWith("ablesci.com/")) {
      homeCalled = true;
      assert.match(options.headers.Cookie, /advanced-frontend|_csrf/);
      return { headers: headerBag({}), text: async () => '<b id="user-point-now">2205</b><i id="sign-count">4</i>' };
    }
    throw new Error("unexpected " + url);
  };
  const out = await store.sign({ fetchImpl });
  assert.equal(homeCalled, true, "缺积分时应抓首页");
  assert.equal(out.results[0].points, 2205);
  assert.equal(out.results[0].signDays, 4);
  const list = store.list();
  assert.equal(list.accounts[0].points, 2205, "积分要落盘并在列表可见");
  assert.equal(list.accounts[0].signDays, 4);
});

test("beijingDate 返回 YYYY-MM-DD", () => {
  assert.match(beijingDate(new Date("2026-11-19T12:00:00Z")), /^2026-11-\d{2}$/);
});
