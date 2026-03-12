/**
 * 索引管理器 — MEMORY.md 的读写与分类归位
 * @author longfei5
 * @date 2026/3/11
 *
 * MEMORY.md 是记忆系统的人类可读索引，始终加载到模型上下文。
 * 结构：二级标题（领域）→ 三级标题（主题）→ 列表项（一句话摘要 + 链接）
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** 索引中的一个条目 */
export interface IndexEntry {
  summary: string;
  filePath: string; // 相对于 memory/ 的路径
}

/** 解析后的索引结构 */
export interface ParsedIndex {
  /** 二级标题 → 三级标题 → 条目列表 */
  sections: Map<string, Map<string, IndexEntry[]>>;
  /** 原始行数 */
  lineCount: number;
}

export class IndexManager {
  private readonly indexPath: string;

  constructor(memoryDir: string, indexFile = "MEMORY.md") {
    this.indexPath = join(memoryDir, indexFile);
  }

  // ─── 读取 ──────────────────────────────────────

  /** 读取 MEMORY.md 原始内容 */
  async readIndex(): Promise<string> {
    try {
      return await readFile(this.indexPath, "utf-8");
    } catch {
      return "";
    }
  }

  /** 解析 MEMORY.md 为结构化数据 */
  async parseIndex(): Promise<ParsedIndex> {
    const raw = await this.readIndex();
    return this.parse(raw);
  }

