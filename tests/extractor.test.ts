/**
 * Step 5 提取器 — 单元测试
 * @author longfei5
 * @date 2026/3/12
 *
 * 验证正则模式匹配、扫描器去重、Prompt 模板生成、Extractor 门面集成
 */

import { describe, it, expect } from "vitest";
import { scanMessage } from "../src/core/extractor/patterns.js";
import { buildExtractPrompt } from "../src/core/extractor/prompts.js";
import { Extractor } from "../src/core/extractor/index.js";
import type { QueueItem } from "../src/core/types/memory.js";

describe("Step 5: 提取器", () => {
  // ─── 正则模式匹配 ────────────────────────────

  describe("正则扫描 — 显式纠正", () => {
    it("应匹配「不要用 xxx」", () => {
      const matches = scanMessage("不要用 PageHelper，手写分页");
      expect(matches.length).toBeGreaterThan(0);
      expect(matches.some((m) => m.patternType === "correction")).toBe(true);
      expect(matches.find((m) => m.patternType === "correction")!.confidence).toBe(0.85);
    });

    it("应匹配「别用 xxx」", () => {
      const matches = scanMessage("别用 Lombok，手写 getter");
      expect(matches.some((m) => m.patternType === "correction")).toBe(true);
    });

    it("应匹配「改用/改成 xxx」", () => {
      const matches = scanMessage("改用 MyBatis-Plus 的分页插件");
      expect(matches.some((m) => m.patternType === "correction")).toBe(true);
    });

    it("应匹配「错了/不对」", () => {
      const matches = scanMessage("不是这样，应该用 LIMIT OFFSET");
      expect(matches.some((m) => m.patternType === "correction")).toBe(true);
    });
  });

  describe("正则扫描 — 偏好声明", () => {
    it("应匹配「我们统一用 xxx」", () => {
      const matches = scanMessage("我们项目统一用 ResponseWrapper 返回");
      expect(matches.some((m) => m.patternType === "preference")).toBe(true);
      expect(matches.find((m) => m.patternType === "preference")!.suggestedType).toBe(
        "principles",
      );
    });

    it("应匹配「必须/一定要」", () => {
      const matches = scanMessage("必须加事务注解");
      expect(matches.some((m) => m.patternType === "preference")).toBe(true);
    });

    it("应匹配「记住：xxx」", () => {
      const matches = scanMessage("记住：所有接口都要鉴权");
      expect(matches.some((m) => m.patternType === "preference")).toBe(true);
    });
  });

  describe("正则扫描 — 经验分享", () => {
    it("应匹配「上次遇到」", () => {
      const matches = scanMessage("上次遇到过这个问题，是连接池爆了");
      expect(matches.some((m) => m.patternType === "experience")).toBe(true);
      expect(matches.find((m) => m.patternType === "experience")!.suggestedType).toBe("cases");
    });

    it("应匹配「线上出过」", () => {
      const matches = scanMessage("线上出现过 OOM，原因是批量太大");
      expect(matches.some((m) => m.patternType === "experience")).toBe(true);
    });

    it("应匹配「踩过坑」", () => {
      const matches = scanMessage("踩过坑，HikariCP 默认值太小");
      expect(matches.some((m) => m.patternType === "experience")).toBe(true);
    });
  });

  describe("正则扫描 — 确认", () => {
    it("应匹配简短确认词", () => {
      const matches = scanMessage("对");
      expect(matches.some((m) => m.patternType === "confirmation")).toBe(true);
      expect(matches.find((m) => m.patternType === "confirmation")!.confidence).toBe(0.50);
    });

    it("应匹配「没错」", () => {
      const matches = scanMessage("没错");
      expect(matches.some((m) => m.patternType === "confirmation")).toBe(true);
    });
  });

  // ─── 误匹配排除 ──────────────────────────────

  describe("误匹配排除", () => {
    it("代码块中的关键词不应匹配", () => {
      const message = "请看这段代码：\n```java\n// 不要用这个方法\npublic void test() {}\n```";
      const matches = scanMessage(message);
      // 代码块应被跳过
      expect(matches.filter((m) => m.patternType === "correction")).toHaveLength(0);
    });

    it("无记忆信号的普通消息应返回空", () => {
      const matches = scanMessage("帮我写一个用户列表查询接口");
      expect(matches).toHaveLength(0);
    });
  });

  // ─── 去重逻辑 ────────────────────────────────

  describe("去重逻辑", () => {
    it("同类型多次命中应只保留一个", () => {
      // 这条消息可能命中多个 correction 模式
      const matches = scanMessage("不要用 PageHelper，应该改用手写 SQL");
      const corrections = matches.filter((m) => m.patternType === "correction");
      expect(corrections).toHaveLength(1);
    });
  });

  // ─── 提取 Prompt ─────────────────────────────

  describe("提取 Prompt 模板", () => {
    it("有候选项时应包含队列内容", () => {
      const queue: QueueItem[] = [
        {
          pattern: "correction",
          matchedText: "不要用 PageHelper",
          suggestedType: "details",
          confidence: 0.85,
          capturedAt: "2026-03-12T10:00:00Z",
        },
      ];

      const prompt = buildExtractPrompt(queue);

      expect(prompt).toContain("不要用 PageHelper");
      expect(prompt).toContain("store_memory");
      expect(prompt).toContain("clear_candidate_queue");
      expect(prompt).toContain("Delta");
    });

    it("空队列时应提示无候选项", () => {
      const prompt = buildExtractPrompt([]);
      expect(prompt).toContain("无候选项");
      // 仍然应包含补充遗漏的指引
      expect(prompt).toContain("补充遗漏");
    });
  });

  // ─── Extractor 门面 ──────────────────────────

  describe("Extractor 门面", () => {
    const extractor = new Extractor();

    it("scan 应返回匹配结果", () => {
      const matches = extractor.scan("不要用 Lombok，手写 getter");
      expect(matches.length).toBeGreaterThan(0);
    });

    it("toQueueItem 应正确转换", () => {
      const matches = extractor.scan("我们团队统一用 Guava Cache");
      expect(matches.length).toBeGreaterThan(0);

      const item = extractor.toQueueItem(matches[0], "session-123");
      expect(item.pattern).toBeTruthy();
      expect(item.matchedText).toBeTruthy();
      expect(item.sessionId).toBe("session-123");
      expect(item.capturedAt).toBeTruthy();
    });

    it("getExtractPrompt 应生成有效 Prompt", () => {
      const prompt = extractor.getExtractPrompt([]);
      expect(prompt).toContain("记忆提取器");
      expect(prompt).toContain("第一步");
      expect(prompt).toContain("第二步");
      expect(prompt).toContain("第三步");
    });
  });
});
