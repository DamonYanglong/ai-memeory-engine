# AI Memory Engine

通用 AI 记忆引擎 — 让 AI 编程助手跨会话记住你的偏好、纠正和经验。

## 工作原理

```
用户对话 ──→ 正则预筛选(Hook) ──→ 候选队列 ──→ 宿主模型精提取 ──→ 记忆库
                                                                    ↓
下次对话 ←── 匹配检索 ←────────────────────────────────────────── MEMORY.md
```

核心设计：
- **智能外置** — MCP Server 只做纯数据操作（CRUD、匹配、队列），智能判断交给宿主模型
- **Delta 原则** — 只存「用户预期 - 模型默认行为」的差异，不存常识
- **两层提取** — 正则零开销实时捕获 + 会话结束时宿主模型精提取
- **单文件即真相** — 每条记忆的 Markdown 自带 frontmatter 元数据，索引与注册表可随时重建，天然支持多机 git 同步

## 快速开始

### 前置条件

- Node.js >= 18
- Claude Code CLI

### 安装

```bash
git clone <repo-url> && cd ai-memory-engine
npm install && npm run build
```

### 方式一：自动安装（推荐）

```bash
node dist/bin/setup.js
```

交互式向导会自动配置 MCP Server、Hooks 和 Skill，并备份你的 `settings.json`。

### 方式二：手动配置

以下三步将 ai-memory-engine 集成到 Claude Code。

#### 1. 准备记忆目录

```bash
# 创建记忆存储目录（如果还没有的话）
mkdir -p ~/ai-memory/memory
```

#### 2. 注册 MCP Server（编辑 ~/.claude.json）

在 `~/.claude.json` 的 `mcpServers` 字段中添加（注意与已有配置合并，不要覆盖）：

```jsonc
{
  "mcpServers": {
    "ai-memory-engine": {
      "command": "node",
      "args": ["<引擎目录>/dist/adapters/claude-code/mcp-server.js"],
      "env": {
        "MEMORY_DIR": "<记忆目录>"
      }
    }
  }
}
```

#### 3. 注册 Hooks（编辑 ~/.claude/settings.json）

在 `~/.claude/settings.json` 的 `hooks` 字段中添加：

```jsonc
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "MEMORY_DIR=\"<记忆目录>\" node \"<引擎目录>/dist/bin/mem-sync.js\" sync --quiet; cat \"<记忆目录>/MEMORY.md\" 2>/dev/null || echo \"记忆库为空，暂无跨会话记忆。\""
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "USER_PROMPT=\"$USER_PROMPT\" node \"<引擎目录>/dist/bin/scan.js\""
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "MEMORY_DIR=\"<记忆目录>\" node \"<引擎目录>/dist/bin/extract-prompt.js\""
          },
          {
            "type": "command",
            "command": "MEMORY_DIR=\"<记忆目录>\" node \"<引擎目录>/dist/bin/mem-sync.js\" push --quiet"
          }
        ]
      }
    ]
  }
}
```

> 将 `<引擎目录>` 替换为 ai-memory-engine 的绝对路径，如 `/Users/you/ai-memory/ai-memory-engine`
>
> 将 `<记忆目录>` 替换为记忆存储的绝对路径，如 `/Users/you/ai-memory/memory`
>
> `mem-sync` 钩子在记忆目录未开启 git 同步时自动静默跳过，单机使用不受影响。

**~/.claude.json 示例**（假设用户名为 `you`）：

```jsonc
{
  // ... 你的其他配置 ...
  "mcpServers": {
    // ... 你的其他 MCP Server ...
    "ai-memory-engine": {
      "command": "node",
      "args": ["/Users/you/ai-memory/ai-memory-engine/dist/adapters/claude-code/mcp-server.js"],
      "env": {
        "MEMORY_DIR": "/Users/you/ai-memory/memory"
      }
    }
  }
}
```

**~/.claude/settings.json 示例**：

```jsonc
{
  // ... 你的其他配置 ...
  "hooks": {
    // ... 你的其他 hooks ...
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "USER_PROMPT=\"$USER_PROMPT\" node \"/Users/you/ai-memory/ai-memory-engine/dist/bin/scan.js\""
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "MEMORY_DIR=\"/Users/you/ai-memory/memory\" node \"/Users/you/ai-memory/ai-memory-engine/dist/bin/extract-prompt.js\""
          }
        ]
      }
    ]
  }
}
```

#### 4. 安装 Skill（可选）

```bash
cp <引擎目录>/config/mem-reflect.md ~/.claude/commands/mem-reflect.md
```

安装后可在 Claude Code 中使用 `/mem-reflect` 手动触发记忆提取。

### 验证安装

重启 Claude Code，然后：

```
# 检查 MCP Server 是否加载
> 调用 get_memory_stats 工具

# 测试记忆存储
> 我以后都用 pnpm，不要用 npm
# （如果 Hook 正常，会自动检测到偏好信号）
```

