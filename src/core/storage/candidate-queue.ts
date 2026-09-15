/**
 * 候选队列 — 正则预筛选层的缓冲区
 * @author longfei5
 * @date 2026/3/11
 *
 * 正则 Hook 实时写入候选项，宿主模型在会话结束时读取审核。
 * 存储格式：YAML 文件，7 天自动过期。
 *
 * 多机同步注意：队列文件按主机名隔离（candidates-queue.<host>.yaml），
 * 且被 .gitignore 排除 — 候选是"本机本会话"的暂存状态，
 * 跨机共享会导致另一台机器的会话结束时提取到不相关候选。
 */

import { readFile, mkdir, rename } from "node:fs/promises";
import { join, dirname } from "node:path";
import { hostname } from "node:os";
import yaml from "js-yaml";
import type { QueueItem } from "../types/memory.js";
import { writeFileAtomic } from "./fs-utils.js";

/** 候选队列文件结构 */
interface QueueFile {
  items: QueueItem[];
}

export class CandidateQueue {
  private readonly queuePath: string;
  /** 历史共享队列文件（迁移用） */
  private readonly legacyPath: string;
  private static readonly RETENTION_DAYS = 7;

  constructor(memoryDir: string, queueFile?: string) {
    // 显式指定则尊重配置；缺省按主机隔离
    const file = queueFile?.trim() || `.meta/candidates-queue.${hostname()}.yaml`;
    this.queuePath = join(memoryDir, file);
    this.legacyPath = join(memoryDir, ".meta", "candidates-queue.yaml");
  }

  /** 读取所有候选项（自动清除过期条目） */
  async getAll(): Promise<QueueItem[]> {
    const queue = await this.load();
    const now = Date.now();
    const retentionMs = CandidateQueue.RETENTION_DAYS * 24 * 60 * 60 * 1000;

    // 过滤掉超过 7 天的条目
    const valid = queue.items.filter((item) => {
      const capturedAt = new Date(item.capturedAt).getTime();
      return now - capturedAt < retentionMs;
    });

    // 如果有过期的，回写
    if (valid.length !== queue.items.length) {
      await this.save({ items: valid });
    }

    return valid;
  }

  /** 追加一条候选项 */
  async append(item: QueueItem): Promise<void> {
    const queue = await this.load();
    queue.items.push(item);
    await this.save(queue);
  }

  /** 清空队列 */
  async clear(): Promise<void> {
    await this.save({ items: [] });
  }

  /** 获取队列长度 */
  async size(): Promise<number> {
    const items = await this.getAll();
    return items.length;
  }

  // ─── 内部 ──────────────────────────────────────

  private async load(): Promise<QueueFile> {
    await this.migrateLegacyIfNeeded();
    try {
      const raw = await readFile(this.queuePath, "utf-8");
      return (yaml.load(raw) as QueueFile) ?? { items: [] };
    } catch {
      return { items: [] };
    }
  }

  /** 历史共享队列文件 → 本机队列文件（仅执行一次） */
  private async migrateLegacyIfNeeded(): Promise<void> {
    if (this.queuePath === this.legacyPath) return;
    try {
      await rename(this.legacyPath, this.queuePath);
    } catch {
      // 旧文件不存在或已迁移，忽略
    }
  }

  private async save(queue: QueueFile): Promise<void> {
    await mkdir(dirname(this.queuePath), { recursive: true });
    await writeFileAtomic(this.queuePath, yaml.dump(queue, { lineWidth: 120 }));
  }
}