  private parse(raw: string): ParsedIndex {
    const lines = raw.split("\n");
    const sections = new Map<string, Map<string, IndexEntry[]>>();

    let currentH2 = "";
    let currentH3 = "";

    for (const line of lines) {
      if (line.startsWith("## ")) {
        currentH2 = line.replace(/^## /, "").trim();
        currentH3 = "";
        if (!sections.has(currentH2)) {
          sections.set(currentH2, new Map());
        }
      } else if (line.startsWith("### ")) {
        currentH3 = line.replace(/^### /, "").trim();
        if (currentH2) {
          const h2Section = sections.get(currentH2)!;
          if (!h2Section.has(currentH3)) {
            h2Section.set(currentH3, []);
          }
        }
      } else if (line.startsWith("- ") && currentH2) {
        const entry = this.parseLine(line);
        if (entry) {
          const h2Section = sections.get(currentH2)!;
          const key = currentH3 || "__root__";
          if (!h2Section.has(key)) {
            h2Section.set(key, []);
          }
          h2Section.get(key)!.push(entry);
        }
      }
    }

    return { sections, lineCount: lines.length };
  }

  /** 解析单行索引条目 */
  private parseLine(line: string): IndexEntry | null {
    // 格式：- 摘要内容 → [详情](path/to/file.md)
    const match = line.match(/^- (.+?)(?:\s*→\s*\[详情\]\(([^)]+)\))?$/);
    if (!match) return null;

    return {
      summary: match[1].trim(),
      filePath: match[2] ?? "",
    };
  }

  // ─── 写入 ──────────────────────────────────────

  /**
   * 向索引追加一条记忆
   *
   * 分类归位逻辑：
   * 1. keywords 与现有标题匹配 → 追加到该分类下
   * 2. 提供了 section/subsection → 精确定位
   * 3. 无匹配 → 追加到 "未分类" 区块
   */
  async appendEntry(params: {
    summary: string;
    filePath: string;
    section?: string; // 二级标题
    subsection?: string; // 三级标题
    keywords?: string[]; // 用于自动匹配分类
  }): Promise<void> {
    const raw = await this.readIndex();
    const entryLine = `- ${params.summary} → [详情](${params.filePath})`;

    // 确定目标分类
    const target = this.findTargetSection(raw, params);
    const updated = this.insertEntry(raw, entryLine, target);

    await writeFile(this.indexPath, updated, "utf-8");
  }

  /** 查找目标分类位置 */
  private findTargetSection(
    raw: string,
    params: { section?: string; subsection?: string; keywords?: string[] },
  ): { section: string; subsection?: string } {
    // 优先使用明确指定的分类
    if (params.section) {
      return { section: params.section, subsection: params.subsection };
    }

    // 尝试用 keywords 匹配已有标题
    if (params.keywords?.length) {
      const parsed = this.parse(raw);
      for (const [h2Name, h2Section] of parsed.sections) {
        // 匹配二级标题
        const h2Match = params.keywords.some(
          (kw) => h2Name.toLowerCase().includes(kw.toLowerCase()),
        );
        if (h2Match) {
          // 进一步匹配三级标题
          for (const h3Name of h2Section.keys()) {
            if (h3Name === "__root__") continue;
            const h3Match = params.keywords.some(
              (kw) => h3Name.toLowerCase().includes(kw.toLowerCase()),
            );
            if (h3Match) {
              return { section: h2Name, subsection: h3Name };
            }
          }
          return { section: h2Name };
        }
      }
    }

    // 无匹配，放到 "未分类"
    return { section: "未分类" };
  }

  /** 将条目插入到正确位置 */
  private insertEntry(
    raw: string,
    entryLine: string,
    target: { section: string; subsection?: string },
  ): string {
    const lines = raw.split("\n");

    // 查找目标区块位置
    let sectionIdx = -1;
    let subsectionIdx = -1;
    let insertIdx = -1;

    for (let i = 0; i < lines.length; i++) {
      if (lines[i] === `## ${target.section}`) {
        sectionIdx = i;
      } else if (sectionIdx >= 0 && target.subsection && lines[i] === `### ${target.subsection}`) {
        subsectionIdx = i;
      } else if (sectionIdx >= 0 && lines[i].startsWith("## ") && i > sectionIdx) {
        // 到达下一个二级标题，在此之前插入
        if (insertIdx === -1) insertIdx = i;
        break;
      }
    }

    // 计算插入位置
    if (subsectionIdx >= 0) {
      // 找到三级标题，在其条目末尾追加
      insertIdx = this.findSectionEnd(lines, subsectionIdx);
    } else if (sectionIdx >= 0 && target.subsection) {
      // 二级标题存在但三级不存在，创建新三级标题
      const sectionEnd = this.findSectionEnd(lines, sectionIdx);
      lines.splice(sectionEnd, 0, "", `### ${target.subsection}`);
      insertIdx = sectionEnd + 2;
    } else if (sectionIdx >= 0) {
      // 直接追加到二级标题下
      insertIdx = this.findSectionEnd(lines, sectionIdx);
    } else {
      // 创建新的二级标题
      // 确保文件末尾有空行
      if (lines.length > 0 && lines[lines.length - 1].trim() !== "") {
        lines.push("");
      }
      lines.push(`## ${target.section}`);
      if (target.subsection) {
        lines.push("");
        lines.push(`### ${target.subsection}`);
      }
      insertIdx = lines.length;
    }

    lines.splice(insertIdx, 0, entryLine);
    return lines.join("\n");
  }

  /** 找到一个标题区块的内容末尾行号（下一个同级或更高级标题之前） */
  private findSectionEnd(lines: string[], headerIdx: number): number {
    const headerLevel = lines[headerIdx].startsWith("## ") ? 2 : 3;

    for (let i = headerIdx + 1; i < lines.length; i++) {
      if (lines[i].startsWith("## ") && headerLevel <= 2) return i;
      if (lines[i].startsWith("### ") && headerLevel <= 3) return i;
      if (lines[i].startsWith("## ")) return i;
    }

    return lines.length;
  }

  // ─── 删除 ──────────────────────────────────────

  /** 从索引中删除指定文件的条目 */
  async removeEntry(filePath: string): Promise<void> {
    const raw = await this.readIndex();
    const lines = raw.split("\n");
    const filtered = lines.filter((line) => !line.includes(`(${filePath})`));
    await writeFile(this.indexPath, filtered.join("\n"), "utf-8");
  }
}
