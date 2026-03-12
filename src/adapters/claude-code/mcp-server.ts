#!/usr/bin/env node

/**
 * AI Memory Engine — MCP Server 入口
 * @author longfei5
 * @date 2026/3/11
 *
 * Claude Code 适配器的 MCP Server，通过 stdio 与宿主工具通信。
 * 注册所有记忆操作工具，每个工具只做纯数据操作，不调用 LLM。
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { join } from "node:path";
import { MCP_TOOLS } from "../../core/types/memory.js";
import { Storage } from "../../core/storage/index.js";
import { Extractor } from "../../core/extractor/index.js";

/** 记忆存储目录，默认为当前工作目录下的 memory/ */
const memoryDir = process.env.MEMORY_DIR ?? join(process.cwd(), "memory");

const storage = new Storage(memoryDir);
const extractor = new Extractor();

const server = new McpServer({
  name: "ai-memory-engine",
  version: "0.1.0",
});

// ─── 存储工具 ──────────────────────────────────

server.tool(
  MCP_TOOLS.STORE_MEMORY,
  "存储一条候选记忆。执行冲突检测，返回 success/conflict/skipped。",
  {
    type: z.enum(["details", "cases", "principles"]).describe("记忆分类"),
    trigger: z.enum(["user_correction", "preference", "experience", "confirmation"]).describe("触发来源"),
    summary: z.string().describe("一句话摘要"),
    detail: z.string().describe("详细内容"),
    keywords: z.array(z.string()).describe("关键词列表"),
    confidence: z.number().min(0).max(1).describe("置信度 0-1"),
  },
  async (params) => {
    await storage.initialize();
    const result = await storage.store({
      type: params.type,
      trigger: params.trigger,
      summary: params.summary,
      detail: params.detail,
      keywords: params.keywords,
      confidence: params.confidence,
    });
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result) }],
    };
  },
);

server.tool(
  MCP_TOOLS.RESOLVE_CONFLICT,
  "裁决记忆冲突。宿主模型判断关系后调用：contradicts 需 choice，supplements/duplicates/unrelated 自动处理。",
  {
    conflictId: z.string().describe("冲突 ID"),
    relation: z
      .enum(["contradicts", "supplements", "duplicates", "unrelated"])
      .describe("新旧记忆关系：contradicts=矛盾, supplements=补充, duplicates=重复, unrelated=无关"),
    choice: z
      .enum(["replace", "keep", "coexist"])
      .optional()
      .describe("裁决选项（仅 contradicts 时需要，其他关系自动处理）"),
    candidate: z
      .object({
        type: z.enum(["details", "cases", "principles"]),
        trigger: z.enum(["user_correction", "preference", "experience", "confirmation"]),
        summary: z.string(),
        detail: z.string(),
        keywords: z.array(z.string()),
        confidence: z.number().min(0).max(1),
      })
      .optional()
      .describe("候选记忆数据（supplements/unrelated/replace/coexist 时需要）"),
  },
  async (params) => {
    const result = await storage.resolveConflict(
      params.conflictId,
      params.choice ?? "keep",
      params.candidate,
      params.relation,
    );
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result) }],
    };
  },
);

// ─── 管理工具 ──────────────────────────────────

server.tool(
  MCP_TOOLS.GET_MEMORY_STATS,
  "获取记忆库统计信息：总数、按类型分布、最后更新时间。",
  {},
  async () => {
    const stats = await storage.getStats();
    return {
      content: [{ type: "text" as const, text: JSON.stringify(stats) }],
    };
  },
);

server.tool(
  MCP_TOOLS.LIST_PENDING_CONFLICTS,
  "列出所有待裁决的记忆冲突。",
  {},
  async () => {
    const conflicts = await storage.listPendingConflicts();
    return {
      content: [{ type: "text" as const, text: JSON.stringify(conflicts) }],
    };
  },
);

// ─── 候选队列工具 ──────────────────────────────

server.tool(
  MCP_TOOLS.GET_CANDIDATE_QUEUE,
  "读取候选记忆队列。正则预筛选层写入的候选项，等待宿主模型审核。",
  {},
  async () => {
    const items = await storage.getCandidateQueue();
    return {
      content: [{ type: "text" as const, text: JSON.stringify(items) }],
    };
  },
);

server.tool(
  MCP_TOOLS.APPEND_CANDIDATE,
  "向候选队列追加一条记录。由正则预筛选 Hook 调用。",
  {
    pattern: z.string().describe("匹配的正则模式名"),
    matchedText: z.string().describe("用户原文片段"),
    suggestedType: z.enum(["details", "cases", "principles"]).describe("建议的记忆分类"),
    confidence: z.number().min(0).max(1).describe("匹配置信度"),
  },
  async (params) => {
    await storage.appendCandidate({
      pattern: params.pattern,
      matchedText: params.matchedText,
      suggestedType: params.suggestedType,
      confidence: params.confidence,
      capturedAt: new Date().toISOString(),
    });
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ status: "appended" }) }],
    };
  },
);

server.tool(
  MCP_TOOLS.CLEAR_CANDIDATE_QUEUE,
  "清空候选记忆队列。宿主模型审核完毕后调用。",
  {},
  async () => {
    await storage.clearCandidateQueue();
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ status: "cleared" }) }],
    };
  },
);

// ─── 提取器工具 ──────────────────────────────

server.tool(
  MCP_TOOLS.SCAN_MESSAGE,
  "扫描用户消息，检测记忆信号（纠正/偏好/经验/确认）。返回匹配结果列表。由 Hook 层调用。",
  {
    message: z.string().describe("用户消息原文"),
    sessionId: z.string().optional().describe("当前会话 ID"),
  },
  async (params) => {
    const matches = extractor.scan(params.message);

    // 如果有命中，自动追加到候选队列
    for (const match of matches) {
      const item = extractor.toQueueItem(match, params.sessionId);
      await storage.appendCandidate(item);
    }

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            matchCount: matches.length,
            matches: matches.map((m) => ({
              type: m.patternType,
              text: m.matchedText,
              confidence: m.confidence,
              suggestedType: m.suggestedType,
            })),
          }),
        },
      ],
    };
  },
);

server.tool(
  MCP_TOOLS.GET_EXTRACT_PROMPT,
  "获取提取 Prompt。会话结束时调用，返回引导宿主模型执行记忆提取的 Prompt。",
  {},
  async () => {
    const queue = await storage.getCandidateQueue();
    const prompt = extractor.getExtractPrompt(queue);
    return {
      content: [{ type: "text" as const, text: prompt }],
    };
  },
);

// ─── 启动服务 ──────────────────────────────────

async function main() {
  await storage.initialize();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("MCP Server 启动失败:", error);
  process.exit(1);
});
