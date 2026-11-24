'use strict';

/**
 * Dev 截图诊断（W3 原样搬迁自 main.cjs 877-1009）。
 * 环境变量钩子（CODEX_TOKEN_POPOVER_SHOT / CODEX_TOKEN_DASHBOARD_SHOT 及
 * SHOT_SIZE / SHOT_SOURCE / SHOT_CLICK / SHOT_CLICK2 / SHOT_SCROLL / SHOT_RANGE /
 * SHOT_HOUR / SHOT_DELAY 等）行为逐字不变，供 capture-shots.js 出图。
 * 仅把窗口/函数/文件依赖改为 ctx 引用，魔法数字替换为 constants.cjs 常量（值不变）。
 */

const {
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
  SHOT_MIN_HEIGHT
} = require('./constants.cjs');

function installShotDiagnostics(ctx) {
  // Dev 诊断：把真实弹窗内容截成 PNG，用于验证 preload 与真实数据链路
  if (process.env.CODEX_TOKEN_POPOVER_SHOT) {
    setTimeout(async () => {
      try {
        if (!ctx.popover || ctx.popover.isDestroyed()) return;
        const image = await ctx.popover.webContents.capturePage();
        ctx.fs.writeFileSync(process.env.CODEX_TOKEN_POPOVER_SHOT, image.toPNG());
        process.stdout.write(`popover shot saved: ${process.env.CODEX_TOKEN_POPOVER_SHOT}\n`);
      } catch (error) {
        process.stdout.write(`popover shot failed: ${error.message}\n`);
      }
    }, SHOT_POPOVER_DELAY_MS);
  }

  // Dev 诊断：把真实看板内容截成 PNG，用于验证 preload 与真实数据链路
  if (process.env.CODEX_TOKEN_DASHBOARD_SHOT) {
    setTimeout(async () => {
      try {
        await ctx.showWindow(ctx);
        // 等首次明细扫描 + 渲染完成
        await new Promise(resolve => setTimeout(resolve, Number(process.env.CODEX_TOKEN_DASHBOARD_SHOT_DELAY) || SHOT_DASHBOARD_DELAY_MS));
        if (!ctx.mainWindow || ctx.mainWindow.isDestroyed()) return;
        // 排查用：截图前把窗口固定成指定尺寸（如 1180x860），保证截图和真实窗口一致
        if (process.env.CODEX_TOKEN_DASHBOARD_SHOT_SIZE) {
          const [width, height] = String(process.env.CODEX_TOKEN_DASHBOARD_SHOT_SIZE)
            .split("x")
            .map(value => Number(value) || 0);
          if (width >= SHOT_MIN_WIDTH && height >= SHOT_MIN_HEIGHT) {
            // Windows 上 unmaximize 是异步的，紧接着 setSize 会被还原尺寸覆盖，必须等一帧
            if (ctx.mainWindow.isMaximized()) {
              ctx.mainWindow.unmaximize();
              await new Promise(resolve => setTimeout(resolve, SHOT_UNMAXIMIZE_WAIT_MS));
            }
            ctx.mainWindow.setSize(width, height);
            ctx.mainWindow.center();
            await new Promise(resolve => setTimeout(resolve, SHOT_RESIZE_WAIT_MS));
          }
        }
        // 排查用：先切到指定数据源（codex / workbuddy）再截图
        if (process.env.CODEX_TOKEN_DASHBOARD_SHOT_SOURCE) {
          const source = String(process.env.CODEX_TOKEN_DASHBOARD_SHOT_SOURCE).replace(/[^a-z]/gi, "");
          await ctx.mainWindow.webContents.executeJavaScript(
            `(() => { const el = document.querySelector('#source button[data-source="${source}"]'); if (el) el.click(); return !!el; })()`
          );
          await new Promise(resolve => setTimeout(resolve, SHOT_SOURCE_SWITCH_WAIT_MS));
        }
        const shotPath = process.env.CODEX_TOKEN_DASHBOARD_SHOT;
        // 排查用：截图前点击指定按钮（如 btn-auth 打开实时额度弹窗）
        const shotClicks = [
          process.env.CODEX_TOKEN_DASHBOARD_SHOT_CLICK,
          process.env.CODEX_TOKEN_DASHBOARD_SHOT_CLICK2
        ].filter(Boolean);
        for (const clickTarget of shotClicks) {
          // 先按 id 找；找不到就当 CSS 选择器用，便于连点打开弹窗里的子面板
          const target = String(clickTarget);
          await ctx.mainWindow.webContents.executeJavaScript(
            `(() => { const el = document.getElementById(${JSON.stringify(target)}) || document.querySelector(${JSON.stringify(target)}); if (el) el.click(); return !!el; })()`
          );
          await new Promise(resolve => setTimeout(resolve, SHOT_CLICK_WAIT_MS));
        }
        // 明确先回到顶部，避免捕获到上一次滚动位置
        await ctx.mainWindow.webContents.executeJavaScript('(() => { const el = document.querySelector("main"); if (el) el.scrollTop = 0; return true; })()');
        await new Promise(resolve => setTimeout(resolve, SHOT_SCROLL_TOP_WAIT_MS));
        const info = await ctx.mainWindow.webContents.executeJavaScript(
          '({scrollTop: (document.querySelector("main")||{}).scrollTop, innerHeight: window.innerHeight, dpr: window.devicePixelRatio, scrollHeight: (document.querySelector("main")||{}).scrollHeight})'
        );
        process.stdout.write(`dashboard layout: ${JSON.stringify(info)}\n`);
        const shoot = async () => {
          let lastError;
          for (let attempt = 0; attempt < SHOT_CAPTURE_MAX_ATTEMPTS; attempt += 1) {
            try {
              if (ctx.mainWindow.isMinimized()) ctx.mainWindow.restore();
              ctx.mainWindow.show();
              ctx.mainWindow.focus();
              await new Promise(resolve => setTimeout(resolve, SHOT_FOCUS_WAIT_MS));
              return await ctx.mainWindow.webContents.capturePage();
            } catch (error) {
              lastError = error;
              await new Promise(resolve => setTimeout(resolve, SHOT_CAPTURE_RETRY_WAIT_MS));
            }
          }
          throw lastError;
        };
        const image = await shoot();
        ctx.fs.writeFileSync(shotPath, image.toPNG());
        process.stdout.write(`dashboard shot saved: ${shotPath}\n`);
        if (process.env.CODEX_TOKEN_DASHBOARD_SHOT_SCROLL) {
          await ctx.mainWindow.webContents.executeJavaScript('(() => { const el = document.querySelector("main"); if (el) el.scrollTop = el.scrollHeight; return el ? el.scrollTop : -1; })()');
          await new Promise(resolve => setTimeout(resolve, SHOT_SCROLL_BOTTOM_WAIT_MS));
          const bottom = await shoot();
          const bottomPath = shotPath.replace(/\.png$/i, "-bottom.png");
          ctx.fs.writeFileSync(bottomPath, bottom.toPNG());
          process.stdout.write(`dashboard shot saved: ${bottomPath}\n`);
        }
        // 排查用：按区间逐张截图，验证活跃时段等图表确实跟着 7/14/30/全部 变化
        if (process.env.CODEX_TOKEN_DASHBOARD_SHOT_RANGE) {
          const keys = String(process.env.CODEX_TOKEN_DASHBOARD_SHOT_RANGE).split(",");
          for (const raw of keys) {
            const rangeKey = Number(raw) || 0;
            await ctx.mainWindow.webContents.executeJavaScript(
              `(() => {
                   const btn = document.querySelector('#range button[data-key="${rangeKey}"]');
                   if (btn) btn.click();
                   const hours = document.querySelector('#hours');
                   if (hours) hours.scrollIntoView({ block: 'center' });
                   return !!btn;
                 })()`
            );
            await new Promise(resolve => setTimeout(resolve, SHOT_RANGE_WAIT_MS));
            const rangeShot = await shoot();
            const rangePath = shotPath.replace(/\.png$/i, "-range" + (rangeKey || "all") + ".png");
            ctx.fs.writeFileSync(rangePath, rangeShot.toPNG());
            process.stdout.write(`dashboard shot saved: ${rangePath}\n`);
          }
        }
        // 排查用：切到指定时段指标后再截一张（tokens / speed）
        if (process.env.CODEX_TOKEN_DASHBOARD_SHOT_HOUR) {
          const metric = String(process.env.CODEX_TOKEN_DASHBOARD_SHOT_HOUR).replace(/[^a-z]/gi, "");
          await ctx.mainWindow.webContents.executeJavaScript(
            `(() => { const el = document.querySelector('#hour-tabs button[data-metric="${metric}"]'); if (el) el.click(); return !!el; })()`
          );
          await ctx.mainWindow.webContents.executeJavaScript('(() => { const el = document.querySelector("main"); if (el) el.scrollTop = el.scrollHeight; return el ? el.scrollTop : -1; })()');
          await new Promise(resolve => setTimeout(resolve, SHOT_HOUR_WAIT_MS));
          const hourShot = await shoot();
          const hourPath = shotPath.replace(/\.png$/i, "-" + metric + ".png");
          ctx.fs.writeFileSync(hourPath, hourShot.toPNG());
          process.stdout.write(`dashboard shot saved: ${hourPath}\n`);
        }
      } catch (error) {
        process.stdout.write(`dashboard shot failed: ${error.message}\n`);
      }
    }, SHOT_DASHBOARD_OUTER_DELAY_MS);
  }
}

module.exports = { installShotDiagnostics };
