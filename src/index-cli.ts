#!/usr/bin/env bun

import { resolve } from "node:path";
import { globSync } from "node:fs";
import { parseFile } from "./lib/memory-parser";
import { getDb, closeDb, getExistingHashes, deleteByFile, deleteAll, insertChunks, getStats, rebuildQuantize } from "./lib/memory-db";
import { embed } from "./lib/ai-client";
import type { ParsedChunk } from "./lib/memory-parser";

const ROOT = resolve(import.meta.dir, "..");

function usage() {
  console.log(`用法:
  bun tools/mom-memory-index.ts              # 增量索引（自动检测变更）
  bun tools/mom-memory-index.ts --rebuild    # 全量重建
  bun tools/mom-memory-index.ts --file <path> # 索引指定文件
  bun tools/mom-memory-index.ts --stats      # 查看统计信息`);
}

function collectSourceFiles(): string[] {
  const files: string[] = [];

  // 10 Journal/Daily/*.md (daily logs)
  const logFiles = globSync("10 Journal/Daily/*.md", { cwd: ROOT });
  for (const f of logFiles) files.push(resolve(ROOT, f));

  // 20 Library/knowledge/*.md
  const knowledgeFiles = globSync("20 Library/knowledge/*.md", { cwd: ROOT });
  for (const f of knowledgeFiles) files.push(resolve(ROOT, f));

  // MEMORY.md
  const memoryFile = resolve(ROOT, "MEMORY.md");
  files.push(memoryFile);

  return files;
}

async function embedChunks(chunks: ParsedChunk[]): Promise<Array<ParsedChunk & { embedding: number[] }>> {
  if (chunks.length === 0) return [];

  const texts = chunks.map((c) => `${c.title}\n${c.content}`.slice(0, 2000));
  console.log(`  调用 Gemini Embedding API (${texts.length} 条)...`);

  const vectors = await embed(texts);

  return chunks.map((c, i) => ({ ...c, embedding: vectors[i] }));
}

async function embedAndInsertChunks(
  db: ReturnType<typeof getDb>,
  chunks: ParsedChunk[],
  onProgress?: (inserted: number) => void,
): Promise<number> {
  if (chunks.length === 0) return 0;

  const texts = chunks.map((c) => `${c.title}\n${c.content}`.slice(0, 2000));
  let inserted = 0;
  console.log(`  调用 Gemini Embedding API (${texts.length} 条)...`);

  await embed(texts, {
    onBatch: (batchStart, vectors) => {
      const batchChunks = chunks
        .slice(batchStart, batchStart + vectors.length)
        .map((chunk, i) => ({ ...chunk, embedding: vectors[i] }));
      insertChunks(db, batchChunks);
      inserted += batchChunks.length;
      onProgress?.(inserted);
      console.log(`  已落库 ${inserted}/${chunks.length} 条`);
    },
  });

  return inserted;
}

async function indexFiles(files: string[], rebuild: boolean) {
  const db = getDb();

  if (rebuild) {
    console.log("全量重建：清空数据库...");
    deleteAll(db);

    const allChunks: ParsedChunk[] = [];
    for (const file of files) {
      const chunks = parseFile(file, ROOT);
      if (chunks.length === 0) continue;
      const relPath = file.replace(ROOT + "/", "");
      console.log(`[${relPath}] ${chunks.length} 条新增, 0 条跳过`);
      allChunks.push(...chunks);
    }

    let inserted = 0;
    try {
      inserted = await embedAndInsertChunks(db, allChunks, (count) => {
        inserted = count;
      });
    } catch (error) {
      if (inserted > 0) {
        console.log("重建被中断，先为已落库部分重建量化索引...");
        rebuildQuantize(db);
      }
      const stats = getStats(db);
      console.log(`数据库: ${stats.total} 条记录, ${stats.withEmbedding} 条有向量`);
      closeDb();
      throw error;
    }

    console.log(`\n完成: ${inserted} 条索引, 0 条跳过`);

    if (inserted > 0) {
      console.log("重建量化索引...");
      rebuildQuantize(db);
    }

    const stats = getStats(db);
    console.log(`数据库: ${stats.total} 条记录, ${stats.withEmbedding} 条有向量`);
    if (Object.keys(stats.bySource).length > 0) {
      console.log("  分类:", Object.entries(stats.bySource).map(([k, v]) => `${k}=${v}`).join(", "));
    }

    closeDb();
    return;
  }

  const existingHashes = getExistingHashes(db);

  let totalNew = 0;
  let totalSkipped = 0;
  const chunksToIndex: ParsedChunk[] = [];

  for (const file of files) {
    const allChunks = parseFile(file, ROOT);
    if (allChunks.length === 0) continue;

    // 过滤出新增/变更的 chunks
    const newChunks = allChunks.filter((c) => !existingHashes.has(c.content_hash));
    const skipped = allChunks.length - newChunks.length;

    if (newChunks.length === 0) {
      totalSkipped += skipped;
      continue;
    }

    const relPath = file.replace(ROOT + "/", "");
    console.log(`[${relPath}] ${newChunks.length} 条新增, ${skipped} 条跳过`);

    chunksToIndex.push(...newChunks);
    totalNew += newChunks.length;
    totalSkipped += skipped;
  }

  if (chunksToIndex.length > 0) {
    try {
      await embedAndInsertChunks(db, chunksToIndex);
    } catch (error) {
      console.log("增量索引被中断，先为已落库部分重建量化索引...");
      rebuildQuantize(db);
      const stats = getStats(db);
      console.log(`数据库: ${stats.total} 条记录, ${stats.withEmbedding} 条有向量`);
      closeDb();
      throw error;
    }
  }

  console.log(`\n完成: ${totalNew} 条索引, ${totalSkipped} 条跳过`);

  // 重建量化索引（搜索依赖）
  if (totalNew > 0) {
    console.log("重建量化索引...");
    rebuildQuantize(db);
  }

  const stats = getStats(db);
  console.log(`数据库: ${stats.total} 条记录, ${stats.withEmbedding} 条有向量`);
  if (Object.keys(stats.bySource).length > 0) {
    console.log("  分类:", Object.entries(stats.bySource).map(([k, v]) => `${k}=${v}`).join(", "));
  }

  closeDb();
}

async function showStats() {
  const db = getDb();
  const stats = getStats(db);
  console.log(`数据库统计:`);
  console.log(`  总记录: ${stats.total}`);
  console.log(`  有向量: ${stats.withEmbedding}`);
  console.log(`  分类:`, stats.bySource);
  closeDb();
}

// ── Main ──────────────────────────────────

const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  usage();
  process.exit(0);
}

if (args.includes("--stats")) {
  await showStats();
  process.exit(0);
}

if (args.includes("--rebuild")) {
  const files = collectSourceFiles();
  console.log(`全量重建: ${files.length} 个源文件`);
  await indexFiles(files, true);
  process.exit(0);
}

const fileIdx = args.indexOf("--file");
if (fileIdx !== -1) {
  const filePath = args[fileIdx + 1];
  if (!filePath) {
    console.error("缺少文件路径");
    process.exit(1);
  }
  const absPath = resolve(filePath);
  console.log(`索引文件: ${absPath}`);
  await indexFiles([absPath], false);
  process.exit(0);
}

// 默认：增量索引
const files = collectSourceFiles();
console.log(`增量索引: 扫描 ${files.length} 个源文件...`);
await indexFiles(files, false);
