/**
 * 重建器 — 从单条记忆文件重建聚合文件
 * @author longfei5
 * @date 2026/9/15
 *
 * 多机 git 同步的核心保障：registry.yaml 和 MEMORY.md 都是"派生物"，
 * 真相源是 details/cases/principles 下的单条记忆文件（frontmatter 自包含元数据）。
 * 合并冲突时丢弃聚合文件的冲突版本、以文件集并集重建 — 永不丢记忆条目。
 *
 * 幂等性：对未变化的状态重复执行不产生写入（避免每次同步都产生空提交）。
 */

import type { MemoryEntry, MemoryRegistry, MemoryType } from "../types/memory.js";
import { FileManager } from "./file-manager.js";
import { IndexManager } from "./index-manager.js";

/** 重建结果 */
export interface RebuildResult {
  /** 扫描到的记忆文件数 */
  filesScanned: number;
  /** 重建后的注册表条目数 */
  registryEntries: number;
  /** 索引新增的条目数 */
  indexAdded: number;
  /** 索引移除的失效条目数 */
  indexRemoved: number;
}

export class Rebuilder {
  private readonly fileManager: FileManager;
  private readonly indexManager: IndexManager;

  constructor(fileManager: FileManager, indexManager: IndexManager) {
    this.fileManager = fileManager;
    this.indexManager = indexManager;
  }

  /**
   * 重建聚合文件，使其与磁盘上的记忆文件集一致
   *
   * registry：文件集为准 — 新文件补条目（frontmatter → 旧注册表 → 文件名推断），
   * 已删文件移除条目；未变化条目原样保留（保 hitCount/createdAt，保证幂等）。
   * MEMORY.md：索引中缺失的文件补行（归入匹配分类或"未分类"），指向已删文件的行移除。
   */
  async rebuild(): Promise<RebuildResult> {
    const files = await this.fileManager.listMemoryFiles();
    const oldRegistry = await this.fileManager.loadRegistry();
    const oldByPath = new Map(oldRegistry.entries.map((e) => [e.filePath, e]));

    // ─── 重建 registry ───
    const entries: MemoryEntry[] = [];
    for (const filePath of files) {
      const old = oldByPath.get(filePath);
      const content = await this.fileManager.readMemoryFile(filePath);

      if (content) {
        const now = new Date().toISOString();
        entries.push({
          filePath,
          type: content.type,
          summary: content.title,
          keywords: content.keywords ?? old?.keywords ?? [filePath],
          // 旧条目保留原时间戳与命中统计；新条目取文件内记录的时间
          createdAt: old?.createdAt ?? content.createdAt ?? content.source.timestamp,
          updatedAt: old?.updatedAt ?? now,
          hitCount: old?.hitCount ?? 0,
          ...(old?.lastHitAt ? { lastHitAt: old.lastHitAt } : {}),
        });
      } else if (old) {
        // 文件无法解析但存在：保守保留旧条目
        entries.push(old);
      }
    }

    // 条目按 filePath 排序，保证序列化结果确定（利于 git 合并）
    entries.sort((a, b) => (a.filePath < b.filePath ? -1 : 1));

    if (!this.sameEntries(oldRegistry.entries, entries)) {
      const registry: MemoryRegistry = { entries, lastUpdated: oldRegistry.lastUpdated };
      await this.fileManager.saveRegistry(registry);
    }

    // ─── 重建 MEMORY.md ───
    const parsed = await this.indexManager.parseIndex();
    const indexedPaths = new Set<string>();
    for (const [, h2] of parsed.sections) {
      for (const [, items] of h2) {
        for (const item of items) {
          if (item.filePath) indexedPaths.add(item.filePath);
        }
      }
    }

    let indexAdded = 0;
    for (const filePath of files) {
      if (!indexedPaths.has(filePath)) {
        const content = await this.fileManager.readMemoryFile(filePath);
        if (!content) continue;
        await this.indexManager.appendEntry({
          summary: content.title,
          filePath,
          keywords: content.keywords ?? [],
        });
        indexAdded++;
      }
    }

    let indexRemoved = 0;
    const filesSet = new Set(files);
    for (const filePath of indexedPaths) {
      if (!filesSet.has(filePath)) {
        await this.indexManager.removeEntry(filePath);
        indexRemoved++;
      }
    }

    // 去重：同一文件的多条索引行（跨机重复学习同一记忆时 union 合并会产生重复行）
    const deduped = await this.dedupeIndex();
    if (deduped > 0) indexRemoved += deduped;

    return {
      filesScanned: files.length,
      registryEntries: entries.length,
      indexAdded,
      indexRemoved,
    };
  }

  /** 按文件路径去重索引行，返回移除的行数 */
  private async dedupeIndex(): Promise<number> {
    const raw = await this.indexManager.readIndex();
    const seen = new Set<string>();
    const lines = raw.split("\n");
    const deduped = lines.filter((line) => {
      const match = line.match(/\[详情\]\(([^)]+)\)/);
      if (!match) return true; // 非条目行原样保留
      if (seen.has(match[1])) return false;
      seen.add(match[1]);
      return true;
    });
    if (deduped.length === lines.length) return 0;
    await this.indexManager.writeIndex(deduped.join("\n"));
    return lines.length - deduped.length;
  }

  /** 比较两组条目是否等价（忽略 lastUpdated，只看业务字段） */
  private sameEntries(a: MemoryEntry[], b: MemoryEntry[]): boolean {
    if (a.length !== b.length) return false;
    const bByPath = new Map(b.map((e) => [e.filePath, e]));
    for (const entry of a) {
      const other = bByPath.get(entry.filePath);
      if (!other) return false;
      if (
        entry.type !== other.type ||
        entry.summary !== other.summary ||
        entry.hitCount !== other.hitCount ||
        JSON.stringify(entry.keywords) !== JSON.stringify(other.keywords)
      ) {
        return false;
      }
    }
    return true;
  }
}

/** 记忆文件路径 → 类型（与目录结构对应） */
export function typeFromPath(filePath: string): MemoryType | null {
  if (filePath.startsWith("details/")) return "details";
  if (filePath.startsWith("cases/")) return "cases";
  if (filePath.startsWith("principles/")) return "principles";
  return null;
}
