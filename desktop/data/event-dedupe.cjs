"use strict";

/**
 * 请求级去重 —— 对齐 CC Switch v4 的计数口径。
 *
 * Codex 的 rollout 在 resume / fork 时会把此前整段历史「重放」写进新文件：
 * 本机 2026-07-24 的 4 个文件前 721～746 个 token_count 事件逐条完全相同，
 * 旧版索引按 filePath:lineNumber 逐行累加，等于把同一批请求算了 4 遍。
 * CC Switch 用 thread 内事件序号 + 用量签名跳过 replay 前缀，只计各分支新增。
 *
 * 我们的日志侧没有稳定的 request_id（token_count 事件里不带），因此统一用
 * 「本次请求用量五元组」作为请求指纹，让旧索引与磁盘日志能互相去重：
 *   input / cached_input / output / total / reasoning_output
 * 这五个值随上下文长度单调增长，两个不同请求撞出完全相同五元组的概率极低；
 * 实测旧索引 42151 条里识别出的 10607 条重复，与 CC 账本里已记账的
 * 7/14、7/15 原始会话 707/708 条签名一一对应，说明该指纹可靠。
 *
 * 注意：签名只用来判断「同一请求被写了几遍」，不是 token 计数本身。
 * 计数仍以 last_token_usage 逐条累加，绝不改用 total_token_usage 差分
 * （resume 文件首条的 total 已含历史累计，差分会凭空多算）。
 */

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** 五元组指纹。磁盘日志与旧索引必须调用同一个函数，才能跨来源互相去重。 */
function signatureOf(input, cached, output, total, reasoning) {
  return [num(input), num(cached), num(output), num(total), num(reasoning)].join(":");
}

/** 磁盘日志 payload.info.last_token_usage（snake_case） */
function usageSignature(usage) {
  if (!usage) return "";
  return signatureOf(
    usage.input_tokens,
    usage.cached_input_tokens,
    usage.output_tokens,
    usage.total_tokens,
    usage.reasoning_output_tokens
  );
}

/** 旧版 usage-index.json 的单条 record（camelCase） */
function recordSignature(record) {
  if (!record) return "";
  return signatureOf(
    record.inputTokens,
    record.cachedInputTokens,
    record.outputTokens,
    record.totalTokens,
    record.reasoningOutputTokens
  );
}

module.exports = {
  signatureOf,
  usageSignature,
  recordSignature
};