## 多机同步（可选）

通过 multica 等工具在多台机器（本机 + 虚拟机）运行智能体时，每台机器的记忆库默认相互隔离。
开启 git 同步后，记忆在机器间自动保持一致：

```
机器 A 会话结束 (Stop Hook)          机器 B 会话开始 (SessionStart Hook)
  store_memory 写入                    mem-sync sync 拉取远端
  mem-sync push 推送 ──→ git 仓库 ──→ 注入最新 MEMORY.md 到上下文
```

### 开启同步

在**每台机器**上执行（remote 指向同一个可互访的私有 git 仓库）：

```bash
# 第一台机器
node dist/bin/mem-sync.js init --remote <git-url>

# 其他机器（已有本地记忆也能接入，历史自动合并）
node dist/bin/mem-sync.js init --remote <git-url>
```

remote 可以是：公司 GitLab/GitHub 私有仓库，或任意一台机器上的 bare 仓库
（`git init --bare -b main ~/ai-memory-remote.git`，其他机器用 `ssh://user@host/~/ai-memory-remote.git` 访问）。

开启后 `mem-sync` 钩子自动工作：会话开始拉取、会话结束推送，无需手动操作。

### 为什么不会同步冲突丢数据

- **单文件即真相**：每条记忆的元数据（keywords/类型/置信度）写在文件 frontmatter 里，`MEMORY.md` 和 `registry.yaml` 只是可重建的派生物
- **union 合并**：聚合文件用 union 合并驱动，两台机器各自新增的条目都保留
- **冲突自动恢复**：极端冲突时以记忆文件集为准 rebuild 聚合文件，永不丢条目；两台机器学到同一条记忆时自动去重
- **本机状态隔离**：候选队列按主机名隔离且不入库，不会被另一台机器的会话误提取
- **写入原子化**：所有文件写入先写临时文件再 rename，同步与 MCP Server 并发写共存

### 手动操作

```bash
node dist/bin/mem-sync.js sync    # 立即双向同步
node dist/bin/mem-sync.js pull    # 仅拉取
node dist/bin/mem-sync.js push    # 仅推送
```

## 记忆存储结构

```
memory/
├── MEMORY.md              # 记忆索引（派生物，可从记忆文件重建）
├── .meta/
│   ├── registry.yaml      # 结构化元数据注册表（派生物）
│   ├── pending-conflicts.yaml
│   └── candidates-queue.<host>.yaml   # 本机候选队列（不入 git）
├── details/               # 具体细节类记忆
├── cases/                 # 案例经验类记忆
└── principles/            # 原则偏好类记忆
```

每个记忆文件自带 frontmatter（type/summary/keywords/confidence/createdAt），
是多机同步时的真相源。

## MCP 工具列表

| 工具 | 说明 |
|------|------|
| `store_memory` | 存储候选记忆，自动冲突检测 |
| `resolve_conflict` | 裁决记忆冲突（替换/保留/共存） |
| `get_memory_stats` | 获取记忆库统计信息 |
| `list_pending_conflicts` | 列出待裁决冲突 |
| `scan_message` | 扫描消息并入候选队列 |
| `get_extract_prompt` | 获取提取 Prompt（供宿主模型执行） |
| `get_candidate_queue` | 查看候选队列 |
| `append_candidate` | 手动追加候选项 |
| `clear_candidate_queue` | 清空候选队列 |

## 数据流

```
┌─ 实时层（每条消息） ──────────────────────────────┐
│  UserPromptSubmit Hook                            │
│  → scan.js 正则匹配                               │
│  → 命中时输出提示，宿主模型调用 scan_message 入队    │
└───────────────────────────────────────────────────┘
                        ↓
┌─ 批量层（会话结束） ──────────────────────────────┐
│  Stop Hook                                        │
│  → extract-prompt.js 读取候选队列                   │
│  → 输出提取 Prompt，宿主模型执行三步提取             │
│  → 调用 store_memory 写入，处理冲突                 │
└───────────────────────────────────────────────────┘
                        ↓
┌─ 手动层（按需） ─────────────────────────────────┐
│  /mem-reflect Skill                               │
│  → 回顾对话，补充自动提取遗漏的记忆                  │
└───────────────────────────────────────────────────┘
                        ↓
┌─ 同步层（多机） ─────────────────────────────────┐
│  SessionStart Hook → mem-sync sync（拉取）         │
│  Stop Hook → mem-sync push（推送）                 │
│  冲突时以记忆文件集为准 rebuild 聚合文件             │
└───────────────────────────────────────────────────┘
```

## 开发

```bash
npm run build        # 编译 TypeScript
npm run test         # 运行测试（76 tests）
npm run typecheck    # 类型检查
npm run dev          # 开发模式启动 MCP Server
```

## 许可

MIT
