/**
 * 注入格式化器 — 检索结果格式化 + Token 预算管理
 * @author longfei5
 * @date 2026/3/12
 *
 * 将匹配的记忆格式化为可直接注入上下文的 Markdown，控制 Token 预算。
 */

import type { MemoryEntry, RetrievalResult } from "../types/memory.js";

/** 粗略估算 token 数（中英混合约 2 字符/token） */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 2);
}

/** 按类型分组标题 */
const TYPE_LABELS: Record<string, string> = {
  details: "知识点",
  cases: "相关经验",
  principles: "团队规范",
};

/** 类型优先级（全命中时截断顺序：先保留 principles） */
const TYPE_PRIORITY: Record<string, number> = {
  principles: 3,
  details: 2,
  cases: 1,
};

export class Formatter {
  /**
   * 格式化摘要级别的检索结果（第 1 层：只有摘要行）
   */
  formatSummaries(entries: MemoryEntry[]): RetrievalResult {
    if (entries.length === 0) {
      return { formatted: "", entries: [], stats: { totalMatched: 0, totalTokensEstimate: 0 } };
    }

    // 按类型分组
    const grouped = new Map<string, MemoryEntry[]>();
    for (const entry of entries) {
      const list = grouped.get(entry.type) ?? [];
      list.push(entry);
      grouped.set(entry.type, list);
    }

    // 按优先级排序输出
    const sections: string[] = ["# 相关记忆", "", "以下是与当前任务相关的历史记忆，供参考："];

    const sortedTypes = [...grouped.keys()].sort(
      (a, b) => (TYPE_PRIORITY[b] ?? 0) - (TYPE_PRIORITY[a] ?? 0),
    );

    for (const type of sortedTypes) {
      const items = grouped.get(type)!;
      sections.push("", `## ${TYPE_LABELS[type] ?? type}`);
      for (const item of items) {
        sections.push(`- ${item.summary}`);
        sections.push(`  [展开详情](${item.filePath})`);
      }
    }

    const formatted = sections.join("\n");
    return {
      formatted,
      entries,
      stats: {
        totalMatched: entries.length,
        totalTokensEstimate: estimateTokens(formatted),
      },
    };
  }

  /**
   * 格式化详情级别的检索结果（第 2 层：包含要点内容）
   */
  formatWithDetails(
    items: Array<{ entry: MemoryEntry; body: string }>,
    tokenBudget: number,
  ): RetrievalResult {
    if (items.length === 0) {
      return { formatted: "", entries: [], stats: { totalMatched: 0, totalTokensEstimate: 0 } };
    }

    // 按类型优先级排序
    const sorted = [...items].sort(
      (a, b) => (TYPE_PRIORITY[b.entry.type] ?? 0) - (TYPE_PRIORITY[a.entry.type] ?? 0),
    );

    const sections: string[] = ["# 相关记忆（已展开）"];
    let usedTokens = estimateTokens(sections[0]);
    const included: MemoryEntry[] = [];

    for (const item of sorted) {
      const block = `\n## ${item.entry.summary}\n${item.body}`;
      const blockTokens = estimateTokens(block);

      if (usedTokens + blockTokens > tokenBudget) {
        // 超预算：降级为摘要行
        const fallback = `\n- ${item.entry.summary} → [展开详情](${item.entry.filePath})`;
        const fallbackTokens = estimateTokens(fallback);
        if (usedTokens + fallbackTokens <= tokenBudget) {
          sections.push(fallback);
          usedTokens += fallbackTokens;
          included.push(item.entry);
        }
        continue;
      }

      sections.push(block);
      usedTokens += blockTokens;
      included.push(item.entry);
    }

    const formatted = sections.join("\n");
    return {
      formatted,
      entries: included,
      stats: { totalMatched: included.length, totalTokensEstimate: usedTokens },
    };
  }
}
