/**
 * 检索器门面 — 整合匹配、格式化、命中记录
 * @author longfei5
 * @date 2026/3/12
 *
 * 实现渐进披露：摘要索引 → 详情展开 → 关联跳转
 */

import type { RetrievalResult, MemoryEntry } from "../types/memory.js";
import { FileManager } from "../storage/file-manager.js";
import { Matcher } from "./matcher.js";
import { Formatter, estimateTokens } from "./formatter.js";

/** 默认 token 预算（15% of 200K） */
const DEFAULT_TOKEN_BUDGET = 30000;

export class Retriever {
  private readonly fileManager: FileManager;
  private readonly matcher: Matcher;
  private readonly formatter: Formatter;

  constructor(fileManager: FileManager) {
    this.fileManager = fileManager;
    this.matcher = new Matcher();
    this.formatter = new Formatter();
  }

  /**
   * 检索相关记忆（完整渐进披露流程）
   *
   * 1. 从 registry 加载所有条目
   * 2. 关键词匹配评分
   * 3. 展开命中详情（受 token 预算限制）
   * 4. 记录命中
   */
  async retrieve(query: string, tokenBudget = DEFAULT_TOKEN_BUDGET): Promise<RetrievalResult> {
    const registry = await this.fileManager.loadRegistry();
    if (registry.entries.length === 0) {
      return { formatted: "", entries: [], stats: { totalMatched: 0, totalTokensEstimate: 0 } };
    }

    // 匹配评分
    const matches = this.matcher.match(query, registry.entries);
    if (matches.length === 0) {
      return this.formatter.formatSummaries([]);
    }

    // 展开详情
    const items: Array<{ entry: MemoryEntry; body: string }> = [];
    for (const match of matches) {
      const content = await this.fileManager.readMemoryFile(match.entry.filePath);
      if (content) {
        items.push({ entry: match.entry, body: content.body });
      }
    }

    // 格式化（含预算控制）
    const result = this.formatter.formatWithDetails(items, tokenBudget);

    // 记录命中
    for (const entry of result.entries) {
      await this.recordHit(entry.filePath);
    }

    return result;
  }

  /** 展开单个详情文件的要点 */
  async expand(filePath: string): Promise<string> {
    const content = await this.fileManager.readMemoryFile(filePath);
    if (!content) return "";
    await this.recordHit(filePath);
    return content.body;
  }

  /** 记录命中（更新注册表中的 hitCount 和 lastHitAt） */
  private async recordHit(filePath: string): Promise<void> {
    const registry = await this.fileManager.loadRegistry();
    const entry = registry.entries.find((e) => e.filePath === filePath);
    if (entry) {
      entry.hitCount++;
      entry.lastHitAt = new Date().toISOString();
      entry.updatedAt = new Date().toISOString();
      await this.fileManager.saveRegistry(registry);
    }
  }
}

export { Matcher } from "./matcher.js";
export { Formatter, estimateTokens } from "./formatter.js";
