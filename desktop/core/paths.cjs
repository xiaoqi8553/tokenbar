'use strict';

/**
 * 路径 / 目录迁移（W3 拆分自 main.cjs）。
 * 纯函数：所有外部依赖通过 ctx 注入（app / fs / path / os）。
 * 搬迁逻辑（SingletonLock 判断、Codex Token→TokenBar 迁移）逐字保留。
 */

function adoptLegacyUserData(ctx) {
  const { app, path, fs } = ctx;
  // 改名 TokenBar 后，userData 会从 %APPDATA%/Codex Token 变成 %APPDATA%/TokenBar。
  // 历史索引（usage-index.json，5.7B 的基线）还在旧目录，直接换名会让累计掉回磁盘日志的 2.4B，
  // 所以首次启动把旧目录整份搬过来。搬不动（占用/权限）就继续用旧目录，宁可名字不对也不能丢账。
  // 开发模式取 package.json 的 name（tokenbar），打包后取 productName（TokenBar），
  // 大小写两套目录会让缓存各存一份，这里统一钉死。
  try {
    // 外部显式指定 --user-data-dir（冒烟、排查）时不覆盖，别把测试数据写进真账本
    if (!process.argv.some(arg => arg.startsWith("--user-data-dir"))) {
      app.setPath("userData", path.join(app.getPath("appData"), "TokenBar"));
    }
  } catch {
    /* 极早期调用失败就沿用默认路径 */
  }
  const appData = app.getPath("appData");
  let current;
  try {
    current = app.getPath("userData");
  } catch {
    return;
  }
  // 注意不能只看「目录是否为空」：requestSingleInstanceLock() 已经在 userData 下写了
  // SingletonLock，目录永远非空。只认真正的账本文件。
  const hasPayload = dir => fs.existsSync(path.join(dir, "data", "usage-index.json"))
    || fs.existsSync(path.join(dir, "data", "history-baseline.json"));
  if (hasPayload(current)) return;
  for (const name of ["Codex Token", "codex-token-dashboard"]) {
    const legacy = path.join(appData, name);
    if (legacy === current || !fs.existsSync(legacy)) continue;
    try {
      fs.mkdirSync(current, { recursive: true });
      fs.cpSync(legacy, current, { recursive: true, force: false, errorOnExist: false });
      return;
    } catch {
      /* 复制失败就往下走，后续扫描会重建缓存（慢一点，但不影响正确性） */
    }
  }
}

function userDataPaths(ctx) {
  const { app, path } = ctx;
  const userData = app.getPath("userData");
  return {
    userData,
    data: path.join(userData, "data"),
    logs: path.join(userData, "logs"),
    config: path.join(userData, "config.json"),
    preferences: path.join(userData, "preferences.json"),
    usageCache: path.join(userData, "data", "codex-usage-cache.json"),
    detailCache: path.join(userData, "data", "codex-detail-cache.json"),
    usageIndex: path.join(userData, "data", "usage-index.json"),
    baseline: path.join(userData, "data", "history-baseline.json"),
    workbuddyCache: path.join(userData, "data", "workbuddy-detail-cache.json"),
    antigravityCache: path.join(userData, "data", "antigravity-detail-cache.json"),
    antigravityQuotaCache: path.join(userData, "data", "antigravity-quota-cache.json"),
    ccSwitchAgyAccounts: path.join(ctx.os.homedir(), ".cc-switch", "agy_accounts.json"),
    pricing: path.join(userData, "data", "pricing.json"),
    ablesciAccounts: path.join(userData, "data", "ablesci-accounts.json"),
    ablesciState: path.join(userData, "data", "ablesci-state.json"),
    codexHiddenAccounts: path.join(userData, "data", "codex-hidden-accounts.json")
  };
}

function sessionsDir(ctx) {
  const { path, os } = ctx;
  return process.env.CODEX_HOME
    ? path.join(process.env.CODEX_HOME, "sessions")
    : path.join(os.homedir(), ".codex", "sessions");
}

