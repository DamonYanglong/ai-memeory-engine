#!/usr/bin/env node

/**
 * 记忆同步 CLI — 多机 git 同步入口
 * @author longfei5
 * @date 2026/9/15
 *
 * 用法：
 *   mem-sync init [--remote <git-url>]   初始化 memory 目录为同步仓库
 *   mem-sync pull                        拉取合并远端
 *   mem-sync push                        重建聚合 + 提交 + 推送
 *   mem-sync sync                        pull + push（钩子调用）
 *
 * 选项：
 *   --quiet       只输出错误（Hook 模式）
 *   -C <dir>      指定 memory 目录（默认 $MEMORY_DIR 或 ./memory）
 *
 * 任何失败都以退出码 0 结束并输出错误信息 — 钩子里绝不阻塞会话，
 * 未同步的变更会在下一次 sync 时补上。
 */

import { join } from "node:path";
import { GitSync, type SyncResult } from "../core/sync/git-sync.js";

interface Args {
  command: string;
  remote?: string;
  quiet: boolean;
  dir: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { command: "sync", quiet: false, dir: process.env.MEMORY_DIR ?? join(process.cwd(), "memory") };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--quiet") args.quiet = true;
    else if (a === "--remote" || a === "-r") args.remote = argv[++i];
    else if (a === "-C") args.dir = argv[++i];
    else positional.push(a);
  }
  if (positional.length > 0) args.command = positional[0];
  return args;
}

const DESCRIPTIONS: Record<string, string> = {
  noop: "无变更",
  init: "初始化同步仓库",
  committed: "已本地提交",
  pulled: "已拉取远端",
  pushed: "已推送",
  "conflict-recovered": "冲突已自动恢复",
  "not-a-repo": "未初始化（先运行 mem-sync init）",
  error: "失败",
};

function report(result: SyncResult, quiet: boolean): void {
  if (result.action === "not-a-repo") {
    // 未开启同步是合法状态，静默即可
    if (!quiet) console.log(`[ai-memory] 同步未启用，运行 mem-sync init 开启多机同步`);
    return;
  }
  const desc = DESCRIPTIONS[result.action] ?? result.action;
  const detail = result.detail ? `（${result.detail}）` : "";
  const isError = result.action === "error";
  if (!quiet || isError) {
    console.log(`[ai-memory] ${desc}${detail}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sync = new GitSync(args.dir);

  let result: SyncResult;
  switch (args.command) {
    case "init":
      result = await sync.init(args.remote);
      break;
    case "pull":
      result = await sync.pull();
      break;
    case "push":
      result = await sync.push();
      break;
    case "sync":
      result = await sync.sync();
      break;
    default:
      console.error(`未知命令: ${args.command}（可用: init / pull / push / sync）`);
      process.exit(1);
  }
  report(result, args.quiet);
}

main().catch((e) => {
  console.error(`[ai-memory] 同步异常: ${e instanceof Error ? e.message : e}`);
});
