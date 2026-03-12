/**
 * 冲突检测器 — 关键词比对发现潜在冲突
 * @author longfei5
 * @date 2026/3/11
 *
 * 职责：
 * 1. 关键词搜索找出与新记忆可能冲突的已有记忆
 * 2. 持久化待裁决冲突（pending-conflicts.yaml）
 * 3. 执行裁决结果（替换/保留/共存）
 *
 * 注意：关系判断（矛盾/补充/重复/无关）由宿主模型完成，
 * 此模块只做关键词级别的"候选发现"。
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import yaml from "js-yaml";
import { randomUUID } from "node:crypto";
import type {
  CandidateMemory,
  ConflictInfo,
  ConflictChoice,
  ConflictRelation,
  ConflictSide,
  MemoryEntry,
  PendingConflicts,
  StoreResult,
} from "../types/memory.js";
import { FileManager } from "./file-manager.js";
import { IndexManager } from "./index-manager.js";
import { buildJudgmentPrompt } from "./prompts.js";

export class ConflictDetector {
  private readonly fileManager: FileManager;
  private readonly indexManager: IndexManager;
  private readonly conflictsPath: string;

  constructor(fileManager: FileManager, indexManager: IndexManager, memoryDir: string) {
    this.fileManager = fileManager;
    this.indexManager = indexManager;
    this.conflictsPath = join(memoryDir, ".meta", "pending-conflicts.yaml");
  }

  /**
   * 检测新记忆是否与已有记忆冲突
   *
   * 检测逻辑：
   * 1. 文件名已存在 → 直接返回冲突
   * 2. 关键词搜索找到高度重叠的条目 → 返回冲突候选
   *
   * 返回 null 表示无冲突，可安全写入。
   */
  async detect(
    candidate: CandidateMemory,
    filePath: string,
  ): Promise<{ conflictEntries: MemoryEntry[] } | null> {
    // 1. 文件名冲突检查
    const exists = await this.fileManager.fileExists(filePath);
    if (exists) {
      // 文件已存在，找出对应的注册表条目
      const entries = await this.fileManager.searchByKeywords(candidate.keywords);
      const match = entries.find((e) => e.filePath === filePath);
      if (match) {
        return { conflictEntries: [match] };
      }
    }

    // 2. 关键词重叠检查
    const matches = await this.fileManager.searchByKeywords(candidate.keywords);
    // 计算每个匹配的关键词交集数量
    const querySet = new Set(candidate.keywords.map((k) => k.toLowerCase()));

    const highOverlap = matches.filter((entry) => {
      const entrySet = new Set(entry.keywords.map((k) => k.toLowerCase()));
      const overlap = [...querySet].filter((k) => entrySet.has(k));
      // 交集 >= 50% 的关键词算高度重叠
      return overlap.length >= Math.ceil(candidate.keywords.length / 2);
    });

    if (highOverlap.length > 0) {
      return { conflictEntries: highOverlap };
    }

    return null;
  }

  /**
   * 创建待裁决冲突记录
   *
   * 返回 StoreResult.conflict，包含冲突 ID 供后续 resolve 使用
   */
  async createConflict(
    candidate: CandidateMemory,
    candidatePath: string,
    existingEntry: MemoryEntry,
  ): Promise<StoreResult> {
    const conflictId = randomUUID();

    const existing: ConflictSide = {
      filePath: existingEntry.filePath,
      summary: existingEntry.summary,
      keywords: existingEntry.keywords,
    };

    const incoming: ConflictSide = {
      filePath: candidatePath,
      summary: candidate.summary,
      keywords: candidate.keywords,
    };

    const conflict: ConflictInfo = {
      conflictId,
      existing,
      incoming,
      detectedAt: new Date().toISOString(),
    };

    // 持久化
    await this.saveConflict(conflict);

    // 生成判断 Prompt，供宿主模型判断关系类型
    const judgmentPrompt = buildJudgmentPrompt(existing, incoming);

    return {
      status: "conflict",
      conflictId,
      existing,
      incoming,
      judgmentPrompt,
    };
  }

  /**
   * 执行冲突裁决（支持四种关系类型）
   *
   * - contradicts → 需要 choice（replace/keep/coexist）
   * - supplements → 自动追加到已有文件
   * - duplicates → 跳过，返回 resolved
   * - unrelated → 正常写入新文件
   *
   * 兼容旧调用：不传 relation 时按原逻辑走 choice 路径
   */
  async resolve(
    conflictId: string,
    choice: ConflictChoice,
    candidate?: CandidateMemory,
    relation?: ConflictRelation,
  ): Promise<{ status: "resolved"; action: string }> {
    const conflict = await this.getConflict(conflictId);
    if (!conflict) {
      throw new Error(`冲突 ${conflictId} 不存在`);
    }

    let action: string;

    // 按关系类型分发处理
    if (relation === "supplements") {
      action = await this.handleSupplements(conflict, candidate);
    } else if (relation === "duplicates") {
      action = "skipped_duplicate";
    } else if (relation === "unrelated") {
      action = await this.handleUnrelated(conflict, candidate);
    } else {
      // contradicts 或兼容旧调用（无 relation）
      action = await this.handleContradicts(conflict, choice, candidate);
    }

    // 移除已裁决的冲突
    await this.removeConflict(conflictId);

    return { status: "resolved", action };
  }

  /**
   * 处理 supplements：追加新内容到已有文件的主体区块
   */
  private async handleSupplements(
    conflict: ConflictInfo,
    candidate?: CandidateMemory,
  ): Promise<string> {
    if (!candidate) return "supplements_no_candidate";

    // 根据已有文件类型确定要追加的区块名
    const sectionName = this.getSectionName(conflict.existing.filePath);

    // 追加新内容到已有文件
    await this.fileManager.appendToSection(
      conflict.existing.filePath,
      sectionName,
      `\n${candidate.detail}`,
    );

    // 更新注册表中的 updatedAt
    const registry = await this.fileManager.loadRegistry();
    const entry = registry.entries.find((e) => e.filePath === conflict.existing.filePath);
    if (entry) {
      entry.updatedAt = new Date().toISOString();
      // 合并新关键词到已有条目
      const existingSet = new Set(entry.keywords.map((k) => k.toLowerCase()));
      for (const kw of candidate.keywords) {
        if (!existingSet.has(kw.toLowerCase())) {
          entry.keywords.push(kw);
        }
      }
      await this.fileManager.saveRegistry(registry);
    }

    return "supplemented";
  }

  /**
   * 处理 unrelated：新记忆与已有记忆无关，正常写入新文件
   */
  private async handleUnrelated(
    _conflict: ConflictInfo,
    candidate?: CandidateMemory,
  ): Promise<string> {
    if (!candidate) return "unrelated_no_candidate";

    const prepared = this.fileManager.prepare(candidate);
    // 文件名可能与已有文件冲突（关键词相似但实际无关），追加序号
    let path = prepared.filePath;
    let counter = 2;
    while (await this.fileManager.fileExists(path)) {
      path = prepared.filePath.replace(".md", `-${counter}.md`);
      counter++;
    }

    await this.fileManager.writeMemoryFile({ ...prepared, filePath: path });

    // 更新索引
    await this.indexManager.appendEntry({
      summary: candidate.summary,
      filePath: path,
      keywords: candidate.keywords,
    });

    // 更新注册表
    const now = new Date().toISOString();
    await this.fileManager.addToRegistry({
      filePath: path,
      type: candidate.type,
      summary: candidate.summary,
      keywords: candidate.keywords,
      createdAt: now,
      updatedAt: now,
      hitCount: 0,
    });

    return "created_new";
  }

  /**
   * 处理 contradicts：按用户选择执行（replace/keep/coexist）
   */
  private async handleContradicts(
    conflict: ConflictInfo,
    choice: ConflictChoice,
    candidate?: CandidateMemory,
  ): Promise<string> {
    switch (choice) {
      case "replace":
        if (candidate) {
          const prepared = this.fileManager.prepare(candidate);
          // 使用已有文件路径，确保替换而非创建新文件
          await this.fileManager.writeMemoryFile({
            ...prepared,
            filePath: conflict.existing.filePath,
          });
          // 更新注册表
          const now = new Date().toISOString();
          await this.fileManager.addToRegistry({
            filePath: conflict.existing.filePath,
            type: candidate.type,
            summary: candidate.summary,
            keywords: candidate.keywords,
            createdAt: now,
            updatedAt: now,
            hitCount: 0,
          });
          // 更新索引：需要替换已有行（此处简化为追加，Phase 2 优化）
        }
        return "replaced";

      case "keep":
        return "kept_existing";

      case "coexist":
        if (candidate) {
          const prepared = this.fileManager.prepare(candidate);
          let path = prepared.filePath;
          let counter = 2;
          while (await this.fileManager.fileExists(path)) {
            path = prepared.filePath.replace(".md", `-${counter}.md`);
            counter++;
          }
          await this.fileManager.writeMemoryFile({ ...prepared, filePath: path });

          // 更新索引
          await this.indexManager.appendEntry({
            summary: candidate.summary,
            filePath: path,
            keywords: candidate.keywords,
          });

          // 更新注册表
          const now = new Date().toISOString();
          await this.fileManager.addToRegistry({
            filePath: path,
            type: candidate.type,
            summary: candidate.summary,
            keywords: candidate.keywords,
            createdAt: now,
            updatedAt: now,
            hitCount: 0,
          });
        }
        return "coexisted";
    }
  }

  /**
   * 根据文件路径推断主体区块名称
   */
  private getSectionName(filePath: string): string {
    if (filePath.startsWith("cases/")) return "经过";
    if (filePath.startsWith("principles/")) return "规范";
    return "要点"; // details 默认
  }

  // ─── 持久化 ────────────────────────────────────

  async loadConflicts(): Promise<PendingConflicts> {
    try {
      const raw = await readFile(this.conflictsPath, "utf-8");
      return (yaml.load(raw) as PendingConflicts) ?? { conflicts: [] };
    } catch {
      return { conflicts: [] };
    }
  }

  async getConflict(conflictId: string): Promise<ConflictInfo | null> {
    const pending = await this.loadConflicts();
    return pending.conflicts.find((c) => c.conflictId === conflictId) ?? null;
  }

  async listPendingConflicts(): Promise<ConflictInfo[]> {
    const pending = await this.loadConflicts();
    return pending.conflicts;
  }

  private async saveConflict(conflict: ConflictInfo): Promise<void> {
    const pending = await this.loadConflicts();
    pending.conflicts.push(conflict);
    await mkdir(dirname(this.conflictsPath), { recursive: true });
    await writeFile(this.conflictsPath, yaml.dump(pending, { lineWidth: 120 }), "utf-8");
  }

  private async removeConflict(conflictId: string): Promise<void> {
    const pending = await this.loadConflicts();
    pending.conflicts = pending.conflicts.filter((c) => c.conflictId !== conflictId);
    await writeFile(this.conflictsPath, yaml.dump(pending, { lineWidth: 120 }), "utf-8");
  }
}
