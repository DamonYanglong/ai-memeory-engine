/**
 * 重建器测试 — 聚合文件作为派生物的一致性恢复
 * @author longfei5
 * @date 2026/9/15
 *
 * 验证多机同步的核心保障：
 * 1. frontmatter 自包含：单条记忆文件携带重建所需元数据
 * 2. registry/MEMORY.md 损坏或缺失时可从文件集恢复
 * 3. rebuild 幂等：重复执行不产生额外写入
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import matter from "gray-matter";
import { Storage } from "../src/core/storage/index.js";
import type { CandidateMemory } from "../src/core/types/memory.js";

function makeCandidate(summary: string, keywords: string[]): CandidateMemory {
  return {
    type: "principles",
    trigger: "preference",
    summary,
    detail: `${summary} 的详细内容。`,
    keywords,
    confidence: 0.85,
  };
}

describe("Rebuild", () => {
  let memoryDir: string;
  let storage: Storage;

  beforeEach(async () => {
    memoryDir = await mkdtemp(join(tmpdir(), "ai-memory-rebuild-"));
    storage = new Storage(memoryDir);
    await storage.initialize();
  });

  afterEach(async () => {
    await rm(memoryDir, { recursive: true, force: true });
  });

  it("新写入的记忆文件包含 frontmatter 元数据（keywords 随文件走）", async () => {
    const result = await storage.store(makeCandidate("统一使用 pnpm", ["pnpm", "包管理"]));

    expect(result.status).toBe("success");
    if (result.status !== "success") return;

    const raw = await readFile(join(memoryDir, result.filePath), "utf-8");
    const { data } = matter(raw);
    expect(data.keywords).toEqual(["pnpm", "包管理"]);
    expect(data.type).toBe("principles");
    expect(data.summary).toBe("统一使用 pnpm");

    // readMemoryFile 能解析回 keywords
    const content = await storage.readMemory(result.filePath);
    expect(content?.keywords).toEqual(["pnpm", "包管理"]);
  });

  it("registry 条目丢失后 rebuild 恢复", async () => {
    const r1 = await storage.store(makeCandidate("统一使用 pnpm", ["pnpm"]));
    const r2 = await storage.store(makeCandidate("不用 PageHelper", ["PageHelper", "分页"]));
    if (r1.status !== "success" || r2.status !== "success") throw new Error("store 失败");

    // 模拟同步事故：registry 被清空
    await writeFile(join(memoryDir, ".meta/registry.yaml"), "entries: []\n", "utf-8");

    const result = await storage.rebuild();
    expect(result.filesScanned).toBe(2);
    expect(result.registryEntries).toBe(2);

    const content = await storage.readMemory(r1.filePath);
    expect(content).not.toBeNull();
    // 恢复后检索功能可用
    const hits = await storage.search(["pnpm"]);
    expect(hits).toHaveLength(1);
    expect(hits[0].filePath).toBe(r1.filePath);
    expect(hits[0].keywords).toEqual(["pnpm"]);
  });

  it("MEMORY.md 行丢失后 rebuild 恢复", async () => {
    const r = await storage.store(makeCandidate("统一使用 pnpm", ["pnpm"]));
    if (r.status !== "success") throw new Error("store 失败");

    // 模拟同步事故：索引文件被清空
    await writeFile(join(memoryDir, "MEMORY.md"), "", "utf-8");

    await storage.rebuild();
    const index = await storage.getIndex();
    expect(index).toContain(r.filePath);
    expect(index).toContain("统一使用 pnpm");
  });

  it("记忆文件删除后 rebuild 清理 registry 与索引中的残留条目", async () => {
    const r1 = await storage.store(makeCandidate("统一使用 pnpm", ["pnpm"]));
    const r2 = await storage.store(makeCandidate("不用 PageHelper", ["PageHelper"]));
    if (r1.status !== "success" || r2.status !== "success") throw new Error("store 失败");

    await rm(join(memoryDir, r1.filePath), { force: true });

    const result = await storage.rebuild();
    expect(result.registryEntries).toBe(1);

    const hits = await storage.search(["pnpm"]);
    expect(hits).toHaveLength(0);
    const index = await storage.getIndex();
    expect(index).not.toContain(r1.filePath);
    expect(index).toContain(r2.filePath);
  });

  it("rebuild 幂等：对一致状态重复执行不产生写入", async () => {
    await storage.store(makeCandidate("统一使用 pnpm", ["pnpm"]));
    await storage.rebuild();

    const registryBefore = await readFile(join(memoryDir, ".meta/registry.yaml"), "utf-8");
    const indexBefore = await readFile(join(memoryDir, "MEMORY.md"), "utf-8");

    await storage.rebuild();

    const registryAfter = await readFile(join(memoryDir, ".meta/registry.yaml"), "utf-8");
    const indexAfter = await readFile(join(memoryDir, "MEMORY.md"), "utf-8");
    expect(registryAfter).toBe(registryBefore);
    expect(indexAfter).toBe(indexBefore);
  });

  it("无 frontmatter 的旧格式文件也能 rebuild（回退到旧 registry 条目）", async () => {
    const r = await storage.store(makeCandidate("统一使用 pnpm", ["pnpm", "包管理"]));
    if (r.status !== "success") throw new Error("store 失败");

    // 剥掉 frontmatter 模拟旧格式文件
    const raw = await readFile(join(memoryDir, r.filePath), "utf-8");
    const { content } = matter(raw);
    await writeFile(join(memoryDir, r.filePath), content, "utf-8");

    // registry 保留（提供 keywords 回退），清空索引验证恢复
    await writeFile(join(memoryDir, "MEMORY.md"), "", "utf-8");
    await storage.rebuild();

    const index = await storage.getIndex();
    expect(index).toContain(r.filePath);
    const hits = await storage.search(["pnpm"]);
    expect(hits).toHaveLength(1);
  });
});
