'use strict';

/**
 * TokenBar Desktop 结构化分级日志（W1 · A-Obs 产物）。
 * 仅依赖 Node 内置模块；生产依赖为空。
 */

const fs = require('fs');
const path = require('path');
const util = require('util');
const { LOG_MAX_BYTES, LOG_MAX_FILES } = require('./constants.cjs');

/**
 * 级别权重映射（数值越大越严重），可用于自定义阈值比较。
 * @type {Readonly<{trace:number, debug:number, info:number, warn:number, error:number}>}
 */
const LEVELS = Object.freeze({ trace: 10, debug: 20, info: 30, warn: 40, error: 50 });
const LEVEL_NAMES = Object.keys(LEVELS);
const DEFAULT_LEVEL = 'info';

/** 把任意输入归一化为合法的级别名（大小写不敏感，非法值回退 info）。 */
function normalizeLevel(value) {
  if (typeof value === 'string') {
    const name = value.trim().toLowerCase();
    if (Object.prototype.hasOwnProperty.call(LEVELS, name)) return name;
  }
  return DEFAULT_LEVEL;
}

/**
 * 统一脱敏：替换 OpenAI API key（sk-）、OAuth access/refresh token
 * （JWT eyJ 开头、Bearer 长 token、access_token/refresh_token 赋值）与邮箱。
 * 在 console 与 file 输出前调用，Error.stack 也会被处理。
 *
 * @param {*} input 任意日志内容（字符串、Error、对象等）。
 * @returns {string} 脱敏后的字符串。
 */
