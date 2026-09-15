/**
 * 更新 ~/.claude/settings.json 中的 ai-memory 钩子（幂等）
 *
 * - SessionStart：已有 ai-memory 注入钩子则前置 mem-sync sync，否则新增
 * - Stop：在 extract-prompt 所在条目追加 mem-sync push，否则新增
 * - 其他工具的钩子一律不动；写入前自动备份
 */
import { readFile, writeFile, copyFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

const engineDir = process.env.ENGINE_DIR ?? join(homedir(), "ai-memory", "ai-memory-engine");
const memoryDir = process.env.MEMORY_DIR ?? join(homedir(), "ai-memory", "memory");
const memSync = join(engineDir, "dist", "bin", "mem-sync.js");
const settingsPath = join(homedir(), ".claude", "settings.json");

const settings = JSON.parse(await readFile(settingsPath, "utf-8"));
settings.hooks ??= {};

const syncCmd = `MEMORY_DIR="${memoryDir}" node "${memSync}" sync --quiet`;
const pushCmd = `MEMORY_DIR="${memoryDir}" node "${memSync}" push --quiet`;

// ─── SessionStart ───
if (!Array.isArray(settings.hooks.SessionStart)) settings.hooks.SessionStart = [];
let sessionPatched = false;
for (const entry of settings.hooks.SessionStart) {
  for (const h of entry.hooks ?? []) {
    if (h.type === "command" && h.command?.includes("ai-memory") && h.command.includes("MEMORY.md")) {
      if (!h.command.includes("mem-sync")) {
        h.command = `${syncCmd}; ${h.command}`;
      }
      sessionPatched = true;
    }
  }
}
if (!sessionPatched) {
  settings.hooks.SessionStart.push({
    hooks: [
      {
        type: "command",
        command: `${syncCmd}; cat "${join(memoryDir, "MEMORY.md")}" 2>/dev/null || echo "记忆库为空，暂无跨会话记忆。"`,
      },
    ],
  });
}

// ─── Stop ───
if (!Array.isArray(settings.hooks.Stop)) settings.hooks.Stop = [];
let stopEntry = settings.hooks.Stop.find(
  (e) => (e.hooks ?? []).some((h) => h.command?.includes("extract-prompt.js")),
);
if (!stopEntry) {
  stopEntry = { hooks: [] };
  settings.hooks.Stop.push(stopEntry);
}
stopEntry.hooks ??= [];
if (!stopEntry.hooks.some((h) => h.command?.includes("mem-sync.js"))) {
  stopEntry.hooks.push({ type: "command", command: pushCmd });
}

// ─── 备份并写入 ───
const stamp = new Date().toISOString().replace(/[:.]/g, "").slice(0, 15);
const backupPath = `${settingsPath}.backup-ai-memory-${stamp}`;
await copyFile(settingsPath, backupPath);
await mkdir(dirname(settingsPath), { recursive: true });
await writeFile(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");

console.log(`    钩子已更新（备份: ${backupPath}）`);
