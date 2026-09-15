/**
 * 文件系统工具 — 同步安全写入
 * @author longfei5
 * @date 2026/9/15
 *
 * 多机同步场景下的写入约定：
 * 1. 原子写：先写临时文件再 rename，读方永远看到完整文件
 * 2. 临时文件命名带 pid + 随机后缀，多进程并发时不互踩，且被 .gitignore 排除
 */

import { writeFile, rename, mkdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";

/**
 * 原子写入文件：写临时文件 → rename 替换
 *
 * rename 在 POSIX 上是原子的，读方要么看到旧内容要么看到新内容，
 * 不会读到半截文件。这是 git 同步（SessionStart pull / Stop push）
 * 与 MCP Server 并发写共存的前提。
 */
export async function writeFileAtomic(filePath: string, data: string): Promise<void> {
  const tmp = `${filePath}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(tmp, data, "utf-8");
  await rename(tmp, filePath);
}
