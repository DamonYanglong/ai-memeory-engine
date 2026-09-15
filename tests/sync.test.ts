/**
 * Git 同步集成测试 — 模拟两台机器通过 bare 仓库同步记忆
 * @author longfei5
 * @date 2026/9/15
 *
 * 场景（对应本机 + 虚拟机的多机使用）：
 * 1. 机器 A 开启同步并推送
 * 2. 机器 B 独立写入后接入同一远端（不相关历史合并）
 * 3. 双方并发写入同一聚合文件（MEMORY.md）→ union 合并 + rebuild，双方条目都保留
 * 4. 候选队列文件不入库（本机私有）
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, access } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { tmpdir, hostname } from "node:os";
import { Storage } from "../src/core/storage/index.js";
import { GitSync } from "../src/core/sync/git-sync.js";
import type { CandidateMemory } from "../src/core/types/memory.js";

const exec = promisify(execFile);

function makeCandidate(summary: string, keywords: string[]): CandidateMemory {
  return {
    type: "principles",
    trigger: "preference",
    summary,
    detail: `${summary} 的详细内容。`,
    keywords,
    confidence: 0.85,
  };
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function gitLines(dir: string, args: string[]): Promise<string[]> {
  const { stdout } = await exec("git", ["-C", dir, ...args]);
  return stdout.split("\n").map((s) => s.trim()).filter(Boolean);
}

describe("GitSync 多机同步", () => {
  let root: string;
  let dirA: string;
  let dirB: string;
  let remote: string;
  let storageA: Storage;
  let storageB: Storage;
  let syncA: GitSync;
  let syncB: GitSync;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ai-memory-sync-"));
    dirA = join(root, "machine-a");
    dirB = join(root, "machine-b");
    remote = join(root, "remote.git");
    await exec("git", ["init", "--bare", "-b", "main", remote]);

    storageA = new Storage(dirA);
    storageB = new Storage(dirB);
    syncA = new GitSync(dirA);
    syncB = new GitSync(dirB);
  }, 30000);

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("未 init 的目录返回 not-a-repo，不抛异常", async () => {
    const result = await syncA.sync();
    expect(result.action).toBe("not-a-repo");
  });

  it("机器 A init 推送 → 机器 B 独立写入后接入 → 双方记忆互通", async () => {
    // 机器 A：已有记忆 m1，开启同步
    const m1 = await storageA.store(makeCandidate("统一使用 pnpm", ["pnpm"]));
    if (m1.status !== "success") throw new Error("store m1 失败");

    const initA = await syncA.init(remote);
    expect(initA.action).toBe("init");

    // 机器 B：独立写入了 m2（与 A 完全隔离），随后接入同一远端
    const m2 = await storageB.store(makeCandidate("不用 PageHelper", ["PageHelper", "分页"]));
    if (m2.status !== "success") throw new Error("store m2 失败");

    const initB = await syncB.init(remote);
    expect(initB.action).toBe("init");

    // B 侧应同时看到两条记忆
    expect(await pathExists(join(dirB, m1.filePath))).toBe(true);
    const indexB = await readFile(join(dirB, "MEMORY.md"), "utf-8");
    expect(indexB).toContain(m1.filePath);
    expect(indexB).toContain(m2.filePath);
    const statsB = await storageB.getStats();
    expect(statsB.total).toBe(2);

    // A 侧 pull 后同样互通
    const pullA = await syncA.pull();
    expect(["pulled", "conflict-recovered", "noop"]).toContain(pullA.action);
    expect(await pathExists(join(dirA, m2.filePath))).toBe(true);
    const indexA = await readFile(join(dirA, "MEMORY.md"), "utf-8");
    expect(indexA).toContain(m2.filePath);
  }, 60000);

  it("并发写入：双方各自新增记忆并推送，冲突自动恢复且双方条目都不丢", async () => {
    // 建立共同基线
    await storageA.store(makeCandidate("统一使用 pnpm", ["pnpm"]));
    await syncA.init(remote);
    await syncB.init(remote);
    await syncA.pull();

    // 双方在未同步的情况下并发写入（各自修改了 MEMORY.md + 各自新增文件）
    const m3 = await storageA.store(makeCandidate("提交信息用中文", ["commit", "规范"]));
    const m4 = await storageB.store(makeCandidate("测试跑在 vitest", ["vitest", "测试"]));
    if (m3.status !== "success" || m4.status !== "success") throw new Error("store 失败");

    // A 先推
    const pushA = await syncA.push();
    expect(pushA.action).toBe("pushed");

    // B 后推 → 被拒 → 自动合并（union + rebuild）→ 重试成功
    const pushB = await syncB.push();
    expect(pushB.action).toBe("pushed");

    // B 侧：双方条目都在
    const indexB = await readFile(join(dirB, "MEMORY.md"), "utf-8");
    expect(indexB).toContain(m3.filePath);
    expect(indexB).toContain(m4.filePath);
    expect(await pathExists(join(dirB, m3.filePath))).toBe(true);
    const statsB = await storageB.getStats();
    expect(statsB.total).toBe(3);

    // A 侧 pull 后同样完整
    await syncA.pull();
    const indexA = await readFile(join(dirA, "MEMORY.md"), "utf-8");
    expect(indexA).toContain(m3.filePath);
    expect(indexA).toContain(m4.filePath);
  }, 60000);

  it("同一记忆在两台机器重复学习：合并后保留单份，索引无重复行", async () => {
    // 两台机器在隔离状态下学到了同一条记忆（相同关键词 → 相同文件名）
    const candidate = makeCandidate("统一使用 pnpm", ["pnpm", "包管理"]);
    const rA = await storageA.store(candidate);
    const rB = await storageB.store(candidate);
    if (rA.status !== "success" || rB.status !== "success") throw new Error("store 失败");

    await syncA.init(remote);
    // B 接入时同名记忆文件 add/add 冲突 → 自动恢复
    const initB = await syncB.init(remote);
    expect(initB.action).toBe("init");

    // 文件保留单份，索引恰好一行，registry 恰好一个条目
    const indexB = await readFile(join(dirB, "MEMORY.md"), "utf-8");
    const occurrences = indexB.split(rA.filePath).length - 1;
    expect(occurrences).toBe(1);
    const statsB = await storageB.getStats();
    expect(statsB.total).toBe(1);

    // A 侧 pull 后一致
    await syncA.pull();
    const indexA = await readFile(join(dirA, "MEMORY.md"), "utf-8");
    expect(indexA.split(rA.filePath).length - 1).toBe(1);
    const statsA = await storageA.getStats();
    expect(statsA.total).toBe(1);
  }, 60000);

  it("接入已有仓库：保留自定义 .gitignore 条目，解除共享队列跟踪", async () => {
    // 模拟用户现状：memory 目录已是 git 仓库，有自定义 .gitignore，
    // 且历史共享队列文件被 git 跟踪
    await storageA.store(makeCandidate("统一使用 pnpm", ["pnpm"]));
    await exec("git", ["-C", dirA, "init", "-b", "main"]);
    await writeFile(join(dirA, ".gitignore"), "/.idea/\n.idea/\n", "utf-8");
    await writeFile(
      join(dirA, ".meta", "candidates-queue.yaml"),
      "items: []\n",
      "utf-8",
    );
    await exec("git", ["-C", dirA, "add", "-A"]);
    await exec("git", ["-C", dirA, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "历史提交"]);

    const result = await syncA.init(remote);
    expect(result.action).toBe("committed");

    // 自定义条目保留，同步条目增量追加（不覆盖用户的 .gitignore）
    const gitignore = await readFile(join(dirA, ".gitignore"), "utf-8");
    expect(gitignore).toContain(".idea/");
    expect(gitignore).toContain("candidates-queue*.yaml");

    // 共享队列解除跟踪，本地文件保留
    const tracked = await gitLines(dirA, ["ls-files"]);
    expect(tracked).not.toContain(".meta/candidates-queue.yaml");
    expect(await pathExists(join(dirA, ".meta", "candidates-queue.yaml"))).toBe(true);
  }, 60000);

  it("候选队列是本机私有文件，不入同步仓库", async () => {
    await storageA.store(makeCandidate("统一使用 pnpm", ["pnpm"]));
    await storageA.appendCandidate({
      pattern: "preference",
      matchedText: "以后都用 pnpm",
      suggestedType: "principles",
      confidence: 0.8,
      capturedAt: new Date().toISOString(),
    });
    await syncA.init(remote);
    await syncA.push();

    const tracked = await gitLines(dirA, ["ls-files"]);
    expect(tracked.some((f) => f.includes("candidates-queue"))).toBe(false);
    // 记忆本体与聚合文件在库内
    expect(tracked).toContain("MEMORY.md");
    expect(tracked).toContain(".meta/registry.yaml");
  }, 60000);
});
