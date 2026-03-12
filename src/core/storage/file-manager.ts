/**
 * 文件管理器 — 记忆文件的 CRUD 操作
 * @author longfei5
 * @date 2026/3/11
 *
 * 职责：
 * 1. 文件命名规范化（关键词 → kebab-case 文件名）
 * 2. Markdown 详情文件生成（三种类型各有格式）
 * 3. 文件读取与解析
 * 4. 元数据注册表（registry.yaml）维护
 */

import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { join, dirname, relative } from "node:path";
import yaml from "js-yaml";
import type {
  CandidateMemory,
  MemoryContent,
  MemoryEntry,
  MemoryRegistry,
  MemoryType,
  RelatedMemory,
  EngineConfig,
  PreparedMemory,
  MemoryStats,
} from "../types/memory.js";
import { DEFAULT_CONFIG } from "../types/memory.js";

export class FileManager {
  private readonly memoryDir: string;
  private readonly config: EngineConfig;

  constructor(memoryDir: string, config: Partial<EngineConfig> = {}) {
    this.memoryDir = memoryDir;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ─── 目录初始化 ────────────────────────────────

  /** 确保所有必要目录存在 */
  async ensureDirs(): Promise<void> {
    const dirs = [
      this.memoryDir,
      join(this.memoryDir, "details"),
      join(this.memoryDir, "cases"),
      join(this.memoryDir, "principles"),
      join(this.memoryDir, ".meta"),
    ];
    for (const dir of dirs) {
      await mkdir(dir, { recursive: true });
    }
  }

  // ─── 文件命名 ──────────────────────────────────

  /**
   * 将关键词列表转为规范化文件名
   *
   * 规则：英文小写，连字符分隔，不超过 50 字符
   * 示例：["PageHelper", "分页查询"] → "pagehelper-pagination"
   */
  normalizeFileName(keywords: string[]): string {
    const parts = keywords
      .slice(0, 4) // 最多取前 4 个关键词
      .map((kw) =>
        kw
          .toLowerCase()
          .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-") // 非字母数字中文替换为连字符
          .replace(/^-|-$/g, ""), // 去首尾连字符
      )
      .filter(Boolean);

    let name = parts.join("-");

    // 截断到 50 字符
    if (name.length > 50) {
      name = name.slice(0, 50).replace(/-[^-]*$/, ""); // 在连字符处截断
    }

    return name || "unnamed";
  }

  /** 生成完整的相对文件路径 */
  buildFilePath(type: MemoryType, fileName: string): string {
    return `${type}/${fileName}.md`;
  }

  /** 准备写入数据：生成文件名和路径 */
  prepare(candidate: CandidateMemory): PreparedMemory {
    const fileName = this.normalizeFileName(candidate.keywords);
    const filePath = this.buildFilePath(candidate.type, fileName);
    return { candidate, fileName, filePath };
  }

  // ─── 文件存在检查 ─────────────────────────────

  /** 检查记忆文件是否已存在 */
  async fileExists(filePath: string): Promise<boolean> {
    try {
      await access(join(this.memoryDir, filePath));
      return true;
    } catch {
      return false;
    }
  }

  // ─── 写入详情文件 ─────────────────────────────

  /** 将候选记忆写入 Markdown 文件 */
  async writeMemoryFile(prepared: PreparedMemory): Promise<void> {
    const { candidate, filePath } = prepared;
    const fullPath = join(this.memoryDir, filePath);
    await mkdir(dirname(fullPath), { recursive: true });

    const content = this.generateMarkdown(candidate);
    await writeFile(fullPath, content, "utf-8");
  }

  /** 根据记忆类型生成对应格式的 Markdown */
  private generateMarkdown(candidate: CandidateMemory): string {
    const timestamp = candidate.source?.timestamp ?? new Date().toISOString().split("T")[0];
    const sourceBlock = [
      "## 来源",
      "",
      `- 触发：${candidate.trigger}`,
      `- 时间：${timestamp}`,
      `- 置信度：${candidate.confidence}`,
    ].join("\n");

    const relatedBlock = ["## 关联记忆", "", "（暂无）"].join("\n");

    switch (candidate.type) {
      case "details":
        return [
          `# ${candidate.summary}`,
          "",
          "## 要点",
          "",
          candidate.detail,
          "",
          sourceBlock,
          "",
          relatedBlock,
          "",
        ].join("\n");

      case "cases":
        return [
          `# ${candidate.summary}`,
          "",
          "## 经过",
          "",
          candidate.detail,
          "",
          sourceBlock,
          "",
          relatedBlock,
          "",
        ].join("\n");

      case "principles":
        return [
          `# ${candidate.summary}`,
          "",
          "## 规范",
          "",
          candidate.detail,
          "",
          sourceBlock,
          "",
          relatedBlock,
          "",
        ].join("\n");
    }
  }

  // ─── 读取与解析 ────────────────────────────────

  /** 读取并解析记忆文件 */
  async readMemoryFile(filePath: string): Promise<MemoryContent | null> {
    try {
      const fullPath = join(this.memoryDir, filePath);
      const raw = await readFile(fullPath, "utf-8");
      return this.parseMarkdown(raw, filePath);
    } catch {
      return null;
    }
  }

  /** 读取记忆文件的原始文本 */
  async readRaw(filePath: string): Promise<string | null> {
    try {
      const fullPath = join(this.memoryDir, filePath);
      return await readFile(fullPath, "utf-8");
    } catch {
      return null;
    }
  }

  /** 解析 Markdown 为结构化数据 */
  private parseMarkdown(raw: string, filePath: string): MemoryContent {
    const lines = raw.split("\n");

    // 解析标题
    const titleLine = lines.find((l) => l.startsWith("# "));
    const title = titleLine?.replace(/^# /, "") ?? "";

    // 推断类型
    const type = this.inferType(filePath);

    // 解析各区块
    const body = this.extractSection(lines, ["要点", "经过", "规范"]);
    const source = this.extractSource(lines);
    const relatedMemories = this.extractRelatedMemories(lines);

    return { title, type, body, source, relatedMemories };
  }

  /** 从文件路径推断记忆类型 */
  private inferType(filePath: string): MemoryType {
    if (filePath.startsWith("details/")) return "details";
    if (filePath.startsWith("cases/")) return "cases";
    if (filePath.startsWith("principles/")) return "principles";
    return "details"; // 默认
  }

  /** 提取指定名称的区块内容 */
  private extractSection(lines: string[], sectionNames: string[]): string {
    let capturing = false;
    const result: string[] = [];

    for (const line of lines) {
      if (line.startsWith("## ")) {
        const name = line.replace(/^## /, "").trim();
        if (sectionNames.includes(name)) {
          capturing = true;
          continue;
        } else if (capturing) {
          break;
        }
      }
      if (capturing) {
        result.push(line);
      }
    }

    // 去掉首尾空行
    while (result.length > 0 && result[0].trim() === "") result.shift();
    while (result.length > 0 && result[result.length - 1].trim() === "") result.pop();

    return result.join("\n");
  }

  /** 提取来源信息 */
  private extractSource(lines: string[]): MemoryContent["source"] {
    const sourceText = this.extractSection(lines, ["来源"]);
    const trigger = sourceText.match(/触发：(\S+)/)?.[1] ?? "user_correction";
    const timestamp = sourceText.match(/时间：(\S+)/)?.[1] ?? new Date().toISOString().split("T")[0];
    const confidence = parseFloat(sourceText.match(/置信度：(\S+)/)?.[1] ?? "0.8");

    return {
      trigger: trigger as MemoryContent["source"]["trigger"],
      timestamp,
      confidence,
    };
  }

  /** 提取关联记忆链接 */
  private extractRelatedMemories(lines: string[]): RelatedMemory[] {
    const relatedText = this.extractSection(lines, ["关联记忆"]);
    if (!relatedText || relatedText === "（暂无）") return [];

    const results: RelatedMemory[] = [];
    const linkPattern = /\[([^\]]+)\]\(([^)]+)\)\s*[—-]\s*(.+)/;

    for (const line of relatedText.split("\n")) {
      const match = line.match(linkPattern);
      if (match) {
        results.push({
          filePath: match[2],
          reason: match[3].trim(),
        });
      }
    }

    return results;
  }

  // ─── 区块编辑 ──────────────────────────────────

  /** 向文件的指定区块追加内容 */
  async appendToSection(filePath: string, sectionName: string, content: string): Promise<void> {
    const raw = await this.readRaw(filePath);
    if (!raw) return;

    const lines = raw.split("\n");
    let insertIdx = -1;
    let inSection = false;

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith("## ")) {
        const name = lines[i].replace(/^## /, "").trim();
        if (name === sectionName) {
          inSection = true;
          continue;
        } else if (inSection) {
          // 找到下一个区块的开头，在前一行插入
          insertIdx = i;
          break;
        }
      }
    }

    // 如果区块在文件末尾
    if (inSection && insertIdx === -1) {
      insertIdx = lines.length;
    }

    if (insertIdx === -1) return; // 未找到区块

    // 替换 "（暂无）" 占位
    const prevLine = lines[insertIdx - 1]?.trim();
    if (prevLine === "（暂无）") {
      lines[insertIdx - 1] = content;
    } else {
      lines.splice(insertIdx, 0, content);
    }

    await writeFile(join(this.memoryDir, filePath), lines.join("\n"), "utf-8");
  }

