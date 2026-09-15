#!/usr/bin/env node

/**
 * AI Memory Engine — 交互式配置向导
 * @author longfei5
 * @date 2026/3/12
 *
 * 通过交互式问答将 MCP Server、Hooks、Skill 配置注入宿主工具。
 * 当前支持 Claude Code，后续可扩展 Crush 等工具。
 */

import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createRL, ask, select, confirm } from "../setup/ui.js";
import { plan, apply } from "../setup/claude-code.js";
import type { SetupConfig } from "../setup/types.js";

/** 自动检测引擎包根目录 */
const engineDir = resolve(fileURLToPath(import.meta.url), "../../..");

/** ~ 展开为绝对路径 */
function expandTilde(p: string): string {
  return p.startsWith("~") ? p.replace("~", homedir()) : p;
}

async function main() {
  const rl = createRL();

  try {
    // 欢迎
    console.log();
    console.log("╭──────────────────────────────────────────╮");
    console.log("│  AI Memory Engine — 安装配置向导           │");
    console.log("╰──────────────────────────────────────────╯");

    // 选择工具
    const tool = await select(rl, "选择要集成的 AI 工具：", [
      { label: "Claude Code", value: "claude-code" },
    ]);

    // 记忆目录
    const defaultMemDir = "~/ai-memory/memory";
    const rawMemDir = await ask(rl, "记忆存储目录", defaultMemDir);
    const memoryDir = resolve(expandTilde(rawMemDir));

    if (!existsSync(memoryDir)) {
      console.log(`\n  目录不存在: ${memoryDir}`);
      const shouldCreate = await confirm(rl, "  是否创建？");
      if (shouldCreate) {
        const { mkdir } = await import("node:fs/promises");
        await mkdir(memoryDir, { recursive: true });
        console.log("  已创建");
      }
    }

    // 构建配置
    const config: SetupConfig = {
      tool: tool as "claude-code",
      memoryDir,
      engineDir,
    };

    // 生成计划
    const setupPlan = await plan(config);

    // 展示计划
    console.log("\n即将执行以下操作：\n");
    for (let i = 0; i < setupPlan.actions.length; i++) {
      const a = setupPlan.actions[i];
      const tag = {
        backup: "备份",
        merge_mcp: "MCP ",
        merge_hooks: "Hook",
        copy_skill: "Skill",
        inject_claude_md: "提示",
      }[a.type];
      console.log(`  ${i + 1}. [${tag}] ${a.description}`);
    }

    if (setupPlan.warnings.length > 0) {
      console.log("\n  ⚠ 警告：");
      for (const w of setupPlan.warnings) {
        console.log(`    - ${w}`);
      }
    }

    console.log();
    const proceed = await confirm(rl, "确认执行？");
    if (!proceed) {
      console.log("\n已取消。\n");
      rl.close();
      return;
    }

    // 执行
    const result = await apply(setupPlan);

    // 成功提示
    console.log("\n✅ 配置完成！\n");
    console.log("已配置：");
    for (const action of result.actions) {
      console.log(`  • ${action}`);
    }

    if (result.backupPath) {
      console.log(`\n备份位置：${result.backupPath}`);
    }

    console.log("\n下一步：");
    console.log("  1. 重启 Claude Code");
    console.log("  2. 尝试发送 /mem-reflect 验证 Skill 已加载");
    console.log('  3. 正常对话中说"以后不要用 var"测试记忆捕获');
    console.log();

    rl.close();
  } catch (error) {
    rl.close();
    console.error("\n配置失败:", (error as Error).message);
    process.exit(1);
  }
}

main();
