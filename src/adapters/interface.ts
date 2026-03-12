/**
 * 工具适配器接口定义
 * @author longfei5
 * @date 2026/3/11
 *
 * 每个 AI 工具（Claude Code、Codex、OpenCode）实现此接口，
 * 屏蔽各工具的差异（Hooks vs CLI 插件、MCP vs Function Calling 等）。
 */

import type {
  SessionContext,
  ConversationHistory,
  Message,
} from "../core/types/memory.js";

/** MCP 工具定义（注册到宿主工具） */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** 用户命令定义（如 Skill、CLI 子命令） */
export interface CommandDefinition {
  name: string;
  description: string;
  /** 命令内容（Claude Code Skill 是 .md 文件内容） */
  content?: string;
}

/**
 * 工具适配器接口
 *
 * 各 AI 工具的适配器需实现此接口，覆盖五个能力维度：
 * 1. 生命周期 — 会话开始/结束的钩子
 * 2. 对话格式 — 各工具消息格式与内部格式的双向转换
 * 3. 上下文注入 — 将记忆内容注入工具的上下文
 * 4. 用户交互 — 冲突裁决确认、通知提示
 * 5. 注册能力 — 工具和命令的注册
 */
export interface ToolAdapter {
  /** 适配器标识 */
  readonly name: string;

  /** 生命周期钩子 */
  lifecycle: {
    /** 会话开始时触发（加载记忆、注入上下文） */
    onSessionStart(callback: (context: SessionContext) => void): void;
    /** 会话结束时触发（提取记忆、清理资源） */
    onSessionEnd(callback: (history: ConversationHistory) => void): void;
  };

  /** 对话格式转换 */
  conversation: {
    /** 工具原生格式 → 内部统一格式 */
    toInternal(raw: unknown): Message[];
    /** 内部统一格式 → 工具原生格式 */
    fromInternal(messages: Message[]): unknown;
  };

  /** 上下文注入 */
  injection: {
    /** 将内容注入宿主工具的上下文（System Prompt 等） */
    inject(content: string): void;
  };

  /** 用户交互 */
  interaction: {
    /** 向用户展示选项并等待选择（冲突裁决等） */
    confirm(prompt: string, options: string[]): Promise<string>;
    /** 向用户发送通知（非阻塞） */
    notify(message: string): void;
  };

  /** 工具与命令注册 */
  register: {
    /** 注册 MCP 工具 / Function Calling */
    registerTools(tools: ToolDefinition[]): void;
    /** 注册用户命令（Skill / CLI 子命令） */
    registerCommands(commands: CommandDefinition[]): void;
  };
}
