/**
 * 关联链接管理器 — 跨记忆文件的双向链接维护
 * @author longfei5
 * @date 2026/3/11
 *
 * 根据关键词交集建立关联，双向写入，上限 10 条。
 * 将树形索引升级为知识图谱。
 */

import type { MemoryEntry, RelatedMemory, EngineConfig } from "../types/memory.js";
import { DEFAULT_CONFIG } from "../types/memory.js";
import { FileManager } from "./file-manager.js";

/** 关联匹配结果 */
export interface LinkCandidate {
  entry: MemoryEntry;
  /** 共同关键词数量 */
  overlapCount: number;
  /** 共同关键词列表 */
  commonKeywords: string[];
}

export class LinkManager {
  private readonly fileManager: FileManager;
  private readonly maxLinks: number;

  constructor(fileManager: FileManager, config: Partial<EngineConfig> = {}) {
    this.fileManager = fileManager;
    this.maxLinks = config.maxRelatedMemories ?? DEFAULT_CONFIG.maxRelatedMemories;
  }

  /**
   * 为新记忆查找关联候选
   *
   * 规则：
   * - 交集 >= 2 个关键词 → 确定关联
   * - 交集 == 1 → 返回但标记为 weak（宿主模型可二次确认）
   * - 交集 == 0 → 不关联
   */
  async findRelated(
    keywords: string[],
    excludePath?: string,
  ): Promise<LinkCandidate[]> {
    const allEntries = await this.fileManager.searchByKeywords(keywords);
    const querySet = new Set(keywords.map((k) => k.toLowerCase()));

    const candidates: LinkCandidate[] = [];

    for (const entry of allEntries) {
      // 排除自身
      if (entry.filePath === excludePath) continue;

      const entryKeywords = entry.keywords.map((k) => k.toLowerCase());
      const common = entryKeywords.filter((k) => querySet.has(k));

      if (common.length > 0) {
        candidates.push({
          entry,
          overlapCount: common.length,
          commonKeywords: common,
        });
      }
    }

    // 按交集数量降序排序
    candidates.sort((a, b) => b.overlapCount - a.overlapCount);

    return candidates;
  }

  /**
   * 为新写入的记忆建立双向关联链接
   *
   * 1. 查找关联候选（交集 >= 2）
   * 2. 取 top N，更新新文件的关联区块
   * 3. 同时更新对方文件的关联区块（双向）
   */
  async establishLinks(
    newFilePath: string,
    newKeywords: string[],
    newSummary: string,
  ): Promise<RelatedMemory[]> {
    const candidates = await this.findRelated(newKeywords, newFilePath);
    // 只取交集 >= 2 的确定关联
    const strongCandidates = candidates.filter((c) => c.overlapCount >= 2);
    const topCandidates = strongCandidates.slice(0, this.maxLinks);

    if (topCandidates.length === 0) return [];

    // 新文件 → 已有文件的链接
    const outgoingLinks: RelatedMemory[] = topCandidates.map((c) => ({
      filePath: this.fileManager.getRelativePath(newFilePath, c.entry.filePath),
      reason: `共同关键词：${c.commonKeywords.join("、")}`,
    }));

    // 更新新文件的关联区块
    await this.fileManager.replaceRelatedSection(newFilePath, outgoingLinks);

    // 双向：更新已有文件的关联区块
    for (const candidate of topCandidates) {
      const existingContent = await this.fileManager.readMemoryFile(candidate.entry.filePath);
      if (!existingContent) continue;

      const incomingLink: RelatedMemory = {
        filePath: this.fileManager.getRelativePath(candidate.entry.filePath, newFilePath),
        reason: `共同关键词：${candidate.commonKeywords.join("、")}`,
      };

      const currentLinks = existingContent.relatedMemories;
      // 检查是否已存在
      const alreadyLinked = currentLinks.some(
        (l) => l.filePath === incomingLink.filePath,
      );
      if (alreadyLinked) continue;

      // 追加，控制上限
      const updatedLinks = [...currentLinks, incomingLink].slice(0, this.maxLinks);
      await this.fileManager.replaceRelatedSection(candidate.entry.filePath, updatedLinks);
    }

    return outgoingLinks;
  }
}
