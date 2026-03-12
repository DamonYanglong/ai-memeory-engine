/**
 * 正则预筛选模式库 + 扫描器
 * @author longfei5
 * @date 2026/3/12
 *
 * 职责：
 * 1. 维护四类正则模式（纠正/偏好/经验/确认）
 * 2. 对用户消息进行实时扫描，输出匹配结果
 *
 * 设计思路：
 * - 零 LLM 开销，纯正则匹配
 * - 宁可多捕获（第 2 层宿主模型会过滤误匹配）
 * - 置信度梯度：纠正 0.85 > 偏好 0.80 > 经验 0.70 > 确认 0.50
 */

import type { MemoryType } from "../types/memory.js";

// ─── 类型定义 ──────────────────────────────────

/** 正则模式的触发类型 */
export type PatternType = "correction" | "preference" | "experience" | "confirmation";

/** 单条正则模式定义 */
export interface PatternRule {
  /** 正则表达式 */
  regex: RegExp;
  /** 模式类型 */
  type: PatternType;
  /** 默认置信度 */
  confidence: number;
  /** 建议的记忆分类 */
  suggestedType: MemoryType;
}

/** 扫描结果 */
export interface ScanMatch {
  /** 匹配的模式类型 */
  patternType: PatternType;
  /** 匹配的正则表达式描述 */
  patternName: string;
  /** 匹配的文本片段 */
  matchedText: string;
  /** 置信度 */
  confidence: number;
  /** 建议的记忆分类 */
  suggestedType: MemoryType;
}

// ─── 正则模式库 ────────────────────────────────

/** 显式纠正模式（高置信度 0.85） */
const CORRECTION_PATTERNS: PatternRule[] = [
  { regex: /不要(用|写|加|搞).{1,30}/g, type: "correction", confidence: 0.85, suggestedType: "details" },
  { regex: /别(用|写|加).{1,30}/g, type: "correction", confidence: 0.85, suggestedType: "details" },
  { regex: /不[,，. ]+用.{1,30}/g, type: "correction", confidence: 0.85, suggestedType: "details" },
  { regex: /(应该|改成|换成|改用).{1,40}/g, type: "correction", confidence: 0.85, suggestedType: "details" },
  { regex: /(那样|这样)不对/g, type: "correction", confidence: 0.85, suggestedType: "details" },
  { regex: /(错了|不对|不是这样)/g, type: "correction", confidence: 0.85, suggestedType: "details" },
];

/** 偏好声明模式（高置信度 0.80） */
const PREFERENCE_PATTERNS: PatternRule[] = [
  { regex: /(我们|项目|团队)(统一|规范|约定|都)(用|写|采用).{1,40}/g, type: "preference", confidence: 0.80, suggestedType: "principles" },
  { regex: /(必须|一定要|务必).{1,40}/g, type: "preference", confidence: 0.80, suggestedType: "principles" },
  { regex: /(记住|记得)[：:].{1,40}/g, type: "preference", confidence: 0.80, suggestedType: "details" },
];

/** 经验分享模式（中置信度 0.70） */
const EXPERIENCE_PATTERNS: PatternRule[] = [
  { regex: /(上次|之前|以前)(遇到|碰到|踩过).{1,50}/g, type: "experience", confidence: 0.70, suggestedType: "cases" },
  { regex: /(踩过坑|吃过亏).{0,50}/g, type: "experience", confidence: 0.70, suggestedType: "cases" },
  { regex: /(线上|生产)(出过|出现过|遇到过).{1,50}/g, type: "experience", confidence: 0.70, suggestedType: "cases" },
];

/** 确认模式（低置信度 0.50，需结合上文由第 2 层判断） */
const CONFIRMATION_PATTERNS: PatternRule[] = [
  { regex: /^(对|没错|就这样|完美|正确)[。！!,，]?$/g, type: "confirmation", confidence: 0.50, suggestedType: "details" },
  { regex: /^(很好|不错|可以)[。！!,，]?$/g, type: "confirmation", confidence: 0.50, suggestedType: "details" },
];

/** 全部模式 */
const ALL_PATTERNS: PatternRule[] = [
  ...CORRECTION_PATTERNS,
  ...PREFERENCE_PATTERNS,
  ...EXPERIENCE_PATTERNS,
  ...CONFIRMATION_PATTERNS,
];

// ─── 扫描器 ────────────────────────────────────

/**
 * 扫描用户消息，检测记忆信号
 *
 * 对每条用户消息执行全量正则匹配，返回所有命中的模式。
 * 同一消息可能命中多个模式（如同时包含纠正和偏好信号）。
 */
export function scanMessage(message: string): ScanMatch[] {
  const matches: ScanMatch[] = [];

  // 跳过明显的代码块内容（三反引号包裹）
  const cleaned = message.replace(/```[\s\S]*?```/g, "");

  for (const pattern of ALL_PATTERNS) {
    // 重置 lastIndex（全局正则需要每次重置）
    pattern.regex.lastIndex = 0;

    let match: RegExpExecArray | null;
    while ((match = pattern.regex.exec(cleaned)) !== null) {
      matches.push({
        patternType: pattern.type,
        patternName: pattern.regex.source,
        matchedText: match[0].trim(),
        confidence: pattern.confidence,
        suggestedType: pattern.suggestedType,
      });
    }
  }

  // 去重：同一消息同一模式类型只保留置信度最高的
  return deduplicateMatches(matches);
}

/** 按模式类型去重，保留最高置信度 */
function deduplicateMatches(matches: ScanMatch[]): ScanMatch[] {
  const best = new Map<PatternType, ScanMatch>();

  for (const m of matches) {
    const existing = best.get(m.patternType);
    if (!existing || m.confidence > existing.confidence) {
      best.set(m.patternType, m);
    }
  }

  return [...best.values()];
}

/** 获取全部模式列表（供测试和调试使用） */
export function getAllPatterns(): PatternRule[] {
  return ALL_PATTERNS;
}
