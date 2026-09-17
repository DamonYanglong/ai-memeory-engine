# Codex 接入指南 — 让 ai-memory-engine 服务 OpenAI Codex

> 状态：已实施（2026-09-17 本机落地，命令级验证全过），待 Codex 端首次会话按 §5 验证
> 结论先行：引擎的「智能外置 + MCP + 单文件存储」设计本就是宿主无关的，`types/memory.ts` 的 `tool` 枚举也已预留 `"codex"`。接入只需三步，**全链路只有一处需要适配**（`scan.js` 的输入通道，见 §4）。

## 1. 背景

- Codex CLI ≥ 0.154（2026-02 起）只支持 Responses API（`wire_api = "chat"` 已移除），本机经 LiteLLM 桥（127.0.0.1:4000）接入内网网关的 GLM/DeepSeek 等模型，GPT 系模型走网关直连。此为模型链路，与记忆链路无关，不影响本方案。
- Codex 的扩展位与 Claude Code 一一对应：`~/.codex/config.toml` 的 `[mcp_servers.*]`（MCP）、`~/.codex/hooks.json`（生命周期钩子，事件名同为 `SessionStart` / `UserPromptSubmit` / `Stop`）、`~/.codex/AGENTS.md`（全局指令）、`~/.codex/prompts/`（自定义命令，等价 Claude 的 commands）。
- 2026-09-15 的引擎重构（会话 `sess_4034e623`）完成了多宿主抽象：`src/adapters/`（含 `interface.ts`）、`ToolAdapter`、`tool: "claude-code" | "codex" | "opencode"` 字段、`setup/claude-code.ts` 安装向导。本文是该抽象在 Codex 上的落地路径。

## 2. 架构对照

| 层 | Claude Code 现状 | Codex 目标 | 迁移成本 |
|---|---|---|---|
| MCP Server | `~/.claude.json` → `adapters/claude-code/mcp-server.js` | `config.toml` `[mcp_servers.ai-memory-engine]` | 零改动（标准 MCP over stdio） |
| SessionStart 钩子 | `mem-sync sync` + `cat MEMORY.md` 注入 | 同命令写入 `hooks.json` | 零改动 |
| UserPromptSubmit 钩子 | `scan.js` 读 `$USER_PROMPT` 环境变量 | 同命令 + stdin→env shim | **唯一适配点** |
| Stop 钩子 | `extract-prompt.js` + `mem-sync push` | 同命令写入 `hooks.json` | 零改动（已核：只读 `MEMORY_DIR`，无 Claude transcript 依赖） |
| 全局指令 | `CLAUDE.md`「查看 ai-memory 记忆库」 | `AGENTS.md` 同句 | 纯文本 |
| 手动提取命令 | `~/.claude/commands/mem-reflect.md` | `~/.codex/prompts/mem-reflect.md` | 纯文本 |

存储层完全共享：两端指向同一 `MEMORY_DIR`，Codex 写入的记忆 Claude 下次 `sync` 即可见，反之亦然。git 同步（`mem-sync`）沿用现有机制，未开启时自动静默跳过。

## 3. 接入步骤

### 步骤 1：注册 MCP Server

编辑 `~/.codex/config.toml`，追加：

```toml
[mcp_servers.ai-memory-engine]
command = "node"
args = ["/Users/longfei5/ai-memory/ai-memory-engine/dist/adapters/claude-code/mcp-server.js"]
env = { MEMORY_DIR = "/Users/longfei5/ai-memory/memory" }
```

说明：
- 路径名 `adapters/claude-code` 不影响 Codex 使用——该文件说的是标准 MCP（stdio JSON-RPC），客户端无关。后续可在 `src/adapters/codex/` 建薄壳入口统一命名（见 §6）。
- cc-switch 切换供应商只重写 provider/model 段，`[mcp_servers.*]` 实测保留，不受影响。

### 步骤 2：注册 Hooks

编辑 `~/.codex/hooks.json`。注意该文件可能已有其他条目（本机有 orca 的钩子），**在对应事件数组里追加，不要整体覆盖**：

```jsonc
{
  "hooks": {
    // ... 已有钩子保持不动 ...
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "MEMORY_DIR=\"/Users/longfei5/ai-memory/memory\" node \"/Users/longfei5/ai-memory/ai-memory-engine/dist/bin/mem-sync.js\" sync --quiet; cat \"/Users/longfei5/ai-memory/memory/MEMORY.md\" 2>/dev/null || echo \"记忆库为空，暂无跨会话记忆。\""
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "MEMORY_DIR=\"/Users/longfei5/ai-memory/memory\" USER_PROMPT=\"$(/Users/longfei5/ai-memory/ai-memory-engine/config/codex-scan-shim.sh)\" node \"/Users/longfei5/ai-memory/ai-memory-engine/dist/bin/scan.js\""
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "MEMORY_DIR=\"/Users/longfei5/ai-memory/memory\" node \"/Users/longfei5/ai-memory/ai-memory-engine/dist/bin/extract-prompt.js\""
          },
          {
            "type": "command",
            "command": "MEMORY_DIR=\"/Users/longfei5/ai-memory/memory\" node \"/Users/longfei5/ai-memory/ai-memory-engine/dist/bin/mem-sync.js\" push --quiet"
          }
        ]
      }
    ]
  }
}
```

**输入通道差异与 shim**：Claude Code 给 `UserPromptSubmit` 钩子进程设 `$USER_PROMPT` 环境变量；Codex 的钩子契约未完全文档化，观察为 stdin JSON。shim 做双通道兼容——优先环境变量，否则读 stdin 解析 JSON（兼容 `prompt` / `user_prompt` / `input` 三种字段名），都拿不到则输出空串（`scan.js` 对空输入安全跳过）。

