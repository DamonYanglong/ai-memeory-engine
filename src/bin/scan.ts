#!/usr/bin/env node

/**
 * 正则预筛选 CLI — UserPromptSubmit Hook 调用
 * @author longfei5
 * @date 2026/3/12
 *
 * 读取用户消息（$USER_PROMPT 环境变量），执行正则扫描。
 * 命中时输出提示文本（作为 Hook additional context 注入给宿主模型）。
 * 未命中时静默退出。
 */

import { scanMessage } from "../core/extractor/patterns.js";

const userPrompt = process.env.USER_PROMPT ?? "";

if (!userPrompt) {
  process.exit(0);
}

const matches = scanMessage(userPrompt);

if (matches.length === 0) {
  process.exit(0);
}

// 输出提示，让宿主模型调用 scan_message MCP 工具入队
const types = matches.map((m) => m.patternType).join(", ");
console.log(
  `[ai-memory] 检测到记忆信号（${types}），请调用 scan_message 工具处理：message="${userPrompt.slice(0, 100)}"`,
);
