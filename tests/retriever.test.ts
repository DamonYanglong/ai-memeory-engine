/**
 * 检索器测试
 * @author longfei5
 * @date 2026/3/12
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Storage } from "../src/core/storage/index.js";
import { Retriever } from "../src/core/retriever/index.js";
import type { CandidateMemory } from "../src/core/types/memory.js";

describe("Retriever", () => {
  let memoryDir: string;
  let storage: Storage;
  let retriever: Retriever;

  beforeEach(async () => {
    memoryDir = await mkdtemp(join(tmpdir(), "ai-memory-ret-"));
    storage = new Storage(memoryDir);
    await storage.initialize();
    retriever = new Retriever(storage.fileManager);

    // 写入测试记忆
    await storage.store({
      type: "details", trigger: "user_correction",
      summary: "分页查询不用 PageHelper，手写 LIMIT OFFSET",
      detail: "项目分页统一手写 SQL，使用 LIMIT OFFSET 方式。",
      keywords: ["PageHelper", "分页", "MySQL", "LIMIT"],
      confidence: 0.9,
    });
    await storage.store({
      type: "principles", trigger: "preference",
      summary: "接口返回统一用 ResponseWrapper",
      detail: "所有 Controller 返回值统一使用 ResponseWrapper<T> 包装。",
      keywords: ["ResponseWrapper", "Controller", "接口规范"],
      confidence: 0.95,
    });
    await storage.store({
      type: "cases", trigger: "experience",
      summary: "Kafka 批量消费导致 OOM",
      detail: "消费者批量拉取 1000 条，高峰期内存溢出。改为流式消费。",
      keywords: ["Kafka", "OOM", "批量消费"],
      confidence: 0.85,
    });
  });

  afterEach(async () => {
    await rm(memoryDir, { recursive: true, force: true });
  });

  it("查询分页应命中 PageHelper 记忆", async () => {
    const result = await retriever.retrieve("分页查询怎么写");
    expect(result.entries.length).toBeGreaterThanOrEqual(1);
    expect(result.formatted).toContain("LIMIT OFFSET");
    expect(result.stats.totalMatched).toBeGreaterThanOrEqual(1);
  });

  it("查询 Kafka 应命中 OOM 案例", async () => {
    const result = await retriever.retrieve("Kafka 消费");
    expect(result.entries.length).toBeGreaterThanOrEqual(1);
    expect(result.formatted).toContain("OOM");
  });

  it("无关查询应返回空", async () => {
    const result = await retriever.retrieve("Docker 部署");
    expect(result.entries).toHaveLength(0);
  });

  it("expand 应返回要点内容", async () => {
    const stats = await storage.getStats();
    expect(stats.total).toBe(3);

    const entries = await storage.search(["PageHelper"]);
    expect(entries.length).toBeGreaterThanOrEqual(1);

    const body = await retriever.expand(entries[0].filePath);
    expect(body).toContain("LIMIT OFFSET");
  });

  it("检索后 hitCount 应递增", async () => {
    await retriever.retrieve("分页");
    const registry = await storage.fileManager.loadRegistry();
    const entry = registry.entries.find((e) => e.keywords.includes("PageHelper"));
    expect(entry?.hitCount).toBeGreaterThanOrEqual(1);
  });

  it("Token 预算超限应降级为摘要", async () => {
    // 极小预算，应至少有部分降级
    const result = await retriever.retrieve("分页 Kafka Controller", 50);
    // 预算很小，不会全部展开
    expect(result.stats.totalTokensEstimate).toBeLessThanOrEqual(100);
  });
});
