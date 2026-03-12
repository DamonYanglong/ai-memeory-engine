/**
 * 冲突判断 Prompt 模板 — 引导宿主模型判断新旧记忆关系
 * @author longfei5
 * @date 2026/3/12
 *
 * 职责：
 * 生成结构化 Prompt，让宿主模型判断两条记忆的关系类型。
 * MCP Server 自身不调用 LLM，Prompt 随冲突结果返回给宿主模型。
 */

import type { ConflictSide } from "../types/memory.js";

/**
 * 生成冲突判断 Prompt
 *
 * 宿主模型收到此 Prompt 后，应输出 relation 和 reason，
 * 然后调用 resolve_conflict 工具传入判断结果。
 */
export function buildJudgmentPrompt(existing: ConflictSide, incoming: ConflictSide): string {
  return `你是一个记忆冲突检测器。比较以下两条记忆，判断它们的关系。

【已有记忆】
摘要：${existing.summary}
关键词：${existing.keywords.join("、")}
文件：${existing.filePath}

【新记忆】
摘要：${incoming.summary}
关键词：${incoming.keywords.join("、")}

请判断关系类型：
- contradicts：同一主题，结论相反或不兼容
- supplements：同一主题，新记忆提供了补充信息
- duplicates：内容实质相同，无需重复存储
- unrelated：不同主题，没有实质关联

请直接调用 resolve_conflict 工具，传入：
- conflictId: 当前冲突 ID
- relation: contradicts / supplements / duplicates / unrelated
- choice: 仅当 relation 为 contradicts 时需要，询问用户选择 replace / keep / coexist`;
}
