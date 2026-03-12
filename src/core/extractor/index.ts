/**
 * 提取器门面 — 整合正则扫描 + Prompt 生成
 * @author longfei5
 * @date 2026/3/12
 *
 * 对外提供两个核心能力：
 * 1. scan(message) — 正则扫描用户消息，返回匹配结果
 * 2. buildExtractPrompt(queue) — 生成提取 Prompt 供宿主模型执行
 */

import type { QueueItem } from "../types/memory.js";
import { scanMessage, type ScanMatch } from "./patterns.js";
import { buildExtractPrompt } from "./prompts.js";

export class Extractor {
  /**
   * 扫描用户消息，检测记忆信号
   *
   * 用于第 1 层正则预筛选（Hook 中调用）。
   * 返回空数组表示消息中无记忆信号。
   */
  scan(message: string): ScanMatch[] {
    return scanMessage(message);
  }

  /**
   * 将扫描结果转为候选队列条目
   *
   * 便于 Hook 将扫描结果直接写入候选队列。
   */
  toQueueItem(match: ScanMatch, sessionId?: string): QueueItem {
    return {
      pattern: match.patternName,
      matchedText: match.matchedText,
      suggestedType: match.suggestedType,
      confidence: match.confidence,
      capturedAt: new Date().toISOString(),
      sessionId,
    };
  }

  /**
   * 生成提取 Prompt
   *
   * 用于第 2 层宿主模型精提取（会话结束时注入）。
   */
  getExtractPrompt(queueItems: QueueItem[]): string {
    return buildExtractPrompt(queueItems);
  }
}

// 重新导出类型，方便外部引用
export type { ScanMatch } from "./patterns.js";
