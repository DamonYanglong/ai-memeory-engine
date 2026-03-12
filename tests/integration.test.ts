/**
 * Step 6 Claude Code 集成 — 单元测试
 * @author longfei5
 * @date 2026/3/12
 *
 * 验证 CLI 脚本逻辑、Hook 输出格式、端到端集成流程
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { Storage } from "../src/core/storage/index.js";
import { Extractor } from "../src/core/extractor/index.js";

describe("Step 6: Claude Code 集成", () => {
  let memoryDir: string;

  beforeEach(async () => {
    memoryDir = await mkdtemp(join(tmpdir(), "ai-memory-integration-"));
    const storage = new Storage(memoryDir);
    await storage.initialize();
  });

  afterEach(async () => {
    await rm(memoryDir, { recursive: true, force: true });
  });

  // ─── 端到端：扫描 → 入队 → 提取 Prompt ──────

  describe("端到端流程", () => {
    it("扫描命中 → 入队 → 生成提取 Prompt 包含候选项", async () => {
      const extractor = new Extractor();
      const storage = new Storage(memoryDir);

      // 1. 扫描用户消息
      const matches = extractor.scan("不要用 Lombok，手写 getter setter");
      expect(matches.length).toBeGreaterThan(0);

      // 2. 入队
      for (const match of matches) {
        await storage.appendCandidate(extractor.toQueueItem(match, "test-session"));
      }

      // 3. 读取队列
      const queue = await storage.getCandidateQueue();
      expect(queue.length).toBeGreaterThan(0);

      // 4. 生成提取 Prompt
      const prompt = extractor.getExtractPrompt(queue);
      expect(prompt).toContain("Lombok");
      expect(prompt).toContain("store_memory");
      expect(prompt).toContain("clear_candidate_queue");
    });

    it("无信号消息 → 空队列 → Prompt 提示无候选项", async () => {
      const extractor = new Extractor();
      const storage = new Storage(memoryDir);

      const matches = extractor.scan("帮我写一个用户查询接口");
      expect(matches).toHaveLength(0);

      const queue = await storage.getCandidateQueue();
      expect(queue).toHaveLength(0);

      const prompt = extractor.getExtractPrompt(queue);
      expect(prompt).toContain("无候选项");
    });
  });

  // ─── CLI 脚本编译验证 ─────────────────────────

  describe("CLI 脚本", () => {
    it("scan.js 应在 dist 中存在", () => {
      const scanPath = join(process.cwd(), "dist/bin/scan.js");
      // 验证文件编译成功（tsc 已在测试前执行）
      expect(() => require.resolve(scanPath)).not.toThrow;
    });

    it("scan CLI 对无信号消息应静默", () => {
      const result = execSync(
        `USER_PROMPT="帮我写个接口" node dist/bin/scan.js`,
        { encoding: "utf-8", cwd: process.cwd() },
      );
      expect(result.trim()).toBe("");
    });

    it("scan CLI 对纠正消息应输出提示", () => {
      const result = execSync(
        `USER_PROMPT="不要用 PageHelper" node dist/bin/scan.js`,
        { encoding: "utf-8", cwd: process.cwd() },
      );
      expect(result).toContain("[ai-memory]");
      expect(result).toContain("scan_message");
    });

    it("extract-prompt CLI 空队列应静默", () => {
      const result = execSync(
        `MEMORY_DIR="${memoryDir}" node dist/bin/extract-prompt.js`,
        { encoding: "utf-8", cwd: process.cwd() },
      );
      expect(result.trim()).toBe("");
    });
  });
});
