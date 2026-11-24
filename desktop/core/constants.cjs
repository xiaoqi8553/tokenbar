'use strict';

/**
 * TokenBar Desktop 魔法数字集中管理（W1 · A-Obs 产物）。
 *
 * 本文件只做常量收集，不改任何已有文件；W3 集成主控可据此替换 desktop/main.cjs
 * 中的硬编码。每条常量都标注了来源行号与单位。所有数值均来自当前 main.cjs
 * （HEAD 343c86e），除 LOG_MAX_BYTES / LOG_MAX_FILES 为本波次新增的日志轮转默认值。
 */

// ---------------------------------------------------------------------------
// 轮询 / 定时器（单位：毫秒）
// ---------------------------------------------------------------------------

/** 实时额度 / 托盘状态刷新周期，来源 main.cjs:875 `setInterval(..., 30_000)`。 */
const POLL_INTERVAL_MS = 30_000;

// ---------------------------------------------------------------------------
// 截图诊断（main.cjs:877-1009；时长单位：毫秒，尺寸单位：像素，次数单位：次）
// ---------------------------------------------------------------------------

/** 弹窗截图前等待渲染，来源 main.cjs:888 `setTimeout(..., 3000)`。 */
const SHOT_POPOVER_DELAY_MS = 3000;

/** 看板截图前等待“首次明细扫描 + 渲染”的默认值，来源 main.cjs:897 `|| 14000`（可被 env 覆盖）。 */
const SHOT_DASHBOARD_DELAY_MS = 14_000;

/** Windows unmaximize 是异步的，等一帧再 setSize，来源 main.cjs:908 `setTimeout(..., 350)`。 */
const SHOT_UNMAXIMIZE_WAIT_MS = 350;

/** setSize/center 之后等待窗口稳定，来源 main.cjs:912 `setTimeout(..., 900)`。 */
const SHOT_RESIZE_WAIT_MS = 900;

/** 切换数据源后等待刷新，来源 main.cjs:921 `setTimeout(..., 2200)`。 */
const SHOT_SOURCE_SWITCH_WAIT_MS = 2200;

/** 点击指定按钮后等待子面板打开，来源 main.cjs:935 `setTimeout(..., 1800)`。 */
const SHOT_CLICK_WAIT_MS = 1800;

/** 截图前 scrollTop 归零后等待，来源 main.cjs:939 `setTimeout(..., 350)`。 */
const SHOT_SCROLL_TOP_WAIT_MS = 350;

/** capturePage 前 show/focus 之后等待，来源 main.cjs:951 `setTimeout(..., 400)`。 */
const SHOT_FOCUS_WAIT_MS = 400;

/** capturePage 失败后的重试间隔，来源 main.cjs:955 `setTimeout(..., 500)`。 */
const SHOT_CAPTURE_RETRY_WAIT_MS = 500;

/** capturePage 最多尝试次数，来源 main.cjs:946 `attempt < 4`。 */
const SHOT_CAPTURE_MAX_ATTEMPTS = 4;

/** 滚到页面底部后等待，来源 main.cjs:965 与 main.cjs:999 `setTimeout(..., 700)`。 */
const SHOT_SCROLL_BOTTOM_WAIT_MS = 700;

/** 切换 7/14/30/全部 区间后等待，来源 main.cjs:985 `setTimeout(..., 900)`。 */
const SHOT_RANGE_WAIT_MS = 900;

/** 切换时段指标（tokens/speed）后等待，来源 main.cjs:999 `setTimeout(..., 700)`。 */
const SHOT_HOUR_WAIT_MS = 700;

/** 看板截图整段逻辑的启动延迟，来源 main.cjs:1008 `setTimeout(..., 1500)`。 */
const SHOT_DASHBOARD_OUTER_DELAY_MS = 1500;

/** 截图固定尺寸的最小宽度阈值，来源 main.cjs:904 `width >= 820`（像素）。 */
const SHOT_MIN_WIDTH = 820;

/** 截图固定尺寸的最小高度阈值，来源 main.cjs:904 `height >= 620`（像素）。 */
const SHOT_MIN_HEIGHT = 620;

