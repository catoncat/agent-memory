import { readFileSync, existsSync } from "node:fs";
import { basename, relative } from "node:path";
import { createHash } from "node:crypto";
import type { ChunkSource, MemoryChunk } from "./memory-db";

export interface ParsedChunk {
  source: ChunkSource;
  source_file: string;
  title: string;
  content: string;
  created_at: string;
  content_hash: string;
}

function hashContent(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

// ── Log 解析 ──────────────────────────────────
// 每个 `- YYYY-MM-DD HH:MM：xxx` 条目作为一个 chunk（含子条目）

function parseLogs(filePath: string, rootDir: string): ParsedChunk[] {
  if (!existsSync(filePath)) return [];
  const raw = readFileSync(filePath, "utf-8");
  const relPath = relative(rootDir, filePath);
  const entryChunks: ParsedChunk[] = [];

  const lines = raw.split("\n");
  let currentEntry: string[] = [];
  let currentTitle = "";
  let currentDate = "";

  const flushEntry = () => {
    if (currentEntry.length === 0) return;
    const content = currentEntry.join("\n").trim();
    if (!content) return;
    entryChunks.push({
      source: "log",
      source_file: relPath,
      title: currentTitle,
      content,
      created_at: currentDate || basename(filePath, ".md"),
      content_hash: hashContent(content),
    });
    currentEntry = [];
    currentTitle = "";
    currentDate = "";
  };

  for (const line of lines) {
    // 顶级日志条目：`- 2026-02-09 09:38：xxx`
    const topMatch = line.match(
      /^- (\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})[：:]\s*(.+)/,
    );
    if (topMatch) {
      flushEntry();
      currentDate = topMatch[1];
      currentTitle = topMatch[2];
      currentEntry.push(line);
      continue;
    }

    // 子条目（以 2+ 空格或 tab 开头的 `-`）
    if (/^[\t ]{2,}- /.test(line) && currentEntry.length > 0) {
      currentEntry.push(line);
      continue;
    }

    // 非日志行（frontmatter、标题等）跳过
  }

  flushEntry();

  // 兼容手写/运维报告型日志：有些收口记录只写成 `## 标题` + 普通 bullet，
  // 没有 `- YYYY-MM-DD HH:MM：标题` 的流水格式。旧 parser 会把这类内容完全跳过，
  // 导致刚写的日志 grep 能看到、recall 索引却是 0 chunk。
  const sectionChunks: ParsedChunk[] = [];
  let currentSectionTitle = "";
  let currentSectionLines: string[] = [];
  let fileDate = basename(filePath, ".md");
  const dateMatch = filePath.match(/(\d{4}-\d{2}-\d{2})/);
  if (dateMatch) fileDate = dateMatch[1];

  const flushSection = () => {
    if (!currentSectionTitle || currentSectionLines.length === 0) return;
    const content = currentSectionLines.join("\n").trim();
    if (!content || content.length < 10) return;

    // `## 当日流水` 里已有逐条 timestamp chunk，避免重复索引整段流水。
    if (/^- \d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}[：:]/m.test(content)) return;

    sectionChunks.push({
      source: "log",
      source_file: relPath,
      title: currentSectionTitle,
      content,
      created_at: fileDate,
      content_hash: hashContent(content),
    });
  };

  for (const line of lines) {
    if (line.startsWith("## ")) {
      flushSection();
      currentSectionTitle = line.replace(/^## /, "").trim();
      currentSectionLines = [line];
      continue;
    }

    if (currentSectionTitle) {
      currentSectionLines.push(line);
    }
  }
  flushSection();

  const seen = new Set(entryChunks.map((c) => c.content_hash));
  return [
    ...entryChunks,
    ...sectionChunks.filter((c) => {
      if (seen.has(c.content_hash)) return false;
      seen.add(c.content_hash);
      return true;
    }),
  ];
}

// ── Knowledge / MEMORY.md 解析 ──────────────────
// 按 `## ` 二级标题切分

function parseByHeadings(
  filePath: string,
  rootDir: string,
  source: ChunkSource,
): ParsedChunk[] {
  if (!existsSync(filePath)) return [];
  const raw = readFileSync(filePath, "utf-8");
  const relPath = relative(rootDir, filePath);
  const chunks: ParsedChunk[] = [];

  // 去掉 frontmatter
  const body = raw.replace(/^---[\s\S]*?---\n*/, "");
  const lines = body.split("\n");

  let currentTitle = "";
  let currentLines: string[] = [];
  let fileDate = basename(filePath, ".md");

  // 尝试从文件名提取日期，否则用文件名
  const dateMatch = filePath.match(/(\d{4}-\d{2}-\d{2})/);
  if (dateMatch) fileDate = dateMatch[1];

  const flushSection = () => {
    if (currentLines.length === 0) return;
    const content = currentLines.join("\n").trim();
    if (!content || content.length < 10) return; // 过短的跳过
    chunks.push({
      source,
      source_file: relPath,
      title: currentTitle || basename(filePath, ".md"),
      content,
      created_at: fileDate,
      content_hash: hashContent(content),
    });
    currentLines = [];
  };

  for (const line of lines) {
    if (line.startsWith("## ")) {
      flushSection();
      currentTitle = line.replace(/^## /, "").trim();
      currentLines.push(line);
      continue;
    }

    // 遇到 # 一级标题，不开新 chunk（它是文件标题）
    if (line.startsWith("# ") && !line.startsWith("## ")) {
      continue;
    }

    currentLines.push(line);
  }

  flushSection();
  return chunks;
}

// ── 统一入口 ──────────────────────────────────

export function parseFile(
  filePath: string,
  rootDir: string,
): ParsedChunk[] {
  const rel = relative(rootDir, filePath);

  if (rel.startsWith("10 Journal/Daily/")) {
    return parseLogs(filePath, rootDir);
  }

  if (rel.startsWith("20 Library/knowledge/")) {
    return parseByHeadings(filePath, rootDir, "knowledge");
  }

  if (rel === "MEMORY.md") {
    return parseByHeadings(filePath, rootDir, "memory");
  }

  return [];
}
