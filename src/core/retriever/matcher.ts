/**
 * 关键词匹配器 — 查询与记忆的相关性评分
 * @author longfei5
 * @date 2026/3/12
 *
 * 评分规则：精确匹配 1.0 + 同义词 0.7，阈值 >= 1.0 展开详情。
 */

import type { MemoryEntry } from "../types/memory.js";

/** 匹配结果 */
export interface MatchResult {
  entry: MemoryEntry;
  score: number;
  matchedKeywords: string[];
}

/** 同义词映射表（Phase 1 硬编码，Phase 2 可扩展） */
const SYNONYM_MAP: Record<string, string[]> = {
  "分页": ["翻页", "pagehelper", "limit offset", "pagination"],
  "连接池": ["hikaricp", "数据源", "datasource", "connection pool"],
  "orm": ["mybatis", "hibernate", "jpa"],
  "消息队列": ["kafka", "rabbitmq", "mq", "消费者", "生产者"],
  "缓存": ["redis", "cache", "ehcache"],
  "异常": ["exception", "error", "错误处理"],
};

/** 构建反向索引：词 → 同义词组 */
const REVERSE_SYNONYM: Map<string, Set<string>> = new Map();
for (const [key, synonyms] of Object.entries(SYNONYM_MAP)) {
  const group = new Set([key, ...synonyms]);
  for (const word of group) {
    REVERSE_SYNONYM.set(word.toLowerCase(), group);
  }
}

export class Matcher {
  private static readonly EXACT_WEIGHT = 1.0;
  private static readonly SYNONYM_WEIGHT = 0.7;
  private static readonly THRESHOLD = 1.0;

  /**
   * 对查询进行分词（简单实现：按空格和标点拆分）
   */
  tokenize(query: string): string[] {
    return query
      .toLowerCase()
      .split(/[\s,，。！？、;；:：]+/)
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
  }

  /**
   * 计算查询与记忆条目的匹配分
   */
  score(queryTokens: string[], entry: MemoryEntry): MatchResult {
    let totalScore = 0;
    const matched: string[] = [];

    const entryKeywords = new Set(entry.keywords.map((k) => k.toLowerCase()));
    const summaryLower = entry.summary.toLowerCase();

    for (const token of queryTokens) {
      // 精确匹配：关键词列表或摘要包含查询词
      if (entryKeywords.has(token) || summaryLower.includes(token)) {
        totalScore += Matcher.EXACT_WEIGHT;
        matched.push(token);
        continue;
      }

      // 反向包含：查询词包含某个关键词，或某个关键词包含查询词
      const partialHit = entry.keywords.some((kw) => {
        const kwLower = kw.toLowerCase();
        return token.includes(kwLower) || kwLower.includes(token);
      });
      if (partialHit) {
        totalScore += Matcher.EXACT_WEIGHT;
        matched.push(token);
        continue;
      }

      // 同义词匹配
      const synonymGroup = REVERSE_SYNONYM.get(token);
      if (synonymGroup) {
        const hit = [...synonymGroup].some(
          (syn) => entryKeywords.has(syn) || summaryLower.includes(syn),
        );
        if (hit) {
          totalScore += Matcher.SYNONYM_WEIGHT;
          matched.push(token + "(synonym)");
        }
      }
    }

    return { entry, score: totalScore, matchedKeywords: matched };
  }

  /**
   * 从所有条目中检索匹配项，按分数降序排列
   */
  match(query: string, entries: MemoryEntry[]): MatchResult[] {
    const tokens = this.tokenize(query);
    if (tokens.length === 0) return [];

    return entries
      .map((entry) => this.score(tokens, entry))
      .filter((r) => r.score >= Matcher.THRESHOLD)
      .sort((a, b) => b.score - a.score);
  }
}
