/**
 * 提取器 Prompt 模板 — 引导宿主模型从候选队列精提取记忆
 * @author longfei5
 * @date 2026/3/12
 *
 * 职责：
 * 生成结构化 Prompt，让宿主模型完成三步提取：
 * 1. 审核候选队列（过滤正则误匹配）
 * 2. 补充遗漏（发现正则无法覆盖的隐含偏好）
 * 3. 生成 CandidateMemory 并调用 store_memory 写入
 */

import type { QueueItem } from "../types/memory.js";

/**
 * 生成提取 Prompt
 *
 * 在会话结束时注入给宿主模型，引导其审核候选队列并提取记忆。
 * 如果队列为空，仍需宿主模型扫描对话寻找遗漏。
 */
export function buildExtractPrompt(queueItems: QueueItem[]): string {
  const queueSection =
    queueItems.length > 0
      ? queueItems
          .map(
            (item, i) =>
              `  ${i + 1}. [${item.pattern}] "${item.matchedText}" (置信度: ${item.confidence}, 建议分类: ${item.suggestedType})`,
          )
          .join("\n")
      : "  （无候选项）";

  return `你是一个记忆提取器。请完成以下任务：

## 第一步：审核候选队列

正则预筛选捕获了以下候选：

${queueSection}

对每条候选进行语义验证：
- 确实是用户纠正/偏好/经验 → 保留
- 误匹配（比如代码中的字符串恰好命中正则） → 丢弃

## 第二步：补充遗漏

回顾本次对话，找出正则未捕获但值得存储的记忆：
- 隐含的偏好模式（用户反复使用某种写法但没有明说）
- 间接的经验提示（"这个容易出问题"但没用"上次"等关键词）

## 第三步：生成候选记忆

对每条有效记忆，调用 MCP 工具 store_memory()，参数：
- type: details（知识点）/ cases（案例）/ principles（原则）
- trigger: user_correction / preference / experience
- summary: 一句话摘要（包含足够判断信息）
- detail: 3-10 行内容（要点 + 来源场景）
- keywords: 检索关键词列表（3-6 个）
- confidence: 置信度（0-1）

## 分类规则

- 用户纠正了一个具体做法 → details
- 用户描述了一次经历/故障 → cases
- 用户声明了一条规范/约定 → principles
- 关键词辅助：有"上次/之前/遇到过" → cases，有"统一/规范/约定/必须" → principles

## 过滤规则（Delta 原则）

只提取：用户纠正、偏好声明、经验沉淀
不提取：模型通用知识、临时上下文、可从代码推断的信息

判断标准：**换一个新会话，不给这条信息，你会不会做错？**
- 会做错 → 存
- 不会 → 不存

## 完成后

- 调用 clear_candidate_queue() 清空候选队列
- 如果 store_memory 返回冲突，向用户展示对比并请求裁决
- 如果没有值得提取的记忆，告知用户"本次会话无新增记忆"`;
}
