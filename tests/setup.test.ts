/**
 * Setup 配置策略单元测试
 * @author longfei5
 * @date 2026/3/12
 *
 * 测试 claude-code.ts 的纯逻辑函数：配置生成、合并、plan/apply 端到端。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildMcpConfig,
  buildHooksConfig,
  buildClaudeMdSnippet,
  hasMemorySection,
  mergeMcpToClaudeJson,
  mergeHooksToSettings,
} from "../src/setup/claude-code.js";
import type { SetupConfig } from "../src/setup/types.js";

const makeConfig = (overrides?: Partial<SetupConfig>): SetupConfig => ({
  tool: "claude-code",
  memoryDir: "/home/user/memory",
  engineDir: "/home/user/ai-memory-engine",
  ...overrides,
});

describe("buildMcpConfig", () => {
  it("生成正确的 MCP 注册结构", () => {
    const config = makeConfig();
    const result = buildMcpConfig(config);

    expect(result).toEqual({
      command: "node",
      args: ["/home/user/ai-memory-engine/dist/adapters/claude-code/mcp-server.js"],
      env: { MEMORY_DIR: "/home/user/memory" },
    });
  });

  it("路径使用 config 中的绝对路径", () => {
    const config = makeConfig({
      engineDir: "/opt/engine",
      memoryDir: "/data/mem",
    });
    const result = buildMcpConfig(config);

    expect((result.args as string[])[0]).toBe(
      "/opt/engine/dist/adapters/claude-code/mcp-server.js",
    );
    expect((result.env as Record<string, string>).MEMORY_DIR).toBe("/data/mem");
  });
});

describe("buildHooksConfig", () => {
  it("生成包含 SessionStart/UserPromptSubmit/Stop 的 hooks 格式", () => {
    const config = makeConfig();
    const result = buildHooksConfig(config);

    expect(result).toHaveProperty("SessionStart");
    expect(result).toHaveProperty("UserPromptSubmit");
    expect(result).toHaveProperty("Stop");

    // SessionStart — 注入 MEMORY.md
    const sessionEntries = result.SessionStart as Array<Record<string, unknown>>;
    expect(sessionEntries).toHaveLength(1);
    const sessionHooks = sessionEntries[0].hooks as Array<Record<string, unknown>>;
    expect(sessionHooks[0].type).toBe("command");
    expect(sessionHooks[0].command).toContain("MEMORY.md");

    // UserPromptSubmit
    const upsEntries = result.UserPromptSubmit as Array<Record<string, unknown>>;
    expect(upsEntries).toHaveLength(1);
    const upsHooks = upsEntries[0].hooks as Array<Record<string, unknown>>;
    expect(upsHooks[0].type).toBe("command");
    expect(upsHooks[0].command).toContain("ai-memory-engine/dist/bin/scan.js");
    expect(upsHooks[0].command).toContain("USER_PROMPT");

    // Stop
    const stopEntries = result.Stop as Array<Record<string, unknown>>;
    expect(stopEntries).toHaveLength(1);
    const stopHooks = stopEntries[0].hooks as Array<Record<string, unknown>>;
    expect(stopHooks[0].type).toBe("command");
    expect(stopHooks[0].command).toContain("extract-prompt.js");
    expect(stopHooks[0].command).toContain("MEMORY_DIR");
    // 第二个 Stop 钩子：提取后推送同步
    expect(stopHooks[1].type).toBe("command");
    expect(stopHooks[1].command).toContain("mem-sync.js");
    expect(stopHooks[1].command).toContain("push");
  });
});

describe("buildClaudeMdSnippet / hasMemorySection", () => {
  it("生成包含记忆目录路径的提示段落", () => {
    const config = makeConfig();
    const snippet = buildClaudeMdSnippet(config);

    expect(snippet).toContain("/home/user/memory/MEMORY.md");
    expect(snippet).toContain("ai-memory-engine");
    expect(snippet).toContain("<!-- ai-memory-engine -->");
  });

  it("hasMemorySection 检测已注入的标记", () => {
    const config = makeConfig();
    const snippet = buildClaudeMdSnippet(config);

    expect(hasMemorySection(snippet)).toBe(true);
    expect(hasMemorySection("# 普通 CLAUDE.md 内容")).toBe(false);
  });
});

describe("mergeMcpToClaudeJson", () => {
  it("空配置时创建 mcpServers 结构", () => {
    const config = makeConfig();
    const { merged, warnings } = mergeMcpToClaudeJson({}, buildMcpConfig(config));

    expect(warnings).toHaveLength(0);
    expect(merged.mcpServers).toBeDefined();
    expect(
      (merged.mcpServers as Record<string, unknown>)["ai-memory-engine"],
    ).toBeDefined();
  });

  it("已有 ai-memory MCP 时 warn + skip", () => {
    const existing = {
      mcpServers: {
        "ai-memory-engine": { command: "old" },
        "other-server": { command: "other" },
      },
    };
    const config = makeConfig();
    const { merged, warnings } = mergeMcpToClaudeJson(existing, buildMcpConfig(config));

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("mcpServers");
    // 不覆盖
    const mcp = (merged.mcpServers as Record<string, Record<string, unknown>>)[
      "ai-memory-engine"
    ];
    expect(mcp.command).toBe("old");
    // 其他 server 保留
    expect(
      (merged.mcpServers as Record<string, unknown>)["other-server"],
    ).toBeDefined();
  });

  it("保留 .claude.json 中的其他字段", () => {
    const existing = {
      numStartups: 100,
      installMethod: "native",
    };
    const config = makeConfig();
    const { merged } = mergeMcpToClaudeJson(existing, buildMcpConfig(config));

    expect(merged.numStartups).toBe(100);
    expect(merged.installMethod).toBe("native");
  });
});

describe("mergeHooksToSettings", () => {
  it("空配置时创建 hooks 结构（含 SessionStart）", () => {
    const config = makeConfig();
    const { merged, warnings } = mergeHooksToSettings({}, buildHooksConfig(config));

    expect(warnings).toHaveLength(0);
    expect(merged.hooks).toBeDefined();
    const hooks = merged.hooks as Record<string, unknown[]>;
    expect(hooks.SessionStart).toHaveLength(1);
    expect(hooks.UserPromptSubmit).toHaveLength(1);
    expect(hooks.Stop).toHaveLength(1);
  });

  it("已有其他 hooks 时追加不覆盖", () => {
    const existing = {
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: "command", command: "echo hello" }] },
        ],
        SessionStart: [
          { hooks: [{ type: "command", command: "echo start" }] },
        ],
      },
    };
    const config = makeConfig();
    const { merged, warnings } = mergeHooksToSettings(existing, buildHooksConfig(config));

    expect(warnings).toHaveLength(0);
    const hooks = merged.hooks as Record<string, unknown[]>;
    // UserPromptSubmit 应有 2 条（原有 1 + 新增 1）
    expect(hooks.UserPromptSubmit).toHaveLength(2);
    // SessionStart 应有 2 条（原有 1 + 新增 1，原有不含 ai-memory）
    expect(hooks.SessionStart).toHaveLength(2);
    // Stop 新增 1 条
    expect(hooks.Stop).toHaveLength(1);
  });

  it("已有 ai-memory hooks 时 warn + skip", () => {
    const existing = {
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [
              {
                type: "command",
                command: 'node "/path/to/ai-memory-engine/dist/bin/scan.js"',
              },
            ],
          },
        ],
      },
    };
    const config = makeConfig();
    const { merged, warnings } = mergeHooksToSettings(existing, buildHooksConfig(config));

    // UserPromptSubmit 应被跳过
    expect(warnings.some((w) => w.includes("UserPromptSubmit"))).toBe(true);
    // Stop 不受影响，应正常添加
    const hooks = merged.hooks as Record<string, unknown[]>;
    expect(hooks.UserPromptSubmit).toHaveLength(1); // 没追加
    expect(hooks.Stop).toHaveLength(1); // 正常添加
  });

  it("保留 settings.json 中的其他字段", () => {
    const existing = {
      env: { API_KEY: "xxx" },
      enableAllProjectMcpServers: true,
    };
    const config = makeConfig();
    const { merged } = mergeHooksToSettings(existing, buildHooksConfig(config));

    expect((merged.env as Record<string, string>).API_KEY).toBe("xxx");
    expect(merged.enableAllProjectMcpServers).toBe(true);
  });
});

describe("plan / apply 端到端", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "ai-memory-setup-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("MCP 合并后 JSON 可正确序列化", () => {
    const config = makeConfig();
    const { merged } = mergeMcpToClaudeJson(
      { existingKey: "value" },
      buildMcpConfig(config),
    );

    const json = JSON.stringify(merged, null, 2);
    const parsed = JSON.parse(json);

    expect(parsed.existingKey).toBe("value");
    expect(parsed.mcpServers["ai-memory-engine"]).toBeDefined();
  });

  it("Hooks 合并后包含 SessionStart", () => {
    const config = makeConfig();
    const { merged } = mergeHooksToSettings(
      { existingKey: "value" },
      buildHooksConfig(config),
    );

    const json = JSON.stringify(merged, null, 2);
    const parsed = JSON.parse(json);

    expect(parsed.existingKey).toBe("value");
    expect(parsed.hooks.SessionStart).toHaveLength(1);
    expect(parsed.hooks.UserPromptSubmit).toHaveLength(1);
    expect(parsed.hooks.Stop).toHaveLength(1);
  });

  it("模拟完整写入流程：MCP → .claude.json，Hooks → settings.json，CLAUDE.md 追加", async () => {
    const claudeJsonPath = join(tmpDir, ".claude.json");
    const settingsDir = join(tmpDir, ".claude");
    const settingsPath = join(settingsDir, "settings.json");
    const claudeMdPath = join(settingsDir, "CLAUDE.md");
    const commandsDir = join(settingsDir, "commands");

    // 模拟已有 .claude.json
    await writeFile(
      claudeJsonPath,
      JSON.stringify({ numStartups: 10, mcpServers: { other: { command: "x" } } }),
      "utf-8",
    );

    // 模拟已有 settings.json
    await mkdir(settingsDir, { recursive: true });
    await writeFile(
      settingsPath,
      JSON.stringify({ env: { KEY: "val" } }),
      "utf-8",
    );

    // 模拟已有 CLAUDE.md
    await writeFile(claudeMdPath, "# 全局规则\n\n原有内容", "utf-8");

    // 读取 → 合并 → 写入
    const existingClaudeJson = JSON.parse(await readFile(claudeJsonPath, "utf-8"));
    const existingSettings = JSON.parse(await readFile(settingsPath, "utf-8"));
    const config = makeConfig();

    const { merged: mergedClaudeJson } = mergeMcpToClaudeJson(
      existingClaudeJson,
      buildMcpConfig(config),
    );
    const { merged: mergedSettings } = mergeHooksToSettings(
      existingSettings,
      buildHooksConfig(config),
    );

    await writeFile(claudeJsonPath, JSON.stringify(mergedClaudeJson, null, 2), "utf-8");
    await writeFile(settingsPath, JSON.stringify(mergedSettings, null, 2), "utf-8");

    // 追加 CLAUDE.md
    const snippet = buildClaudeMdSnippet(config);
    const existingMd = await readFile(claudeMdPath, "utf-8");
    await writeFile(claudeMdPath, existingMd.trimEnd() + "\n" + snippet, "utf-8");

    // 验证 .claude.json
    const resultClaudeJson = JSON.parse(await readFile(claudeJsonPath, "utf-8"));
    expect(resultClaudeJson.numStartups).toBe(10);
    expect(resultClaudeJson.mcpServers["ai-memory-engine"].command).toBe("node");
    expect(resultClaudeJson.mcpServers.other.command).toBe("x");
    expect(resultClaudeJson.hooks).toBeUndefined();

    // 验证 settings.json
    const resultSettings = JSON.parse(await readFile(settingsPath, "utf-8"));
    expect(resultSettings.env.KEY).toBe("val");
    expect(resultSettings.hooks.SessionStart).toHaveLength(1);
    expect(resultSettings.hooks.UserPromptSubmit).toHaveLength(1);
    expect(resultSettings.hooks.Stop).toHaveLength(1);
    expect(resultSettings.mcpServers).toBeUndefined();

    // 验证 CLAUDE.md
    const resultMd = await readFile(claudeMdPath, "utf-8");
    expect(resultMd).toContain("# 全局规则");
    expect(resultMd).toContain("原有内容");
    expect(hasMemorySection(resultMd)).toBe(true);
    expect(resultMd).toContain("/home/user/memory/MEMORY.md");

    // 模拟 Skill 复制
    await mkdir(commandsDir, { recursive: true });
    const skillContent = "# /mem-reflect";
    await writeFile(join(commandsDir, "mem-reflect.md"), skillContent);
    expect(existsSync(join(commandsDir, "mem-reflect.md"))).toBe(true);
  });

  it("CLAUDE.md 已有记忆标记时不重复注入", () => {
    const config = makeConfig();
    const snippet = buildClaudeMdSnippet(config);
    const existingWithMemory = "# 规则\n" + snippet;

    expect(hasMemorySection(existingWithMemory)).toBe(true);
  });
});
