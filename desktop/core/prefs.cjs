'use strict';

/**
 * 偏好设置 / 凭证加密器（W3 拆分自 main.cjs）。
 * 操作 ctx.preferences，依赖通过 ctx 注入。
 */

/**
 * 科研通账号密码的加密器：优先 Electron safeStorage（Windows DPAPI / macOS Keychain），
 * 不可用时退回本机派生的 AES-256-GCM（至少不明文落盘）。加密结果统一 base64 字符串存储。
 */
function makeCipher(ctx) {
  const { safeStorage, crypto, app, os } = ctx;
  let backend = "safeStorage";
  let available = false;
  try { available = Boolean(safeStorage && safeStorage.isEncryptionAvailable()); } catch { available = false; }
  if (available) {
    return {
      backend,
      encrypt(text) { return safeStorage.encryptString(String(text)).toString("base64"); },
      decrypt(stored) { return safeStorage.decryptString(Buffer.from(String(stored), "base64")); }
    };
  }
  backend = "local-aes-gcm";
  ctx.log(ctx, `safeStorage 不可用，科研通凭证使用本机派生密钥加密 (${backend})`);
  const key = crypto.createHash("sha256")
    .update("tokenbar.ablesci.v1|" + app.getPath("userData") + "|" + os.hostname())
    .digest();
  return {
    backend,
    encrypt(text) {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv("aes-256-gcm", key, iv);
      const enc = Buffer.concat([c.update(String(text), "utf8"), c.final()]);
      return "gcm:" + Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64");
    },
    decrypt(stored) {
      const raw = Buffer.from(String(stored).replace(/^gcm:/, ""), "base64");
      const iv = raw.subarray(0, 12);
      const tag = raw.subarray(12, 28);
      const enc = raw.subarray(28);
      const d = crypto.createDecipheriv("aes-256-gcm", key, iv);
      d.setAuthTag(tag);
      return Buffer.concat([d.update(enc), d.final()]).toString("utf8");
    }
  };
}

function loadPreferences(ctx, paths) {
  const { fs, app } = ctx;
  try {
    ctx.preferences = { ...ctx.preferences, ...JSON.parse(fs.readFileSync(paths.preferences, "utf8")) };
  } catch {
    // First launch or an older preferences file.
  }
  if (process.platform === "win32") {
    app.setLoginItemSettings({ openAtLogin: Boolean(ctx.preferences.launchAtLogin), path: process.execPath });
  }
}

function savePreferences(ctx, paths) {
  ctx.fs.writeFileSync(paths.preferences, JSON.stringify(ctx.preferences, null, 2), "utf8");
}

function installPrefs(ctx) {
  ctx.makeCipher = makeCipher;
  ctx.loadPreferences = loadPreferences;
  ctx.savePreferences = savePreferences;
  return ctx;
}

module.exports = { installPrefs, makeCipher, loadPreferences, savePreferences };
