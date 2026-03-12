/**
 * ai-memory-engine 核心类型定义
 * @author longfei5
 * @date 2026/3/11
 *
 * 所有模块共享的数据结构，定义了记忆系统的数据契约。
 * 类型按职责分组：消息、记忆、存储、检索、冲突、候选队列。
 */

// ─── 消息与会话 ────────────────────────────────

/** 统一内部消息格式，适配器负责双向转换 */
export interface Message {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp?: string;
}

/** 会话历史，包含消息列表和元数据 */
export interface ConversationHistory {
  messages: Message[];
  metadata: {
    tool: string; // "claude-code" | "codex" | "opencode" | ...
    sessionId: string;
    startTime: string;
    endTime?: string;
  };
}

/** 会话上下文，传递给生命周期钩子 */
export interface SessionContext {
  sessionId: string;
  tool: string;
  workingDirectory?: string;
  projectName?: string;
}

// ─── 记忆类型 ──────────────────────────────────

/** 记忆分类：对应三个存储目录 */
export type MemoryType = "details" | "cases" | "principles";

/** 记忆触发来源 */
export type TriggerType = "user_correction" | "preference" | "experience" | "confirmation";

/** 候选记忆：提取器输出，尚未写入存储 */
export interface CandidateMemory {
  type: MemoryType;
  trigger: TriggerType;
  summary: string;
  detail: string;
  keywords: string[];
  confidence: number;
  source?: {
    sessionId?: string;
    timestamp?: string;
    context?: string; // 触发时的对话片段
  };
}

/** 已存储的记忆条目（索引级别，不含详情内容） */
export interface MemoryEntry {
  filePath: string; // 相对于 memory/ 的路径，如 "details/no-pagehelper.md"
  type: MemoryType;
  summary: string;
  keywords: string[];
  createdAt: string;
  updatedAt: string;
  hitCount: number;
  lastHitAt?: string;
}

/** 详情文件的完整内容（解析后的结构） */
export interface MemoryContent {
  title: string;
  type: MemoryType;
  /** 要点/经过/规范 — 因类型不同而异 */
  body: string;
  source: {
    trigger: TriggerType;
    timestamp: string;
    confidence: number;
  };
  relatedMemories: RelatedMemory[];
}

/** 关联记忆链接 */
export interface RelatedMemory {
  filePath: string;
  reason: string; // 一句话说明关联原因
}

// ─── 存储结果 ──────────────────────────────────

/** store_memory 的返回结果 */
export type StoreResult =
  | { status: "success"; filePath: string }
  | {
      status: "conflict";
      conflictId: string;
      existing: ConflictSide;
      incoming: ConflictSide;
      /** 冲突判断 Prompt，宿主模型据此判断关系后调用 resolve_conflict */
      judgmentPrompt: string;
    }
  | { status: "skipped"; reason: "duplicate" | "low_confidence" };

/** 冲突双方的摘要信息 */
export interface ConflictSide {
  filePath: string;
  summary: string;
  keywords: string[];
}

/** 冲突详情，供用户裁决 */
export interface ConflictInfo {
  conflictId: string;
  existing: ConflictSide;
  incoming: ConflictSide;
  detectedAt: string;
}

/** 冲突裁决选项 */
export type ConflictChoice = "replace" | "keep" | "coexist";

/** 新旧记忆的四种关系 */
export type ConflictRelation = "contradicts" | "supplements" | "duplicates" | "unrelated";

// ─── 候选队列（正则预筛选层） ──────────────────

/** 候选队列条目：正则匹配后写入，等待宿主模型审核 */
export interface QueueItem {
  pattern: string; // 匹配的正则模式名
  matchedText: string; // 用户原文片段
  suggestedType: MemoryType;
  confidence: number;
  capturedAt: string;
  sessionId?: string;
}

// ─── 统计与管理 ─────────────────────────────────

/** get_memory_stats 返回 */
export interface MemoryStats {
  total: number;
  byType: Record<MemoryType, number>;
  lastUpdated: string;
}

// ─── MCP 工具定义 ───────────────────────────────

/** MCP 工具名称枚举 */
export const MCP_TOOLS = {
  // 存储
  STORE_MEMORY: "store_memory",
  RESOLVE_CONFLICT: "resolve_conflict",
  // 管理
  GET_MEMORY_STATS: "get_memory_stats",
  LIST_PENDING_CONFLICTS: "list_pending_conflicts",
  // 候选队列
  GET_CANDIDATE_QUEUE: "get_candidate_queue",
  APPEND_CANDIDATE: "append_candidate",
  CLEAR_CANDIDATE_QUEUE: "clear_candidate_queue",
  // 提取器
  SCAN_MESSAGE: "scan_message",
  GET_EXTRACT_PROMPT: "get_extract_prompt",
} as const;

// ─── 元数据注册表 ──────────────────────────────

/** 元数据注册表：.meta/registry.yaml 的结构，记忆的结构化索引 */
export interface MemoryRegistry {
  entries: MemoryEntry[];
  lastUpdated: string;
}

/** 待裁决冲突的持久化记录：.meta/pending-conflicts.yaml */
export interface PendingConflicts {
  conflicts: ConflictInfo[];
}

/** 新记忆的候选写入数据（含已生成的文件名） */
export interface PreparedMemory {
  candidate: CandidateMemory;
  fileName: string; // 规范化后的文件名，如 "no-pagehelper-use-limit"
  filePath: string; // 完整相对路径，如 "details/no-pagehelper-use-limit.md"
}

// ─── 配置 ──────────────────────────────────────

/** 引擎配置 */
export interface EngineConfig {
  /** 记忆存储根目录 */
  memoryDir: string;
  /** 索引文件名，默认 MEMORY.md */
  indexFile: string;
  /** 候选队列文件名 */
  candidateQueueFile: string;
  /** 单文件关联链接上限 */
  maxRelatedMemories: number;
  /** 索引最大行数，超出触发冷热管理 */
  maxIndexLines: number;
  /** 低置信度阈值，低于此值跳过 */
  minConfidence: number;
}

/** 默认配置 */
export const DEFAULT_CONFIG: EngineConfig = {
  memoryDir: "memory",
  indexFile: "MEMORY.md",
  candidateQueueFile: ".meta/candidates-queue.yaml",
  maxRelatedMemories: 10,
  maxIndexLines: 200,
  minConfidence: 0.6,
};