  /** 替换文件的关联记忆区块 */
  async replaceRelatedSection(filePath: string, links: RelatedMemory[]): Promise<void> {
    const raw = await this.readRaw(filePath);
    if (!raw) return;

    const lines = raw.split("\n");
    let sectionStart = -1;
    let sectionEnd = lines.length;

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith("## 关联记忆")) {
        sectionStart = i + 1;
      } else if (sectionStart !== -1 && lines[i].startsWith("## ")) {
        sectionEnd = i;
        break;
      }
    }

    if (sectionStart === -1) return;

    const linkLines =
      links.length > 0
        ? ["", ...links.map((l) => `- [${l.reason}](${l.filePath}) — ${l.reason}`), ""]
        : ["", "（暂无）", ""];

    lines.splice(sectionStart, sectionEnd - sectionStart, ...linkLines);
    await writeFile(join(this.memoryDir, filePath), lines.join("\n"), "utf-8");
  }

  // ─── 元数据注册表 ─────────────────────────────

  /** 读取 registry.yaml */
  async loadRegistry(): Promise<MemoryRegistry> {
    try {
      const raw = await readFile(this.registryPath, "utf-8");
      return (yaml.load(raw) as MemoryRegistry) ?? this.emptyRegistry();
    } catch {
      return this.emptyRegistry();
    }
  }

  /** 写入 registry.yaml */
  async saveRegistry(registry: MemoryRegistry): Promise<void> {
    await mkdir(dirname(this.registryPath), { recursive: true });
    registry.lastUpdated = new Date().toISOString();
    await writeFile(this.registryPath, yaml.dump(registry, { lineWidth: 120 }), "utf-8");
  }

  /** 向注册表添加条目 */
  async addToRegistry(entry: MemoryEntry): Promise<void> {
    const registry = await this.loadRegistry();
    // 去重：相同 filePath 则更新
    const idx = registry.entries.findIndex((e) => e.filePath === entry.filePath);
    if (idx >= 0) {
      registry.entries[idx] = entry;
    } else {
      registry.entries.push(entry);
    }
    await this.saveRegistry(registry);
  }

  /** 按关键词搜索注册表 */
  async searchByKeywords(keywords: string[]): Promise<MemoryEntry[]> {
    const registry = await this.loadRegistry();
    const query = new Set(keywords.map((k) => k.toLowerCase()));

    return registry.entries.filter((entry) => {
      const entryKeywords = new Set(entry.keywords.map((k) => k.toLowerCase()));
      const overlap = [...query].filter((k) => entryKeywords.has(k));
      return overlap.length > 0;
    });
  }

  /** 获取记忆统计 */
  async getStats(): Promise<MemoryStats> {
    const registry = await this.loadRegistry();
    const byType: Record<MemoryType, number> = { details: 0, cases: 0, principles: 0 };
    for (const entry of registry.entries) {
      byType[entry.type]++;
    }
    return {
      total: registry.entries.length,
      byType,
      lastUpdated: registry.lastUpdated,
    };
  }

  // ─── 内部辅助 ──────────────────────────────────

  private get registryPath(): string {
    return join(this.memoryDir, ".meta", "registry.yaml");
  }

  private emptyRegistry(): MemoryRegistry {
    return { entries: [], lastUpdated: new Date().toISOString() };
  }

  /** 获取两个文件间的相对路径 */
  getRelativePath(from: string, to: string): string {
    const fromDir = dirname(join(this.memoryDir, from));
    const toFull = join(this.memoryDir, to);
    return relative(fromDir, toFull);
  }
}
