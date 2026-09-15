# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

AI Memory Engine — 通用 AI 记忆引擎，作为 MCP Server 运行，让 AI 编程助手跨会话记住用户偏好、纠正和经验。

核心设计原则：**智能外置** — MCP Server 只做纯数据操作（CRUD、匹配、队列），智能判断全部交给宿主模型（Claude Code 等）。不调用任何 LLM API。

## 常用命令

```bash
npm run build        # tsc 编译 TypeScript → dist/
npm run test         # vitest run（全量）
npm run test:watch   # vitest watch 模式
npm run typecheck    # tsc --noEmit 类型检查
npm run dev          # tsx 开发模式启动 MCP Server

# 运行单个测试文件
npx vitest run tests/storage.test.ts

# 运行匹配名称的测试
npx vitest run -t "冲突检测"

# 多机同步 CLI（git 化的 memory 目录）
node dist/bin/mem-sync.js init --remote <git-url>   # 每台机器执行一次
node dist/bin/mem-sync.js sync                      # 手动双向同步
```

环境变量 `MEMORY_DIR` 指定记忆存储目录，默认 `$CWD/memory/`。

## 架构

### 两层提取流水线

```
实时层: UserPromptSubmit Hook → scan.js(正则零开销匹配) → 候选队列
批量层: Stop Hook → extract-prompt.js → 宿主模型精提取 → store_memory 写入
同步层: SessionStart Hook → mem-sync sync（拉取）；Stop Hook → mem-sync push（推送）
```

### 模块分层

```
src/
├── core/                    # 核心逻辑（无外部依赖）
│   ├── types/memory.ts      # 所有类型定义 + 默认配置（全局共享契约）
│   ├── extractor/           # 提取器：正则扫描 + Prompt 生成
│   │   ├── patterns.ts      # 四类正则模式库（纠正/偏好/经验/确认）
│   │   └── prompts.ts       # 提取 Prompt 模板（引导宿主模型三步提取）
│   ├── storage/             # 存储器：文件管理 + 索引 + 冲突 + 关联
│   │   ├── index.ts         # Storage 门面（核心写入流程 7 步 + rebuild）
│   │   ├── file-manager.ts  # 文件读写（frontmatter 自包含元数据）+ registry.yaml
│   │   ├── index-manager.ts # MEMORY.md 索引维护
│   │   ├── link-manager.ts  # 记忆间关联链接
│   │   ├── conflict.ts      # 冲突检测 + 四种关系裁决
│   │   ├── candidate-queue.ts  # 候选队列（按主机隔离）
│   │   ├── rebuild.ts       # 从记忆文件集重建聚合文件（同步冲突恢复）
│   │   └── fs-utils.ts      # 原子写（temp + rename）
│   └── sync/
│       └── git-sync.ts      # 多机 git 同步（init/pull/push + 冲突恢复）
├── adapters/                # 工具适配层
│   ├── interface.ts         # ToolAdapter 接口（为 Codex/OpenCode 等扩展预留）
│   └── claude-code/
│       └── mcp-server.ts    # Claude Code MCP Server 入口（注册 9 个工具）
├── bin/                     # CLI 入口
│   ├── scan.js              # Hook 调用：正则预筛选
│   ├── extract-prompt.js    # Hook 调用：生成提取 Prompt
│   ├── mem-sync.js          # Hook/手动调用：多机 git 同步
│   └── setup.js             # 交互式安装向导
└── setup/                   # 安装向导模块
```

### 关键数据流

1. **store_memory** 核心流程：置信度检查 → 准备文件名 → 冲突检测(关键词比对) → 写入文件 → 建立关联链接 → 更新 MEMORY.md 索引 → 更新 registry.yaml
2. **冲突裁决** 四种关系：contradicts(需用户选 replace/keep/coexist)、supplements(追加)、duplicates(跳过)、unrelated(新建)
3. **正则置信度梯度**：纠正 0.85 > 偏好 0.80 > 经验 0.70 > 确认 0.50
4. **多机同步不变量**：单条记忆文件（frontmatter 自包含）是真相源；MEMORY.md/registry.yaml 是派生物，任何 git 合并冲突都以文件集 rebuild 恢复，不丢条目。聚合文件配 union 合并驱动（.gitattributes），候选队列按主机隔离且被 .gitignore 排除。所有写入必须走 writeFileAtomic（同步与 MCP Server 并发写共存的前提）。

### 记忆存储结构

记忆按三类目录存放：`details/`(知识点)、`cases/`(案例经验)、`principles/`(原则偏好)。元数据在 `.meta/registry.yaml`，索引在 `MEMORY.md`，候选队列 `.meta/candidates-queue.<host>.yaml`（本机私有）。

## 技术栈

- TypeScript (ES2022, Node16 模块)，ESM-only (`"type": "module"`)
- MCP SDK (`@modelcontextprotocol/sdk`) — stdio 传输
- Zod — MCP 工具参数校验
- gray-matter + js-yaml — Markdown frontmatter 和 YAML 持久化
- Vitest — 测试框架

## 扩展适配器

`src/adapters/interface.ts` 定义了 `ToolAdapter` 接口，覆盖五个能力维度：生命周期、对话格式转换、上下文注入、用户交互、工具注册。当前仅实现 Claude Code 适配器。新增 AI 工具支持时实现此接口。