新建 `<引擎目录>/config/codex-scan-shim.sh`：

```bash
#!/bin/sh
# 从环境变量或 stdin JSON 提取用户消息，供 scan.js 的 USER_PROMPT 使用。
# env 优先（Claude Code 通道）；否则读 stdin 解析 JSON（Codex 通道，兼容 prompt/user_prompt/input 字段名）。
# 2 秒超时保护：stdin 无输入时不挂起，输出空串（scan.js 对空输入安全跳过）。
if [ -n "$USER_PROMPT" ]; then
  printf '%s' "$USER_PROMPT"
  exit 0
fi
NODE_BIN=$(command -v node 2>/dev/null || printf '%s' /opt/homebrew/bin/node)
exec "$NODE_BIN" -e '
let s = "", done = false;
const emit = () => {
  if (done) return;
  done = true;
  try {
    const j = JSON.parse(s);
    const p = j.prompt ?? j.user_prompt ?? j.input ?? "";
    process.stdout.write(typeof p === "string" ? p : JSON.stringify(p));
  } catch { /* 非 JSON 负载，放弃 */ }
};
const t = setTimeout(emit, 2000);
process.stdin.on("data", (d) => (s += d));
process.stdin.on("end", () => { clearTimeout(t); emit(); });
'
```

> 实施说明：原稿此处用 `timeout 2 cat`（依赖 GNU timeout），macOS 默认没有该命令会退化为裸 `cat`，stdin 不关闭时钩子会挂到超时。落地版改为纯 node 实现，超时逻辑内嵌。

```bash
chmod +x /Users/longfei5/ai-memory/ai-memory-engine/config/codex-scan-shim.sh
```

### 步骤 3：指令与手动命令

`~/.codex/AGENTS.md` 追加一行（注意清掉 claude-mem 遗留的 `<claude-mem-context>` 占位内容）：

```markdown
- 个人偏好与开发环境配置：通过 ai-memory-engine 记忆库获取（MCP 工具），会话开始时已自动注入 MEMORY.md
```

安装手动提取命令（文件在引擎仓库 `config/` 下已有）：

```bash
mkdir -p ~/.codex/prompts
cp /Users/longfei5/ai-memory/ai-memory-engine/config/mem-reflect.md ~/.codex/prompts/mem-reflect.md
```

## 4. 已核对的关键事实

| 事项 | 结论 | 依据 |
|---|---|---|
| `extract-prompt.js` 是否依赖 Claude transcript | **否**，只读 `MEMORY_DIR`，Stop 钩子可直接平移 | `src/bin/extract-prompt.ts:17` |
| `scan.js` 输入 | 仅 `$USER_PROMPT` 环境变量，空值安全 | `src/bin/scan.ts:15` |
| MCP server 客户端无关性 | 标准 MCP over stdio，Codex 原生支持 | 协议层 |
| Codex hooks 事件名 | 与 Claude 同名（`SessionStart`/`UserPromptSubmit`/`Stop`），文件结构同构 | 本机 `~/.codex/hooks.json` |
| hooks 信任机制 | Codex 对 hooks.json 变更有 trusted_hash 校验，**改完后首次启动需在 UI 确认信任** | 本机 config.toml `[hooks.state]` |

## 5. 验证清单

1. 重启 Codex（桌面端或 CLI），新开会话——确认开头出现 MEMORY.md 内容（SessionStart 注入生效；若未注入，核查 hook 信任提示）。
2. 对话中说「记住：我本地用 Java 17，Maven 3.9」——回合结束后检查 `MEMORY_DIR` 是否新增记忆文件（Stop 钩子 + MCP `store_memory` 链路）。
3. 输入 `/mem-reflect`——确认手动提取流程可走通（依赖 MCP 工具 `get_extract_prompt` / `store_memory`）。
4. 回到 Claude Code 新开会话——确认能看到第 2 步写入的记忆（跨端共享 + `mem-sync sync`）。
5. 在含明显触发词的消息后检查 `scan.js` 是否产出候选（UserPromptSubmit + shim 链路）。

## 6. 后续演进（建议，非本次必做）

- **建 `src/adapters/codex/`**：薄壳入口复用 claude-code 的 server 实现，统一命名，消除配置里的路径违和感。
- **建 `src/setup/codex.ts`**：仿照 `setup/claude-code.ts` 写 Codex 安装向导（改 `config.toml` + `hooks.json` + `prompts/`），并入 `dist/bin/setup.js` 交互选单。
- **shim 收编进引擎**：把 `codex-scan-shim.sh` 的逻辑改写为 `src/bin/scan.ts` 的 stdin 降级通道（env 优先、stdin 兜底），Codex/Claude 共用一份 `scan.js`，shim 退役。
- **记忆条目 `tool` 字段**：Codex 会话写入时置 `"codex"`，便于统计各端产出。
- 更远的：`ToolAdapter` 枚举里的 `opencode` 等宿主照同一模式扩展，引擎升级为全端记忆层。

## 7. 变更记录

- 2026-09-15：引擎多宿主重构与 Claude Code 钩子落地（会话 `sess_4034e623`）。
- 2026-09-17：本文创建。基于源码逐文件核对输入依赖；Codex 侧环境（LiteLLM 桥、hooks 信任机制、cc-switch 行为）均为本机实测结论。
- 2026-09-17：实施落地，命令级验证全过（shim 双通道、scan 触发、SessionStart 注入、MCP 握手 9 工具、orca 既有钩子逐字未动）。与原稿的差异：① `node` 一律用绝对路径 `/opt/homebrew/bin/node`（GUI 宿主 PATH 不可靠）；② Stop 的 extract→push 拆成两个独立 hook 组保证顺序；③ shim 改为纯 node 实现（见 §3 实施说明）。
