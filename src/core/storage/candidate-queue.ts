/**
 * 候选队列 — 正则预筛选层的缓冲区
 * @author longfei5
 * @date 2026/3/11
 *
 * 正则 Hook 实时写入候选项，宿主模型在会话结束时读取审核。
 * 存储格式：YAML 文件，7 天自动过期。
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import yaml from "js-yaml";
import type { QueueItem } from "../types/memory.js";

/** 候选队列文件结构 */
interface QueueFile {
  items: QueueItem[];
}

export class CandidateQueue {
  private readonly queuePath: string;
  private static readonly RETENTION_DAYS = 7;

  constructor(memoryDir: string, queueFile = ".meta/candidates-queue.yaml") {
    this.queuePath = join(memoryDir, queueFile);
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
    try {
      const raw = await readFile(this.queuePath, "utf-8");
      return (yaml.load(raw) as QueueFile) ?? { items: [] };
    } catch {
      return { items: [] };
    }
  }

  private async save(queue: QueueFile): Promise<void> {
    await mkdir(dirname(this.queuePath), { recursive: true });
    await writeFile(this.queuePath, yaml.dump(queue, { lineWidth: 120 }), "utf-8");
  }
}
