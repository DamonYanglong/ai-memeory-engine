#!/usr/bin/env node

/**
 * 提取 Prompt CLI — Stop Hook 调用
 * @author longfei5
 * @date 2026/3/12
 *
 * 读取候选队列，如果有候选项则输出提取 Prompt。
 * 宿主模型收到后执行记忆提取流程。
 * 队列为空时静默退出。
 */

import { join } from "node:path";
import { CandidateQueue } from "../core/storage/candidate-queue.js";
import { buildExtractPrompt } from "../core/extractor/prompts.js";

const memoryDir = process.env.MEMORY_DIR ?? join(process.cwd(), "memory");
const queue = new CandidateQueue(memoryDir);

async function main() {
  const items = await queue.getAll();

  if (items.length === 0) {
    process.exit(0);
  }

  // 输出提取 Prompt，作为 Stop Hook 的 additional context
  console.log(buildExtractPrompt(items));
}

main().catch(() => process.exit(0));
