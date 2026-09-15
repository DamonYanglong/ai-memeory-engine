/**
 * Setup CLI 类型定义
 * @author longfei5
 * @date 2026/3/12
 *
 * 定义配置向导的输入、计划、动作和结果类型。
 * tool 字段使用联合类型，便于二期扩展 Crush 等工具。
 */

/** 用户配置选择 */
export interface SetupConfig {
  /** 目标工具 */
  tool: "claude-code";
  /** 记忆存储目录（绝对路径） */
  memoryDir: string;
  /** 引擎包根目录（自动检测） */
  engineDir: string;
}

/** 配置动作类型 */
export type ActionType = "backup" | "merge_mcp" | "merge_hooks" | "copy_skill" | "inject_claude_md";

/** 单个配置动作 */
export interface SetupAction {
  type: ActionType;
  /** 目标文件路径 */
  target: string;
  /** 人类可读描述 */
  description: string;
}

/** 配置计划（dry run 结果） */
export interface SetupPlan {
  /** 将要执行的操作列表 */
  actions: SetupAction[];
  /** 跳过项的警告信息 */
  warnings: string[];
  /** 合并后的 ~/.claude.json（MCP Server 注册） */
  mergedClaudeJson: Record<string, unknown>;
  /** ~/.claude.json 路径 */
  claudeJsonPath: string;
  /** 合并后的 settings.json（Hooks 等设置） */
  mergedSettings: Record<string, unknown>;
  /** settings.json 路径 */
  settingsPath: string;
  /** Skill 源文件路径 */
  skillSource: string;
  /** Skill 目标路径 */
  skillTarget: string;
  /** CLAUDE.md 路径 */
  claudeMdPath: string;
  /** 需要追加到 CLAUDE.md 的记忆提示内容 */
  claudeMdSnippet: string;
}

/** 配置执行结果 */
export interface SetupResult {
  success: boolean;
  /** 备份文件路径 */
  backupPath?: string;
  /** 已执行操作描述 */
  actions: string[];
}
