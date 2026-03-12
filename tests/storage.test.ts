/**
 * 存储器集成测试
 * @author longfei5
 * @date 2026/3/11
 *
 * 验证 Step 2 核心流程：store → 文件正确生成 + 索引更新 + 注册表写入
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import yaml from "js-yaml";
import { Storage } from "../src/core/storage/index.js";
import type { CandidateMemory, MemoryRegistry } from "../src/core/types/memory.js";

describe("Storage", () => {
  let memoryDir: string;
  let storage: Storage;

  beforeEach(async () => {
    memoryDir = await mkdtemp(join(tmpdir(), "ai-memory-test-"));
    storage = new Storage(memoryDir);
    await storage.initialize();
  });

  afterEach(async () => {
    await rm(memoryDir, { recursive: true, force: true });
  });

  // ─── 基础写入 ────────────────────────────────

  describe("store", () => {
    it("应该成功写入 details 类型记忆", async () => {
      const candidate: CandidateMemory = {
        type: "details",
        trigger: "user_correction",
        summary: "分页查询不用 PageHelper",
        detail: "项目分页统一手写 LIMIT OFFSET，不使用 PageHelper 插件。",
        keywords: ["PageHelper", "分页", "MySQL"],
        confidence: 0.9,
      };

      const result = await storage.store(candidate);

      expect(result.status).toBe("success");
      if (result.status === "success") {
        expect(result.filePath).toMatch(/^details\/.+\.md$/);

        // 验证文件实际存在
        const content = await readFile(join(memoryDir, result.filePath), "utf-8");
        expect(content).toContain("# 分页查询不用 PageHelper");
        expect(content).toContain("## 要点");
        expect(content).toContain("LIMIT OFFSET");
        expect(content).toContain("触发：user_correction");
        expect(content).toContain("置信度：0.9");
      }
    });

    it("应该成功写入 cases 类型记忆", async () => {
      const candidate: CandidateMemory = {
        type: "cases",
        trigger: "experience",
        summary: "Kafka 批量消费导致 OOM",
        detail: "消费者批量拉取 1000 条，高峰期内存溢出。改为流式消费。",
        keywords: ["Kafka", "OOM", "消费者"],
        confidence: 0.85,
      };

      const result = await storage.store(candidate);

      expect(result.status).toBe("success");
      if (result.status === "success") {
        expect(result.filePath).toMatch(/^cases\/.+\.md$/);
        const content = await readFile(join(memoryDir, result.filePath), "utf-8");
        expect(content).toContain("## 经过");
      }
    });

    it("应该成功写入 principles 类型记忆", async () => {
      const candidate: CandidateMemory = {
        type: "principles",
        trigger: "preference",
        summary: "接口返回统一用 ResponseWrapper",
        detail: "所有 Controller 接口返回值统一使用 ResponseWrapper<T> 包装。",
        keywords: ["ResponseWrapper", "Controller", "规范"],
        confidence: 0.95,
      };

      const result = await storage.store(candidate);

      expect(result.status).toBe("success");
      if (result.status === "success") {
        expect(result.filePath).toMatch(/^principles\/.+\.md$/);
        const content = await readFile(join(memoryDir, result.filePath), "utf-8");
        expect(content).toContain("## 规范");
      }
    });

    it("低置信度应该跳过", async () => {
      const candidate: CandidateMemory = {
        type: "details",
        trigger: "confirmation",
        summary: "不确定的信息",
        detail: "...",
        keywords: ["test"],
        confidence: 0.3, // 低于 0.6 阈值
      };

      const result = await storage.store(candidate);
      expect(result.status).toBe("skipped");
      if (result.status === "skipped") {
        expect(result.reason).toBe("low_confidence");
      }
    });
  });

  // ─── 索引更新 ────────────────────────────────

  describe("index", () => {
    it("写入后索引应包含摘要和链接", async () => {
      const candidate: CandidateMemory = {
        type: "details",
        trigger: "user_correction",
        summary: "HikariCP 默认连接池偏小",
        detail: "默认 10 个连接，高并发场景需调大。",
        keywords: ["HikariCP", "连接池"],
        confidence: 0.9,
      };

      await storage.store(candidate);

      const index = await storage.getIndex();
      expect(index).toContain("HikariCP 默认连接池偏小");
      expect(index).toContain("[详情]");
    });

    it("多次写入索引不丢条目", async () => {
      await storage.store({
        type: "details",
        trigger: "user_correction",
        summary: "记忆 A",
        detail: "内容 A",
        keywords: ["keyA"],
        confidence: 0.9,
      });

      await storage.store({
        type: "details",
        trigger: "preference",
        summary: "记忆 B",
        detail: "内容 B",
        keywords: ["keyB"],
        confidence: 0.8,
      });

      const index = await storage.getIndex();
      expect(index).toContain("记忆 A");
      expect(index).toContain("记忆 B");
    });
  });

  // ─── 注册表 ──────────────────────────────────

  describe("registry", () => {
    it("写入后注册表应包含条目", async () => {
      await storage.store({
        type: "details",
        trigger: "user_correction",
        summary: "测试记忆",
        detail: "测试内容",
        keywords: ["test", "memory"],
        confidence: 0.9,
      });

      const registryRaw = await readFile(
        join(memoryDir, ".meta", "registry.yaml"),
        "utf-8",
      );
      const registry = yaml.load(registryRaw) as MemoryRegistry;

      expect(registry.entries).toHaveLength(1);
      expect(registry.entries[0].type).toBe("details");
      expect(registry.entries[0].keywords).toContain("test");
    });

    it("统计信息应正确", async () => {
      await storage.store({
        type: "details",
        trigger: "user_correction",
        summary: "d1",
        detail: "...",
        keywords: ["a"],
        confidence: 0.9,
      });
      await storage.store({
        type: "cases",
        trigger: "experience",
        summary: "c1",
        detail: "...",
        keywords: ["b"],
        confidence: 0.8,
      });

      const stats = await storage.getStats();
      expect(stats.total).toBe(2);
      expect(stats.byType.details).toBe(1);
      expect(stats.byType.cases).toBe(1);
      expect(stats.byType.principles).toBe(0);
    });
  });

  // ─── 冲突检测 ────────────────────────────────

  describe("conflict", () => {
    it("同关键词写入两次应返回冲突", async () => {
      const first: CandidateMemory = {
        type: "details",
        trigger: "user_correction",
        summary: "分页不用 PageHelper",
        detail: "手写 LIMIT",
        keywords: ["PageHelper", "分页", "MySQL"],
        confidence: 0.9,
      };

      const second: CandidateMemory = {
        type: "details",
        trigger: "user_correction",
        summary: "分页改用 PageHelper",
        detail: "统一用 PageHelper",
        keywords: ["PageHelper", "分页", "MySQL"],
        confidence: 0.9,
      };

      const r1 = await storage.store(first);
      expect(r1.status).toBe("success");

      const r2 = await storage.store(second);
      expect(r2.status).toBe("conflict");
      if (r2.status === "conflict") {
        expect(r2.conflictId).toBeTruthy();
        expect(r2.existing.keywords).toContain("PageHelper");
      }
    });

    it("裁决 keep 应保留原记忆", async () => {
      await storage.store({
        type: "details",
        trigger: "user_correction",
        summary: "original",
        detail: "original content",
        keywords: ["unique-key-a", "unique-key-b"],
        confidence: 0.9,
      });

      const r2 = await storage.store({
        type: "details",
        trigger: "user_correction",
        summary: "new version",
        detail: "new content",
        keywords: ["unique-key-a", "unique-key-b"],
        confidence: 0.9,
      });

      expect(r2.status).toBe("conflict");
      if (r2.status === "conflict") {
        await storage.resolveConflict(r2.conflictId, "keep");
        const pending = await storage.listPendingConflicts();
        expect(pending).toHaveLength(0);
      }
    });
  });

  // ─── 候选队列 ────────────────────────────────

  describe("candidate queue", () => {
    it("追加和读取候选项", async () => {
      await storage.appendCandidate({
        pattern: "correction",
        matchedText: "不要用 Lombok",
        suggestedType: "principles",
        confidence: 0.8,
        capturedAt: new Date().toISOString(),
      });

      const items = await storage.getCandidateQueue();
      expect(items).toHaveLength(1);
      expect(items[0].matchedText).toContain("Lombok");
    });

    it("清空队列", async () => {
      await storage.appendCandidate({
        pattern: "test",
        matchedText: "test",
        suggestedType: "details",
        confidence: 0.7,
        capturedAt: new Date().toISOString(),
      });

      await storage.clearCandidateQueue();
      const items = await storage.getCandidateQueue();
      expect(items).toHaveLength(0);
    });
  });

  // ─── 文件命名 ────────────────────────────────

  describe("file naming", () => {
    it("关键词应规范化为 kebab-case", () => {
      const name = storage.fileManager.normalizeFileName(["PageHelper", "分页查询"]);
      expect(name).toMatch(/^[a-z0-9\u4e00-\u9fff-]+$/);
      expect(name).toContain("pagehelper");
    });

    it("文件名不超过 50 字符", () => {
      const longKeywords = [
        "very-long-keyword-one",
        "very-long-keyword-two",
        "very-long-keyword-three",
        "very-long-keyword-four",
      ];
      const name = storage.fileManager.normalizeFileName(longKeywords);
      expect(name.length).toBeLessThanOrEqual(50);
    });
  });
});
