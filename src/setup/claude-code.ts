/**
 * Claude Code 配置策略
 * @author longfei5
 * @date 2026/3/12
 *
 * 负责生成 MCP Server、Hooks 配置，并将其安全合并到对应的配置文件：
 * - MCP Server → ~/.claude.json（Claude Code 运行时加载）
 * - Hooks → ~/.claude/settings.json（设置文件）
 */

import { readFile, writeFile, copyFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import type { SetupConfig, SetupPlan, SetupAction, SetupResult } from "./types.js";

/** Claude Code 配置文件路径 */
const CLAUDE_JSON_PATH = join(homedir(), ".claude.json");

/** Claude Code 设置目录 */
const CLAUDE_DIR = join(homedir(), ".claude");
const SETTINGS_PATH = join(CLAUDE_DIR, "settings.json");
const COMMANDS_DIR = join(CLAUDE_DIR, "commands");
const CLAUDE_MD_PATH = join(CLAUDE_DIR, "CLAUDE.md");

// ─── 配置生成 ──────────────────────────────────

/**
 * 生成 MCP Server 注册配置
 */
export function buildMcpConfig(config: SetupConfig): Record<string, unknown> {
  return {
    command: "node",
    args: [join(config.engineDir, "dist/adapters/claude-code/mcp-server.js")],
    env: {
      MEMORY_DIR: config.memoryDir,
    },
  };
}

/**
 * 生成 Hooks 配置（符合真实 settings.json 格式）
 *
 * 同步钩子（mem-sync）在 memory 目录不是 git 仓库时自动静默跳过，
 * 未开启多机同步的环境不受影响。
 */
export function buildHooksConfig(
  config: SetupConfig,
): Record<string, unknown[]> {
  const memoryIndex = join(config.memoryDir, "MEMORY.md");
  const memSync = join(config.engineDir, "dist/bin/mem-sync.js");
  return {
    SessionStart: [
      {
        hooks: [
          {
            type: "command",
            // 先同步远端记忆，再注入索引（; 连接保证同步失败不阻断注入）
            command: `MEMORY_DIR="${config.memoryDir}" node "${memSync}" sync --quiet; cat "${memoryIndex}" 2>/dev/null || echo "记忆库为空，暂无跨会话记忆。"`,
          },
        ],
      },
    ],
    UserPromptSubmit: [
      {
        hooks: [
          {
            type: "command",
            command: `USER_PROMPT="$USER_PROMPT" node "${join(config.engineDir, "dist/bin/scan.js")}"`,
          },
        ],
      },
    ],
    Stop: [
      {
        hooks: [
          {
            type: "command",
            command: `MEMORY_DIR="${config.memoryDir}" node "${join(config.engineDir, "dist/bin/extract-prompt.js")}"`,
          },
          {
            type: "command",
            // 提取写入后推送本机新增记忆到远端（无变更时零网络开销）
            command: `MEMORY_DIR="${config.memoryDir}" node "${memSync}" push --quiet`,
          },
        ],
      },
    ],
  };
}

// ─── 配置合并 ──────────────────────────────────

/** CLAUDE.md 记忆提示标记（用于检测是否已注入） */
const MEMORY_SECTION_MARKER = "<!-- ai-memory-engine -->";

/**
 * 生成追加到 CLAUDE.md 的记忆提示段落
 */
export function buildClaudeMdSnippet(config: SetupConfig): string {
  return `
${MEMORY_SECTION_MARKER}
## AI 记忆库

跨会话记忆索引：${join(config.memoryDir, "MEMORY.md")}
记忆详情目录：${config.memoryDir}

遇到用户偏好、工具配置、历史经验相关问题时，先读取 MEMORY.md 索引查找相关记忆，按需读取详情文件。
记忆通过 ai-memory-engine MCP Server 管理，使用 store_memory / get_memory_stats 等工具操作。
`;
}

/**
 * 检查 CLAUDE.md 内容是否已包含记忆提示
 */
export function hasMemorySection(content: string): boolean {
  return content.includes(MEMORY_SECTION_MARKER);
}

/**
 * 将 MCP Server 配置合并到 ~/.claude.json
 */
export function mergeMcpToClaudeJson(
  existing: Record<string, unknown>,
  mcpEntry: Record<string, unknown>,
): { merged: Record<string, unknown>; warnings: string[] } {
  const merged = { ...existing };
  const warnings: string[] = [];

  const mcpServers = (merged.mcpServers ?? {}) as Record<string, unknown>;
  if (mcpServers["ai-memory-engine"]) {
    warnings.push(
      "mcpServers 中已存在 ai-memory-engine，跳过（如需更新请先手动删除）",
    );
  } else {
    mcpServers["ai-memory-engine"] = mcpEntry;
  }
  merged.mcpServers = mcpServers;

  return { merged, warnings };
}

/**
 * 将 Hooks 配置合并到 ~/.claude/settings.json
 */
export function mergeHooksToSettings(
  existing: Record<string, unknown>,
  hooksEntries: Record<string, unknown[]>,
): { merged: Record<string, unknown>; warnings: string[] } {
  const merged = { ...existing };
  const warnings: string[] = [];

  const hooks = (merged.hooks ?? {}) as Record<string, unknown[]>;
  for (const [eventType, newEntries] of Object.entries(hooksEntries)) {
    const existingEntries = (hooks[eventType] ?? []) as unknown[];
    if (hasAiMemoryHook(existingEntries)) {
      warnings.push(
        `hooks.${eventType} 中已存在 ai-memory 钩子，跳过`,
      );
    } else {
      hooks[eventType] = [...existingEntries, ...newEntries];
    }
  }
  merged.hooks = hooks;

  return { merged, warnings };
}

/** 检查 hooks 事件数组中是否已包含 ai-memory 相关 command */
function hasAiMemoryHook(entries: unknown[]): boolean {
  return entries.some((entry) => {
    const e = entry as Record<string, unknown>;
    const hooks = e.hooks as Array<Record<string, unknown>> | undefined;
    return hooks?.some((h) => {
      const cmd = h.command as string | undefined;
      return cmd?.includes("ai-memory");
    });
  });
}

// ─── 文件读写 ──────────────────────────────────

/** 读取 ~/.claude.json（不存在则返回空对象） */
async function readClaudeJson(): Promise<Record<string, unknown>> {
  if (!existsSync(CLAUDE_JSON_PATH)) {
    return {};
  }
  const content = await readFile(CLAUDE_JSON_PATH, "utf-8");
  return JSON.parse(content) as Record<string, unknown>;
}

/** 读取 ~/.claude/settings.json（不存在则返回空对象） */
async function readSettings(): Promise<Record<string, unknown>> {
  if (!existsSync(SETTINGS_PATH)) {
    return {};
  }
  const content = await readFile(SETTINGS_PATH, "utf-8");
  return JSON.parse(content) as Record<string, unknown>;
}

/** 备份文件，返回备份路径 */
async function backupFile(filePath: string): Promise<string | null> {
  if (!existsSync(filePath)) {
    return null;
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, "").slice(0, 15);
  const backupPath = `${filePath}.backup.${timestamp}`;
  await copyFile(filePath, backupPath);
  return backupPath;
}

// ─── Plan / Apply ──────────────────────────────

/**
 * 计算配置变更计划（不修改文件）
 */
export async function plan(config: SetupConfig): Promise<SetupPlan> {
  const existingClaudeJson = await readClaudeJson();
  const existingSettings = await readSettings();
  const mcpEntry = buildMcpConfig(config);
  const hooksEntries = buildHooksConfig(config);

  const { merged: mergedClaudeJson, warnings: mcpWarnings } =
    mergeMcpToClaudeJson(existingClaudeJson, mcpEntry);
  const { merged: mergedSettings, warnings: hooksWarnings } =
    mergeHooksToSettings(existingSettings, hooksEntries);

  const warnings = [...mcpWarnings, ...hooksWarnings];
  const actions: SetupAction[] = [];
  const skillSource = join(config.engineDir, "config/mem-reflect.md");
  const skillTarget = join(COMMANDS_DIR, "mem-reflect.md");

  // 备份 .claude.json
  if (existsSync(CLAUDE_JSON_PATH)) {
    actions.push({
      type: "backup",
      target: CLAUDE_JSON_PATH,
      description: `备份 ${CLAUDE_JSON_PATH}`,
    });
  }

  // 备份 settings.json
  if (existsSync(SETTINGS_PATH)) {
    actions.push({
      type: "backup",
      target: SETTINGS_PATH,
      description: `备份 ${SETTINGS_PATH}`,
    });
  }

  // MCP
  if (!mcpWarnings.some((w) => w.includes("mcpServers"))) {
    actions.push({
      type: "merge_mcp",
      target: CLAUDE_JSON_PATH,
      description: "注册 ai-memory-engine 到 ~/.claude.json mcpServers",
    });
  }

  // Hooks
  for (const eventType of Object.keys(hooksEntries)) {
    if (!hooksWarnings.some((w) => w.includes(eventType))) {
      actions.push({
        type: "merge_hooks",
        target: SETTINGS_PATH,
        description: `添加 ${eventType} 钩子到 settings.json`,
      });
    }
  }

  // Skill
  if (existsSync(skillTarget)) {
    warnings.push("Skill /mem-reflect 已存在，将覆盖更新");
  }
  actions.push({
    type: "copy_skill",
    target: skillTarget,
    description: "复制 /mem-reflect Skill 到 commands 目录",
  });

  // CLAUDE.md 记忆提示
  const claudeMdSnippet = buildClaudeMdSnippet(config);
  if (existsSync(CLAUDE_MD_PATH)) {
    const existingContent = await readFile(CLAUDE_MD_PATH, "utf-8");
    if (hasMemorySection(existingContent)) {
      warnings.push("CLAUDE.md 中已存在 AI 记忆库提示，跳过");
    } else {
      actions.push({
        type: "inject_claude_md",
        target: CLAUDE_MD_PATH,
        description: "在 CLAUDE.md 末尾追加记忆库提示",
      });
    }
  } else {
    actions.push({
      type: "inject_claude_md",
      target: CLAUDE_MD_PATH,
      description: "创建 CLAUDE.md 并写入记忆库提示",
    });
  }

  return {
    actions,
    warnings,
    mergedClaudeJson,
    claudeJsonPath: CLAUDE_JSON_PATH,
    mergedSettings,
    settingsPath: SETTINGS_PATH,
    skillSource,
    skillTarget,
    claudeMdPath: CLAUDE_MD_PATH,
    claudeMdSnippet,
  };
}

/**
 * 执行配置变更
 */
export async function apply(setupPlan: SetupPlan): Promise<SetupResult> {
  const executedActions: string[] = [];
  const backupPaths: string[] = [];

  // 备份 .claude.json
  const claudeJsonBackup = await backupFile(setupPlan.claudeJsonPath);
  if (claudeJsonBackup) {
    backupPaths.push(claudeJsonBackup);
    executedActions.push(`备份: ${claudeJsonBackup}`);
  }

  // 备份 settings.json
  const settingsBackup = await backupFile(setupPlan.settingsPath);
  if (settingsBackup) {
    backupPaths.push(settingsBackup);
    executedActions.push(`备份: ${settingsBackup}`);
  }

  // 写入 .claude.json（MCP Server）
  await writeFile(
    setupPlan.claudeJsonPath,
    JSON.stringify(setupPlan.mergedClaudeJson, null, 2) + "\n",
    "utf-8",
  );
  executedActions.push("写入 ~/.claude.json (MCP Server)");

  // 写入 settings.json（Hooks）
  await mkdir(dirname(setupPlan.settingsPath), { recursive: true });
  await writeFile(
    setupPlan.settingsPath,
    JSON.stringify(setupPlan.mergedSettings, null, 2) + "\n",
    "utf-8",
  );
  executedActions.push("写入 settings.json (Hooks)");

  // 复制 Skill
  await mkdir(dirname(setupPlan.skillTarget), { recursive: true });
  await copyFile(setupPlan.skillSource, setupPlan.skillTarget);
  executedActions.push(`复制 Skill: ${setupPlan.skillTarget}`);

  // 追加 CLAUDE.md 记忆提示
  if (setupPlan.actions.some((a) => a.type === "inject_claude_md")) {
    await mkdir(dirname(setupPlan.claudeMdPath), { recursive: true });
    if (existsSync(setupPlan.claudeMdPath)) {
      const existing = await readFile(setupPlan.claudeMdPath, "utf-8");
      await writeFile(
        setupPlan.claudeMdPath,
        existing.trimEnd() + "\n" + setupPlan.claudeMdSnippet,
        "utf-8",
      );
      executedActions.push("追加记忆库提示到 CLAUDE.md");
    } else {
      await writeFile(
        setupPlan.claudeMdPath,
        setupPlan.claudeMdSnippet.trimStart(),
        "utf-8",
      );
      executedActions.push("创建 CLAUDE.md 并写入记忆库提示");
    }
  }

  return {
    success: true,
    backupPath: backupPaths[0],
    actions: executedActions,
  };
}