// ---------------------------------------------------------------------------
// 冒烟测试超时（main.cjs:1013-1014，单位：毫秒）
// ---------------------------------------------------------------------------

/** 带截图时的冒烟退出超时，来源 main.cjs:1014 `40_000`。 */
const SMOKE_TIMEOUT_WITH_SHOT_MS = 40_000;

/** 无截图时的默认冒烟退出超时，来源 main.cjs:1014 `8_000`。 */
const SMOKE_TIMEOUT_DEFAULT_MS = 8_000;

// ---------------------------------------------------------------------------
// 窗口尺寸（main.cjs:237-240、277，单位：像素）
// ---------------------------------------------------------------------------

/** 主窗口默认宽度，来源 main.cjs:237。 */
const WINDOW_WIDTH = 1180;

/** 主窗口默认高度，来源 main.cjs:238。 */
const WINDOW_HEIGHT = 860;

/** 主窗口最小宽度，来源 main.cjs:239。 */
const WINDOW_MIN_WIDTH = 820;

/** 主窗口最小高度，来源 main.cjs:240。 */
const WINDOW_MIN_HEIGHT = 620;

/** 弹窗高度，来源 main.cjs:277 `const POPOVER_HEIGHT = 640`。 */
const POPOVER_HEIGHT = 640;

// ---------------------------------------------------------------------------
// 文本截断（main.cjs:627，单位：字符）
// ---------------------------------------------------------------------------

/** 科研通签到通知 body 的截断长度，来源 main.cjs:627 `.slice(0, 400)`。 */
const TOKEN_TRUNCATE = 400;

// ---------------------------------------------------------------------------
// 日志（供 W3 接入 logger.cjs；文件名来自 main.cjs:849，轮转值为本波次新增）
// ---------------------------------------------------------------------------

/** 桌面日志文件名，来源 main.cjs:849 `path.join(paths.logs, "desktop.log")`。 */
const LOG_FILE_NAME = "desktop.log";

/** 单个日志文件最大字节数：2MB，超过即轮转（本波次新增，logger.cjs 默认值）。 */
const LOG_MAX_BYTES = 2 * 1024 * 1024;

/** 最多保留的历史日志文件数（.1 / .2 / .3），本波次新增，logger.cjs 默认值。 */
const LOG_MAX_FILES = 3;

/**
 * 日志目录历史文件数上限；当前 main.cjs 未使用该值，预留给 W3 统一引用，
 * 语义与 LOG_MAX_FILES 一致（保留 3 个轮转历史）。
 */
const LOG_DIR_LIMIT = LOG_MAX_FILES;

module.exports = {
  POLL_INTERVAL_MS,

  SHOT_POPOVER_DELAY_MS,
  SHOT_DASHBOARD_DELAY_MS,
  SHOT_UNMAXIMIZE_WAIT_MS,
  SHOT_RESIZE_WAIT_MS,
  SHOT_SOURCE_SWITCH_WAIT_MS,
  SHOT_CLICK_WAIT_MS,
  SHOT_SCROLL_TOP_WAIT_MS,
  SHOT_FOCUS_WAIT_MS,
  SHOT_CAPTURE_RETRY_WAIT_MS,
  SHOT_CAPTURE_MAX_ATTEMPTS,
  SHOT_SCROLL_BOTTOM_WAIT_MS,
  SHOT_RANGE_WAIT_MS,
  SHOT_HOUR_WAIT_MS,
  SHOT_DASHBOARD_OUTER_DELAY_MS,
  SHOT_MIN_WIDTH,
  SHOT_MIN_HEIGHT,

  SMOKE_TIMEOUT_WITH_SHOT_MS,
  SMOKE_TIMEOUT_DEFAULT_MS,

  WINDOW_WIDTH,
  WINDOW_HEIGHT,
  WINDOW_MIN_WIDTH,
  WINDOW_MIN_HEIGHT,
  POPOVER_HEIGHT,

  TOKEN_TRUNCATE,

  LOG_FILE_NAME,
  LOG_MAX_BYTES,
  LOG_MAX_FILES,
  LOG_DIR_LIMIT,
};
