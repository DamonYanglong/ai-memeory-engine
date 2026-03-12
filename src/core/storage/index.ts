/**
 * 存储器门面 — 整合文件管理、索引、冲突检测、关联链接
 * @author longfei5
 * @date 2026/3/11
 *
 * 提供 store_memory 的完整流程：
 * 冲突检测 → 写入文件 → 建立关联 → 更新索引 → 更新注册表
 */

import type {
  CandidateMemory,
  StoreResult,
  ConflictChoice,
  ConflictRelation,
  MemoryEntry,
  MemoryContent,
  MemoryStats,
  ConflictInfo,
  QueueItem,
  EngineConfig,
} from "../types/memory.js";
import { DEFAULT_CONFIG } from "../types/memory.js";
import { FileManager } from "./file-manager.js";
import { IndexManager } from "./index-manager.js";
import { LinkManager } from "./link-manager.js";
import { ConflictDetector } from "./conflict.js";
import { CandidateQueue } from "./candidate-queue.js";

export class Storage {
  readonly fileManager: FileManager;
  readonly indexManager: IndexManager;
  readonly linkManager: LinkManager;
  readonly conflictDetector: ConflictDetector;
  readonly candidateQueue: CandidateQueue;
  private readonly config: EngineConfig;

  constructor(memoryDir: string, config: Partial<EngineConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.fileManager = new FileManager(memoryDir, this.config);
    this.indexManager = new IndexManager(memoryDir, this.config.indexFile);
    this.linkManager = new LinkManager(this.fileManager, this.config);
    this.conflictDetector = new ConflictDetector(this.fileManager, this.indexManager, memoryDir);
    this.candidateQueue = new CandidateQueue(memoryDir, this.config.candidateQueueFile);
  }

  /** 初始化存储目录 */
  async initialize(): Promise<void> {
    await this.fileManager.ensureDirs();
  }

  /**
   * 存储一条候选记忆（核心写入流程）
   *
   * 1. 置信度检查
   * 2. 准备文件名
   * 3. 冲突检测
   * 4. 写入文件
   * 5. 建立关联链接
   * 6. 更新索引
   * 7. 更新注册表
   */
  async store(candidate: CandidateMemory): Promise<StoreResult> {
    // 1. 置信度检查
    if (candidate.confidence < this.config.minConfidence) {
      return { status: "skipped", reason: "low_confidence" };
    }

    // 2. 准备文件名
    const prepared = this.fileManager.prepare(candidate);

    // 3. 冲突检测
    const conflict = await this.conflictDetector.detect(candidate, prepared.filePath);
    if (conflict && conflict.conflictEntries.length > 0) {
      // 返回第一个冲突，宿主模型判断具体关系
      return this.conflictDetector.createConflict(
        candidate,
        prepared.filePath,
        conflict.conflictEntries[0],
      );
    }

    // 4. 写入文件
    await this.fileManager.writeMemoryFile(prepared);

    // 5. 建立关联链接
    await this.linkManager.establishLinks(
      prepared.filePath,
      candidate.keywords,
      candidate.summary,
    );

    // 6. 更新索引
    await this.indexManager.appendEntry({
      summary: candidate.summary,
      filePath: prepared.filePath,
      keywords: candidate.keywords,
    });

    // 7. 更新注册表
    const now = new Date().toISOString();
    const entry: MemoryEntry = {
      filePath: prepared.filePath,
      type: candidate.type,
      summary: candidate.summary,
      keywords: candidate.keywords,
      createdAt: now,
      updatedAt: now,
      hitCount: 0,
    };
    await this.fileManager.addToRegistry(entry);

    return { status: "success", filePath: prepared.filePath };
  }

  /** 裁决冲突（支持关系类型分发） */
  async resolveConflict(
    conflictId: string,
    choice: ConflictChoice,
    candidate?: CandidateMemory,
    relation?: ConflictRelation,
  ): Promise<{ status: "resolved"; action: string }> {
    return this.conflictDetector.resolve(conflictId, choice, candidate, relation);
  }

  /** 读取记忆详情 */
  async readMemory(filePath: string): Promise<MemoryContent | null> {
    return this.fileManager.readMemoryFile(filePath);
  }

  /** 按关键词搜索 */
  async search(keywords: string[]): Promise<MemoryEntry[]> {
    return this.fileManager.searchByKeywords(keywords);
  }

  /** 获取统计信息 */
  async getStats(): Promise<MemoryStats> {
    return this.fileManager.getStats();
  }

  /** 获取待裁决冲突列表 */
  async listPendingConflicts(): Promise<ConflictInfo[]> {
    return this.conflictDetector.listPendingConflicts();
  }

  /** 读取索引内容 */
  async getIndex(): Promise<string> {
    return this.indexManager.readIndex();
  }

  // ─── 候选队列代理 ─────────────────────────────

  async getCandidateQueue(): Promise<QueueItem[]> {
    return this.candidateQueue.getAll();
  }

  async appendCandidate(item: QueueItem): Promise<void> {
    return this.candidateQueue.append(item);
  }

  async clearCandidateQueue(): Promise<void> {
    return this.candidateQueue.clear();
  }
}
