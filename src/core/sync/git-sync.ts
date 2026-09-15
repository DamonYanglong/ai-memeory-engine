/**
 * Git 同步器 — 多机记忆库分布式同步
 * @author longfei5
 * @date 2026/9/15
 *
 * 原理：memory 目录是一个 git 仓库，单条记忆文件（frontmatter 自包含）是真相源，
 * 聚合文件（MEMORY.md / registry.yaml）是可重建的派生物。
 *
 * 冲突策略：
 * - 聚合文件用 union 合并驱动（.gitattributes），双方新增的条目都保留
 * - 聚合文件仍冲突时取本地版，随后 rebuild 以文件集并集重生成 — 不丢条目
 * - 记忆文件冲突（双方改同一文件，罕见）取本地版
 *
 * 所有方法不抛异常，返回结构化结果 — 挂在 Hook 里执行时绝不阻塞会话。
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { hostname } from "node:os";
import { Storage } from "../storage/index.js";

const exec = promisify(execFile);

export type SyncAction =
  | "noop" // 无事可做（无变更 / 已与远端一致）
  | "init" // 初始化仓库
  | "committed" // 仅本地提交（未配置远端）
  | "pulled" // 拉取合并成功
  | "pushed" // 推送成功
  | "conflict-recovered" // 冲突已自动恢复
  | "not-a-repo" // 目录不是 git 仓库（需先 mem-sync init）
  | "error"; // 执行失败（网络等），下次重试

export interface SyncResult {
  action: SyncAction;
  detail?: string;
}

const GITIGNORE_CONTENT = [
  "# 本机候选队列（跨机不共享）",
  ".meta/candidates-queue*.yaml",
  "# 原子写临时文件",
  "*.tmp-*",
  "",
].join("\n");

const GITATTRIBUTES_CONTENT = [
  "# 聚合文件用 union 合并：双方各自新增的行/条目都保留，rebuild 再归一化",
  "MEMORY.md merge=union",
  ".meta/registry.yaml merge=union",
  ".meta/pending-conflicts.yaml merge=union",
  "",
].join("\n");

export class GitSync {
  private readonly memoryDir: string;
  private readonly storage: Storage;

  constructor(memoryDir: string) {
    this.memoryDir = memoryDir;
    this.storage = new Storage(memoryDir);
  }

  // ─── 对外操作 ──────────────────────────────────

  /** 初始化 memory 目录为 git 同步仓库（幂等，可重复执行） */
  async init(remoteUrl?: string): Promise<SyncResult> {
    try {
      // 目标机器可能在写入第一条记忆前就执行 init
      await mkdir(this.memoryDir, { recursive: true });
      const fresh = !(await this.isRepo());
      if (fresh) {
        await this.git(["init", "-b", "main"]).catch(() => this.git(["init"]));
      }
      await this.writeSyncFiles();
      await this.untrackSharedQueue();
      const committed = await this.commitIfDirty("memory: init sync repo");

      if (remoteUrl) {
        await this.git(["remote", "remove", "origin"]).catch(() => {});
        await this.git(["remote", "add", "origin", remoteUrl]);
      }
      const remote = await this.remoteName();
      if (remote) {
        try {
          await this.git(["push", "-u", remote, "HEAD"]);
        } catch {
          // 远端已有其他机器的历史（第二台机器接入）→ 合并后再推
          const pullResult = await this.pull();
          if (pullResult.action === "error") return pullResult;
          await this.git(["push", "-u", remote, "HEAD"]);
        }
      }
      return {
        action: fresh ? "init" : committed ? "committed" : "noop",
        detail: remote ? `远端: ${remote}` : "未配置远端，仅本地仓库",
      };
    } catch (e) {
      return this.fail(e);
    }
  }

  /** 拉取并合并远端（先提交本地未提交变更） */
  async pull(): Promise<SyncResult> {
    try {
      if (!(await this.isRepo())) return { action: "not-a-repo" };
      await this.commitIfDirty();
      const remote = await this.remoteName();
      if (!remote) return { action: "noop", detail: "未配置远端，仅本地模式" };

      await this.git(["fetch", remote]);
      const ref = await this.remoteTrackingRef(remote);
      if (!ref) return { action: "noop", detail: "远端无分支" };
      let conflictRecovered = false;
      try {
        await this.git([
          "merge",
          ref,
          "--no-edit",
          "--allow-unrelated-histories",
          "-m",
          "memory: merge from remote",
        ]);
      } catch {
        conflictRecovered = true;
        await this.resolveConflicts();
      }

      // 无论是否冲突，合并后都按文件集重建聚合文件
      await this.storage.rebuild();
      await this.commitIfDirty("memory: rebuild aggregates after merge");
      return { action: conflictRecovered ? "conflict-recovered" : "pulled" };
    } catch (e) {
      return this.fail(e);
    }
  }

  /** 重建聚合 → 提交 → 推送（被拒时先合并再重试一次） */
  async push(): Promise<SyncResult> {
    try {
      if (!(await this.isRepo())) return { action: "not-a-repo" };
      await this.storage.rebuild();
      const committed = await this.commitIfDirty(`memory: update from ${hostname()}`);
      const remote = await this.remoteName();
      if (!remote) {
        return { action: committed ? "committed" : "noop", detail: "未配置远端，仅本地提交" };
      }
      if (!committed && !(await this.aheadOfUpstream())) {
        return { action: "noop" };
      }

      try {
        await this.git(["push", remote, "HEAD"]);
        return { action: "pushed" };
      } catch {
        // 远端有新提交（另一台机器先推了）→ 合并后重试
        const pullResult = await this.pull();
        if (pullResult.action === "error") return pullResult;
        await this.git(["push", remote, "HEAD"]);
        return { action: "pushed", detail: "合并远端后推送成功" };
      }
    } catch (e) {
      return this.fail(e);
    }
  }

  /** 拉取 + 推送（钩子调用的完整同步） */
  async sync(): Promise<SyncResult> {
    const pullResult = await this.pull();
    if (pullResult.action === "error" || pullResult.action === "not-a-repo") {
      return pullResult;
    }
    const pushResult = await this.push();
    if (pushResult.action === "noop" && pullResult.action !== "noop") {
      return pullResult;
    }
    return pushResult;
  }

  // ─── 内部实现 ──────────────────────────────────

  /** 当前生效的远端名（取第一个） */
  private async remoteName(): Promise<string | null> {
    const out = await this.git(["remote"]);
    const first = out.split("\n").map((s) => s.trim()).filter(Boolean)[0];
    return first ?? null;
  }

  /**
   * 远端跟踪引用（refs/remotes/<remote>/<branch>）
   *
   * 不能用 FETCH_HEAD：分支未配置 upstream 时 fetch 会把它标记为
   * not-for-merge，`git merge FETCH_HEAD` 会静默变成 no-op。
   */
  private async remoteTrackingRef(remote: string): Promise<string | null> {
    const branch = (await this.git(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    if (branch && branch !== "HEAD") {
      const ref = `refs/remotes/${remote}/${branch}`;
      try {
        await this.git(["rev-parse", "--verify", "--quiet", ref]);
        return ref;
      } catch {
        // 本地分支名在远端不存在，走回退逻辑
      }
    }
    try {
      const out = await this.git(["for-each-ref", "--format=%(refname)", `refs/remotes/${remote}/`]);
      const first = out.split("\n").map((s) => s.trim()).filter(Boolean)[0];
      return first ?? null;
    } catch {
      return null;
    }
  }

  /** 本地是否有未推送的提交（纯本地检查，无网络开销） */
  private async aheadOfUpstream(): Promise<boolean> {
    try {
      const out = await this.git(["rev-list", "--count", "@{upstream}..HEAD"]);
      return parseInt(out.trim(), 10) > 0;
    } catch {
      // 无上游跟踪（未 push -u 过）视为需要推送
      return true;
    }
  }

  /** 解决合并冲突：一律取本地版，聚合文件随后由 rebuild 归一（不丢条目） */
  private async resolveConflicts(): Promise<void> {
    const out = await this.git(["diff", "--name-only", "--diff-filter=U"]);
    const conflicted = out.split("\n").map((s) => s.trim()).filter(Boolean);

    for (const path of conflicted) {
      // union 驱动通常已自动合并聚合文件；仍冲突（如双方改同一行）则取本地版，
      // 对方新增的条目来自其记忆文件，由随后的 rebuild 补回。
      const kept = await this.git(["checkout", "--ours", "--", path])
        .then(() => true)
        .catch(() => false);
      if (kept) {
        await this.git(["add", "--", path]);
      } else {
        // 本地已删除的路径（delete/modify 冲突）接受删除
        await this.git(["rm", "--force", "--", path]).catch(() => {});
      }
    }
    await this.git(["add", "-A"]).catch(() => {});
    await this.git(["commit", "--no-edit", "--no-verify"]).catch(() => {});
  }

  /** 有变更则提交，返回是否产生了新提交 */
  private async commitIfDirty(message?: string): Promise<boolean> {
    const status = await this.git(["status", "--porcelain"]);
    if (!status.trim()) return false;
    await this.git(["add", "-A"]);
    await this.git(["commit", "--no-verify", "-m", message ?? `memory: update from ${hostname()}`]);
    return true;
  }

  /**
   * 写入 .gitignore / .gitattributes（增量合并，保留用户已有条目）
   */
  private async writeSyncFiles(): Promise<void> {
    await this.mergeFileLines(
      join(this.memoryDir, ".gitignore"),
      GITIGNORE_CONTENT,
      "# --- ai-memory-engine sync ---",
    );
    await this.mergeFileLines(
      join(this.memoryDir, ".gitattributes"),
      GITATTRIBUTES_CONTENT,
      "# --- ai-memory-engine sync ---",
    );
  }

  /** 将内容按行合并进已有文件：已有的行不重复添加，用户自定义条目原样保留 */
  private async mergeFileLines(filePath: string, content: string, banner: string): Promise<void> {
    let existing = "";
    try {
      existing = await readFile(filePath, "utf-8");
    } catch {
      // 文件不存在
    }
    const existingLines = new Set(
      existing.split("\n").map((l) => l.trim()).filter(Boolean),
    );
    const missing = content
      .split("\n")
      .filter((l) => l.trim() && !existingLines.has(l.trim()));
    if (missing.length === 0) return;
    const merged = existing.trimEnd()
      ? `${existing.trimEnd()}\n\n${banner}\n${missing.join("\n")}\n`
      : `${banner}\n${missing.join("\n")}\n`;
    await writeFile(filePath, merged, "utf-8");
  }

  /**
   * 历史遗留：共享候选队列文件曾被跟踪（按主机隔离后不应入库），解除跟踪但保留本地文件
   */
  private async untrackSharedQueue(): Promise<void> {
    const tracked = await this.git(["ls-files"]);
    if (tracked.split("\n").some((l) => l.trim() === ".meta/candidates-queue.yaml")) {
      await this.git(["rm", "--cached", "--quiet", ".meta/candidates-queue.yaml"]);
    }
  }

  private async isRepo(): Promise<boolean> {
    try {
      const out = await this.git(["rev-parse", "--is-inside-work-tree"]);
      return out.trim() === "true";
    } catch {
      return false;
    }
  }

  private async git(args: string[]): Promise<string> {
    const { stdout } = await exec("git", ["-C", this.memoryDir, ...args], {
      env: this.gitEnv(),
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout;
  }

  /** git 提交身份与机器绑定，禁用交互式凭据提示 */
  private gitEnv(): NodeJS.ProcessEnv {
    const host = hostname();
    return {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: `ai-memory (${host})`,
      GIT_AUTHOR_EMAIL: `ai-memory@${host}.local`,
      GIT_COMMITTER_NAME: `ai-memory (${host})`,
      GIT_COMMITTER_EMAIL: `ai-memory@${host}.local`,
    };
  }

  private fail(e: unknown): SyncResult {
    const detail = e instanceof Error ? e.message.split("\n")[0] : String(e);
    return { action: "error", detail: detail.slice(0, 200) };
  }
}
