'use strict';

/**
 * TokenBar Desktop 全局错误边界（W1 · A-Obs 产物）。
 * 由 W3 在 main.cjs 启动时调用一次 installErrorBoundary()；本模块不强制退出进程。
 * 仅依赖 Node 内置模块与同目录 logger.cjs。
 */

const { logger } = require('./logger.cjs');

let boundary = null;

/**
 * 安装全局错误边界：捕获 uncaughtException / unhandledRejection 并用 logger.error
 * 脱敏记录；同时尝试启动 Electron crashReporter 做本地崩溃转储（不外传）。
 *
 * 幂等：重复调用返回首次安装的句柄，不会重复注册监听器。
 * 不调用 process.exit —— Electron 应用应尽量存活，是否退出由 options.onFatal 决定。
 *
 * @param {Object} [options={}] 配置。
 * @param {(payload:Object)=>void} [options.onFatal] 致命错误回调，收到
 *        `{ type, error?, reason?, origin?, promise? }`；回调内的异常会被再次安全记录。
 * @param {Object} [options.crashReporter] 覆盖 crashReporter.start 的默认参数。
 * @returns {{installed:boolean, uninstall:()=>void}} 边界句柄，可 uninstall 后重装。
 */
function installErrorBoundary(options = {}) {
  if (boundary) return boundary;

  const opts = options || {};
  const onFatal = typeof opts.onFatal === 'function' ? opts.onFatal : null;

  // 仅在真 Electron 主进程中启动本地崩溃转储；非 Electron / 单测环境安全跳过。
  try {
    const electron = require('electron');
    if (electron && typeof electron === 'object' && electron.crashReporter
        && typeof electron.crashReporter.start === 'function') {
      electron.crashReporter.start({
        productName: 'TokenBar',
        companyName: 'TokenBar',
        submitURL: '',
        uploadToServer: false,
        compress: true,
        ...(opts.crashReporter || {}),
      });
    }
  } catch (_) {
    // require('electron') 在普通 Node 下可能返回字符串路径或直接缺失，忽略即可
  }

  function safeNotifyFatal(payload) {
    if (!onFatal) return;
    try {
      onFatal(payload);
    } catch (callbackError) {
      logger.error(`[fatal] onFatal callback threw: ${callbackError && (callbackError.stack || callbackError.message) || String(callbackError)}`);
    }
  }

  function onUncaughtException(error, origin) {
    const detail = (error && (error.stack || error.message)) || String(error);
    logger.error(`[uncaughtException] origin=${origin || 'unknown'} ${detail}`);
    safeNotifyFatal({ type: 'uncaughtException', error, origin });
  }

  function onUnhandledRejection(reason, promise) {
    const detail = (reason && (reason.stack || reason.message)) || String(reason);
    logger.error(`[unhandledRejection] ${detail}`);
    safeNotifyFatal({ type: 'unhandledRejection', reason, promise });
  }

  process.on('uncaughtException', onUncaughtException);
  process.on('unhandledRejection', onUnhandledRejection);

  boundary = {
    installed: true,
    uninstall() {
      if (!boundary) return;
      process.removeListener('uncaughtException', onUncaughtException);
      process.removeListener('unhandledRejection', onUnhandledRejection);
      boundary = null;
    },
  };
  return boundary;
}

/**
 * 渲染进程错误钩子的源码文本（IIFE 字符串），供 W3 决定是否注入 preload / webPreferences。
 * 内容：window.onerror + window.addEventListener('unhandledrejection')，
 * 通过 `window.dashboard.reportError?.(payload)` 上报；不上报时静默，不会抛错。
 *
 * 注意：仅为字符串常量，本模块不会自动执行它。
 * @type {string}
 */
const RENDERER_ERROR_HOOK = `(function () {
  function report(payload) {
    try { window.dashboard?.reportError?.(payload); } catch (_) {}
  }
  window.onerror = function (message, source, lineno, colno, error) {
    report({
      type: 'window.onerror',
      message: String(message),
      source: source,
      lineno: lineno,
      colno: colno,
      error: error && (error.stack || error.message)
    });
    return false;
  };
  window.addEventListener('unhandledrejection', function (event) {
    var reason = event.reason;
    report({
      type: 'unhandledrejection',
      message: reason && (reason.message || String(reason)),
      stack: reason && reason.stack
    });
  });
})();`;

/**
 * 导出清单：
 * - `installErrorBoundary(options)`：幂等安装全局错误边界，返回可卸载句柄。
 * - `RENDERER_ERROR_HOOK`：渲染进程错误上报钩子的源码字符串（需 W3 决定是否注入）。
 */
module.exports = {
  installErrorBoundary,
  RENDERER_ERROR_HOOK,
};
