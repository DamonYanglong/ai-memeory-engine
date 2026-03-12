/**
 * Step 4 冲突检测完善 — 单元测试
 * @author longfei5
 * @date 2026/3/12
 *
 * 验证四种关系类型的裁决逻辑、Prompt 模板生成、supplements 追加、端到端冲突流程
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import yaml from "js-yaml";
import { Storage } from "../src/core/storage/index.js";
import { buildJudgmentPrompt } from "../src/core/storage/prompts.js";
import type { CandidateMemory, MemoryRegistry, ConflictSide } from "../src/core/types/memory.js";

describe("Step 4: 冲突检测完善", () => {
  let memoryDir: string;
  let storage: Storage;

  /** 辅助：快速创建一条记忆并存入 */
  const storeMemory = (overrides: Partial<CandidateMemory> = {}) =>
    storage.store({
      type: "details",
      trigger: "user_correction",
      summary: "分页不用 PageHelper",
      detail: "手写 LIMIT OFFSET，不使用 PageHelper。",
      keywords: ["PageHelper", "分页", "MySQL"],
      confidence: 0.9,
      ...overrides,
    });

  beforeEach(async () => {
    memoryDir = await mkdtemp(join(tmpdir(), "ai-memory-conflict-"));
    storage = new Storage(memoryDir);
    await storage.initialize();
  });

  afterEach(async () => {
    await rm(memoryDir, { recursive: true, force: true });
  });

  // ─── Prompt 模板 ──────────────────────────────

  describe("Prompt 模板", () => {
    it("应生成包含双方信息的判断 Prompt", () => {
      const existing: ConflictSide = {
        filePath: "details/pagehelper-pagination.md",
        summary: "分页不用 PageHelper",
        keywords: ["PageHelper", "分页"],
      };
      const incoming: ConflictSide = {
        filePath: "details/pagehelper-pagination.md",
        summary: "分页改用 PageHelper",
        keywords: ["PageHelper", "分页"],
      };

      const prompt = buildJudgmentPrompt(existing, incoming);

      expect(prompt).toContain("已有记忆");
      expect(prompt).toContain("新记忆");
      expect(prompt).toContain("分页不用 PageHelper");
      expect(prompt).toContain("分页改用 PageHelper");
      expect(prompt).toContain("contradicts");
      expect(prompt).toContain("supplements");
      expect(prompt).toContain("duplicates");
      expect(prompt).toContain("unrelated");
      expect(prompt).toContain("resolve_conflict");
    });
  });

  // ─── store 返回 judgmentPrompt ─────────────────

  describe("store 冲突结果", () => {
    it("冲突时应返回 judgmentPrompt", async () => {
      await storeMemory();
      const r2 = await storeMemory({ summary: "分页改用 PageHelper" });

      expect(r2.status).toBe("conflict");
      if (r2.status === "conflict") {
        expect(r2.judgmentPrompt).toBeDefined();
        expect(r2.judgmentPrompt).toContain("已有记忆");
        expect(r2.judgmentPrompt).toContain("resolve_conflict");
      }
    });
  });

  // ─── supplements 处理 ─────────────────────────

  describe("relation: supplements", () => {
    it("应追加内容到已有文件", async () => {
      const r1 = await storeMemory();
      expect(r1.status).toBe("success");

      const r2 = await storeMemory({
        summary: "PageHelper 的替代方案",
        detail: "可以使用 MyBatis-Plus 的分页插件作为替代。",
      });

      expect(r2.status).toBe("conflict");
      if (r2.status === "conflict") {
        await storage.resolveConflict(
          r2.conflictId,
          "keep", // supplements 不需要 choice，但接口需要
          {
            type: "details",
            trigger: "user_correction",
            summary: "PageHelper 的替代方案",
            detail: "可以使用 MyBatis-Plus 的分页插件作为替代。",
            keywords: ["PageHelper", "分页", "MyBatis-Plus"],
            confidence: 0.9,
          },
          "supplements",
        );

        // 验证已有文件被追加
        if (r1.status === "success") {
          const content = await readFile(join(memoryDir, r1.filePath), "utf-8");
          expect(content).toContain("手写 LIMIT OFFSET");
          expect(content).toContain("MyBatis-Plus 的分页插件");
        }
      }
    });

    it("应合并新关键词到注册表", async () => {
      await storeMemory();
      const r2 = await storeMemory({ summary: "补充信息" });

      if (r2.status === "conflict") {
        await storage.resolveConflict(
          r2.conflictId,
          "keep",
          {
            type: "details",
            trigger: "user_correction",
            summary: "补充信息",
            detail: "补充详情",
            keywords: ["PageHelper", "分页", "NewKeyword"],
            confidence: 0.9,
          },
          "supplements",
        );

        // 验证注册表关键词被合并
        const registryRaw = await readFile(join(memoryDir, ".meta", "registry.yaml"), "utf-8");
        const registry = yaml.load(registryRaw) as MemoryRegistry;
        const entry = registry.entries[0];
        expect(entry.keywords).toContain("NewKeyword");
      }
    });
  });

  // ─── duplicates 处理 ──────────────────────────

  describe("relation: duplicates", () => {
    it("应跳过写入并清除冲突记录", async () => {
      await storeMemory();
      const r2 = await storeMemory({ summary: "相同内容" });

      if (r2.status === "conflict") {
        const result = await storage.resolveConflict(r2.conflictId, "keep", undefined, "duplicates");

        expect(result.status).toBe("resolved");
        expect(result.action).toBe("skipped_duplicate");

        // 冲突记录应被清除
        const pending = await storage.listPendingConflicts();
        expect(pending).toHaveLength(0);

        // 注册表应只有一条
        const stats = await storage.getStats();
        expect(stats.total).toBe(1);
      }
    });
  });

  // ─── unrelated 处理 ───────────────────────────

  describe("relation: unrelated", () => {
    it("应写入新文件并更新索引和注册表", async () => {
      await storeMemory();
      const r2 = await storeMemory({
        summary: "实际上完全不同的主题",
        detail: "这是一个无关的记忆。",
        keywords: ["PageHelper", "分页", "不同主题"],
      });

      if (r2.status === "conflict") {
        const result = await storage.resolveConflict(
          r2.conflictId,
          "keep",
          {
            type: "details",
            trigger: "experience",
            summary: "实际上完全不同的主题",
            detail: "这是一个无关的记忆。",
            keywords: ["PageHelper", "分页", "不同主题"],
            confidence: 0.85,
          },
          "unrelated",
        );

        expect(result.action).toBe("created_new");

        // 注册表应有两条
        const stats = await storage.getStats();
        expect(stats.total).toBe(2);

        // 索引应有两条
        const index = await storage.getIndex();
        expect(index).toContain("分页不用 PageHelper");
        expect(index).toContain("实际上完全不同的主题");
      }
    });
  });

  // ─── contradicts 处理 ─────────────────────────

  describe("relation: contradicts", () => {
    it("replace 应替换已有文件", async () => {
      const r1 = await storeMemory();
      const r2 = await storeMemory({ summary: "分页改用 PageHelper", detail: "统一用 PageHelper。" });

      if (r2.status === "conflict" && r1.status === "success") {
        await storage.resolveConflict(
          r2.conflictId,
          "replace",
          {
            type: "details",
            trigger: "user_correction",
            summary: "分页改用 PageHelper",
            detail: "统一用 PageHelper。",
            keywords: ["PageHelper", "分页", "MySQL"],
            confidence: 0.9,
          },
          "contradicts",
        );

        // 验证已有文件被替换
        const content = await readFile(join(memoryDir, r1.filePath), "utf-8");
        expect(content).toContain("统一用 PageHelper");
        expect(content).not.toContain("手写 LIMIT OFFSET");
      }
    });

    it("coexist 应创建新文件并更新注册表和索引", async () => {
      await storeMemory();
      const r2 = await storeMemory({ summary: "另一种分页方案" });

      if (r2.status === "conflict") {
        const result = await storage.resolveConflict(
          r2.conflictId,
          "coexist",
          {
            type: "details",
            trigger: "user_correction",
            summary: "另一种分页方案",
            detail: "使用 RowBounds。",
            keywords: ["PageHelper", "分页", "RowBounds"],
            confidence: 0.9,
          },
          "contradicts",
        );

        expect(result.action).toBe("coexisted");

        // 注册表应有两条
        const stats = await storage.getStats();
        expect(stats.total).toBe(2);
      }
    });
  });

  // ─── 端到端流程 ───────────────────────────────

  describe("端到端冲突流程", () => {
    it("完整流程：store → conflict → resolve(supplements)", async () => {
      // 1. 写入初始记忆
      const r1 = await storeMemory();
      expect(r1.status).toBe("success");

      // 2. 写入冲突记忆
      const r2 = await storeMemory({
        summary: "PageHelper 性能问题补充",
        detail: "PageHelper 在大数据量时性能下降严重。",
        keywords: ["PageHelper", "性能", "分页"],
      });
      expect(r2.status).toBe("conflict");

      // 3. 宿主模型根据 judgmentPrompt 判断为 supplements
      if (r2.status === "conflict") {
        expect(r2.judgmentPrompt).toContain("contradicts");

        // 4. 调用 resolve_conflict
        const result = await storage.resolveConflict(
          r2.conflictId,
          "keep",
          {
            type: "details",
            trigger: "user_correction",
            summary: "PageHelper 性能问题补充",
            detail: "PageHelper 在大数据量时性能下降严重。",
            keywords: ["PageHelper", "性能", "分页"],
            confidence: 0.9,
          },
          "supplements",
        );

        expect(result.status).toBe("resolved");
        expect(result.action).toBe("supplemented");

        // 5. 验证无待裁决冲突
        const pending = await storage.listPendingConflicts();
        expect(pending).toHaveLength(0);
      }
    });
  });
});