/**
 * WorkBuddy 有两套安装，日志目录不同：
 *   国际版 ~/.workbuddy-ai/projects，国内版 ~/.workbuddy/projects。
 * 两个都读，同名会话按体积取大者（见 WorkBuddyStore.listFiles）。
 */
function workBuddyRoots(ctx) {
  const { path, os, fs } = ctx;
  const home = os.homedir();
  const candidates = [
    process.env.WORKBUDDY_HOME,
    path.join(home, ".workbuddy-ai"),
    path.join(home, ".workbuddy")
  ].filter(Boolean);
  const existing = candidates.filter(root => fs.existsSync(path.join(root, "projects")));
  return existing.length ? existing : [path.join(home, ".workbuddy")];
}

/**
 * Antigravity 多根目录发现（对齐 CC Switch `agy.rs`）：
 *   ~/.gemini/antigravity-cli、~/.gemini/antigravity、~/.gemini/antigravity-acp、
 *   ~/.cc-switch/agy/<provider>/antigravity-cli、~/.t3/.../antigravity-acp。
 */
function antigravityRoots(ctx) {
  const { path, os, fs } = ctx;
  const envHome = (process.env.ANTIGRAVITY_HOME || process.env.AGY_HOME || "").trim();
  if (envHome) {
    const candidates = [
      envHome,
      path.join(envHome, "antigravity-cli"),
      path.join(envHome, "antigravity"),
      path.join(envHome, "antigravity-acp")
    ];
    const existing = candidates.filter(dir => fs.existsSync(path.join(dir, "brain")));
    return existing.length ? [...new Set(existing)] : [envHome];
  }

  const home = os.homedir();
  const subdirs = dir => {
    try {
      return fs.readdirSync(dir, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => path.join(dir, entry.name))
        .sort();
    } catch {
      return [];
    }
  };

  const candidates = [
    path.join(home, ".gemini", "antigravity-cli"),
    path.join(home, ".gemini", "antigravity"),
    path.join(home, ".gemini", "antigravity-acp")
  ];

  for (const dir of subdirs(path.join(home, ".cc-switch", "agy"))) {
    candidates.push(path.join(dir, "antigravity-cli"));
  }

  const t3Homes = [];
  const t3Env = (process.env.T3CODE_HOME || "").trim();
  if (t3Env) t3Homes.push(t3Env);
  t3Homes.push(path.join(home, ".t3"));
  for (const t3Home of [...new Set(t3Homes)]) {
    for (const stateDir of ["userdata", "dev"]) {
      for (const instanceDir of subdirs(path.join(t3Home, stateDir, "providers", "antigravity"))) {
        candidates.push(path.join(instanceDir, "antigravity-acp"));
      }
    }
  }

  const out = [];
  const seen = new Set();
  for (const dir of candidates) {
    if (!fs.existsSync(path.join(dir, "brain"))) continue;
    let key = path.resolve(dir);
    try {
      key = fs.realpathSync(dir);
    } catch {
      /* ignore */
    }
    if (process.platform === "win32") key = key.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(dir);
  }
  return out.length ? out : [path.join(home, ".gemini", "antigravity")];
}

function migrateUserData(ctx, paths) {
  ctx.fs.mkdirSync(paths.data, { recursive: true });
  ctx.fs.mkdirSync(paths.logs, { recursive: true });
}

function installPaths(ctx) {
  ctx.adoptLegacyUserData = adoptLegacyUserData;
  ctx.userDataPaths = userDataPaths;
  ctx.sessionsDir = sessionsDir;
  ctx.workBuddyRoots = workBuddyRoots;
  ctx.antigravityRoots = antigravityRoots;
  ctx.migrateUserData = migrateUserData;
  return ctx;
}

module.exports = {
  installPaths,
  adoptLegacyUserData,
  userDataPaths,
  sessionsDir,
  workBuddyRoots,
  antigravityRoots,
  migrateUserData
};