function sanitize(input) {
  let str;
  if (typeof input === 'string') {
    str = input;
  } else if (input instanceof Error) {
    str = input.stack || input.message || String(input);
  } else {
    try {
      str = typeof input === 'object' && input !== null ? JSON.stringify(input) : String(input);
    } catch (_) {
      str = String(input);
    }
  }
  if (typeof str !== 'string') str = String(str);

  // OpenAI API key：sk- 后跟至少 4 位字母/数字/下划线/连字符
  str = str.replace(/\bsk-[A-Za-z0-9_-]{4,}/gi, '***');
  // JWT：eyJ 开头，可带 1~2 个 "." 分段
  str = str.replace(/\beyJ[A-Za-z0-9_-]{4,}(?:\.[A-Za-z0-9_-]+)*/g, '***');
  // Bearer 长 token：保留 "Bearer " 前缀，只遮住令牌本体
  str = str.replace(/(\bBearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, '$1***');
  // access_token / refresh_token 赋值（含 JSON 键值与 URL 查询参数）
  str = str.replace(/\b(access[_-]?token|refresh[_-]?token)\b(\s*[:=]\s*["']?)[A-Za-z0-9._~+/=-]{12,}/gi, '$1$2***');
  // 邮箱：name@example.com（含 +、. 与多级域名）
  str = str.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g, '***');

  return str;
}

/** 拼接父子 scope，用 ":" 分隔。 */
function joinScope(parent, child) {
  if (!parent) return child || '';
  if (!child) return parent;
  return `${parent}:${child}`;
}

/** 按 maxFiles 轮转：删除最旧文件，其余后移一位，当前文件改名为 .1。 */
function rotateFile(file, maxFiles) {
  try {
    fs.unlinkSync(`${file}.${maxFiles}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  for (let i = maxFiles - 1; i >= 1; i -= 1) {
    try {
      fs.renameSync(`${file}.${i}`, `${file}.${i + 1}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  try {
    fs.renameSync(file, `${file}.1`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

/**
 * 创建一个结构化 logger 实例。
 *
 * @param {Object} [options={}] 配置。
 * @param {string} [options.level] 级别阈值，支持 trace/debug/info/warn/error；
 *        未传时读取 env `TOKENBAR_LOG_LEVEL`，再未传则默认 info。
 * @param {string} [options.file] 文件日志路径；未传时读取 env `TOKENBAR_LOG_FILE`。
 * @param {string} [options.scope] 固定 scope 前缀（子 logger 用）。
 * @param {number} [options.maxBytes] 单文件轮转阈值，默认 constants.LOG_MAX_BYTES（2MB）。
 * @param {number} [options.maxFiles] 历史文件保留数，默认 constants.LOG_MAX_FILES（3）。
 * @param {boolean} [options.silent] 为 true 时关闭 console 输出（文件仍写）。
 * @param {boolean} [options.console] 为 false 时关闭 console 输出。
 * @returns {{trace:Function, debug:Function, info:Function, warn:Function,
 *   error:Function, child:Function, setLevel:Function, scope:string, file:(string|null)}}
 *   logger 实例；五个级别方法签名为 `(...args)`，内部用 util.format 拼接后脱敏。
 */
function createLogger(options = {}) {
  const opts = options || {};
  let threshold = LEVELS[normalizeLevel(opts.level != null ? opts.level : process.env.TOKENBAR_LOG_LEVEL)];
  const scope = sanitize(opts.scope || '');
  const file = opts.file || process.env.TOKENBAR_LOG_FILE || null;
  const maxBytes = Number.isFinite(opts.maxBytes) && opts.maxBytes > 0 ? opts.maxBytes : LOG_MAX_BYTES;
  const maxFiles = Number.isInteger(opts.maxFiles) && opts.maxFiles > 0 ? opts.maxFiles : LOG_MAX_FILES;
  const enableConsole = opts.silent !== true && opts.console !== false;

  function formatLine(level, message) {
    const timestamp = new Date().toISOString();
    const tag = level.toUpperCase();
    const prefix = scope ? `[${timestamp}][${tag}][${scope}] ` : `[${timestamp}][${tag}] `;
    return prefix + message;
  }

  function writeFile(line) {
    if (!file) return;
    try {
      const dir = path.dirname(file);
      if (dir) fs.mkdirSync(dir, { recursive: true });
      try {
        if (fs.statSync(file).size > maxBytes) rotateFile(file, maxFiles);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      fs.appendFileSync(file, `${line}\n`, 'utf8');
    } catch (_) {
      // 落盘失败时静默降级，console 输出已在 emit 中完成
    }
  }

  function emit(level, args) {
    if (LEVELS[level] < threshold) return;
    // util.format 负责 %s/%d 占位与 Error.stack；随后统一脱敏（含 stack）
    const message = sanitize(util.format(...args));
    const line = formatLine(level, message);
    if (enableConsole) {
      if (level === 'error' || level === 'warn') console.error(line);
      else console.log(line);
    }
    writeFile(line);
  }

  const instance = { scope, file };
  for (const name of LEVEL_NAMES) {
    instance[name] = (...args) => emit(name, args);
  }

  /**
   * 派生带固定 scope 前缀的子 logger（scope 以 ":" 串联，如 ipc:auth）。
   * @param {string} childScope 子作用域名。
   * @returns {Object} 新的 logger 实例，继承当前配置。
   */
  instance.child = (childScope) => createLogger({
    ...opts,
    scope: joinScope(scope, sanitize(childScope || '')),
  });

  /**
   * 运行时调整级别阈值。
   * @param {string} next 级别名，非法值回退 info。
   * @returns {Object} 当前 logger 实例（便于链式调用）。
   */
  instance.setLevel = (next) => {
    threshold = LEVELS[normalizeLevel(next)];
    return instance;
  };

  return instance;
}

/** 默认单例：不传 options 时读取环境变量配置。 */
const logger = createLogger();

/**
 * 导出清单：
 * - `createLogger(options)`：创建独立 logger 实例。
 * - `logger`：默认单例，兼容 `require('./logger.cjs').logger`。
 * - `sanitize(input)`：统一脱敏函数，可在上报第三方前复用。
 * - `LEVELS`：级别权重映射。
 */
module.exports = {
  createLogger,
  logger,
  sanitize,
  LEVELS,
};
