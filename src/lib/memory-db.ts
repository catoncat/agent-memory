import { Database } from "bun:sqlite";
import { resolve, dirname } from "node:path";

// macOS 系统 SQLite 禁用了扩展加载，必须用 Homebrew 版本
Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");

const ROOT = resolve(dirname(import.meta.dir), "..");
const DB_PATH = resolve(ROOT, "tools/data/memory.db");
const VECTOR_EXT = resolve(ROOT, "tools/vendor/vector0");

const DIMENSION = 768;

export type ChunkSource = "log" | "knowledge" | "memory";

export interface MemoryChunk {
  id?: number;
  source: ChunkSource;
  source_file: string;
  title: string;
  content: string;
  content_hash: string;
  created_at: string;
}

export interface SearchResult extends MemoryChunk {
  distance: number;
}

let _db: Database | null = null;

export function getDb(): Database {
  if (_db) return _db;

  _db = new Database(DB_PATH);
  _db.loadExtension(VECTOR_EXT);

  // WAL 模式，适合读多写少
  _db.run("PRAGMA journal_mode=WAL");

  _db.run(`
    CREATE TABLE IF NOT EXISTS memory_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      source_file TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL,
      embedding BLOB,
      created_at TEXT NOT NULL,
      content_hash TEXT NOT NULL
    )
  `);

  _db.run("CREATE INDEX IF NOT EXISTS idx_chunks_source ON memory_chunks(source)");
  _db.run("CREATE INDEX IF NOT EXISTS idx_chunks_hash ON memory_chunks(content_hash)");
  _db.run(`
    DELETE FROM memory_chunks
    WHERE id NOT IN (
      SELECT MIN(id)
      FROM memory_chunks
      GROUP BY source_file, content_hash
    )
  `);
  _db.run(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_chunks_file_hash ON memory_chunks(source_file, content_hash)",
  );

  // 初始化向量列（幂等，重复调用安全）
  try {
    _db.run(
      `SELECT vector_init('memory_chunks', 'embedding', 'type=FLOAT32,dimension=${DIMENSION},distance=COSINE')`,
    );
  } catch {
    // 已经初始化过会报错，忽略
  }

  return _db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

/** float[] → BLOB for sqlite-vector */
export function vecToBlob(vec: number[]): Uint8Array {
  return new Uint8Array(new Float32Array(vec).buffer);
}

/** 查询已有的 content_hash 集合 */
export function getExistingHashes(db: Database): Set<string> {
  const rows = db.query("SELECT content_hash FROM memory_chunks").all() as Array<{
    content_hash: string;
  }>;
  return new Set(rows.map((r) => r.content_hash));
}

/** 按 source_file 删除所有 chunks（用于重建单个文件） */
export function deleteByFile(db: Database, sourceFile: string): void {
  db.run("DELETE FROM memory_chunks WHERE source_file = ?", [sourceFile]);
}

/** 清空全表（全量重建用） */
export function deleteAll(db: Database): void {
  db.run("DELETE FROM memory_chunks");
  // 清理量化表
  try {
    db.run("DROP TABLE IF EXISTS memory_chunks_embedding_quantized");
  } catch {
    // 忽略
  }
}

/** 批量插入 chunks（含 embedding） */
export function insertChunks(
  db: Database,
  chunks: Array<MemoryChunk & { embedding?: number[] }>,
): void {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO memory_chunks (source, source_file, title, content, embedding, created_at, content_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    for (const c of chunks) {
      stmt.run(
        c.source,
        c.source_file,
        c.title,
        c.content,
        c.embedding ? vecToBlob(c.embedding) : null,
        c.created_at,
        c.content_hash,
      );
    }
  });

  tx();
}

/** 重建量化索引（数据变更后必须调用） */
export function rebuildQuantize(db: Database): void {
  try {
    db.run(
      `SELECT vector_init('memory_chunks', 'embedding', 'type=FLOAT32,dimension=${DIMENSION},distance=COSINE')`,
    );
  } catch {
    // 已初始化
  }
  // 删除旧量化表再重建
  try {
    db.run("DROP TABLE IF EXISTS memory_chunks_embedding_quantized");
  } catch {
    // 忽略
  }
  db.run("SELECT vector_quantize('memory_chunks', 'embedding', 'quantization=1bit')");
}

/** 语义搜索：通过 vector_quantize_scan 1bit 量化扫描 */
export function searchSemantic(
  db: Database,
  queryVec: number[],
  opts: { limit?: number; source?: ChunkSource } = {},
): SearchResult[] {
  const limit = opts.limit ?? 5;
  const blob = vecToBlob(queryVec);

  // 确保 vector_init 已调用
  try {
    db.run(
      `SELECT vector_init('memory_chunks', 'embedding', 'type=FLOAT32,dimension=${DIMENSION},distance=COSINE')`,
    );
  } catch {
    // 已初始化
  }

  // 确保量化表存在
  const quantTableExists = db
    .query("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_chunks_embedding_quantized'")
    .get();
  if (!quantTableExists) {
    db.run("SELECT vector_quantize('memory_chunks', 'embedding', 'quantization=1bit')");
  }

  // preload 到内存
  try {
    db.run("SELECT vector_quantize_preload('memory_chunks', 'embedding')");
  } catch {
    // 忽略
  }

  // 搜索（先拿更多候选，再按 source 过滤）
  const scanLimit = opts.source ? limit * 3 : limit;

  const rows = db
    .query(
      `
    SELECT m.id, m.source, m.source_file, m.title, m.content, m.content_hash, m.created_at,
           v.distance
    FROM memory_chunks m
    JOIN vector_quantize_scan('memory_chunks', 'embedding', ?, ?) v
      ON m.id = v.rowid
  `,
    )
    .all(blob, scanLimit) as SearchResult[];

  if (opts.source) {
    return rows.filter((r) => r.source === opts.source).slice(0, limit);
  }

  return rows;
}

/** 统计信息 */
export function getStats(db: Database): { total: number; withEmbedding: number; bySource: Record<string, number> } {
  const total = (db.query("SELECT COUNT(*) as c FROM memory_chunks").get() as { c: number }).c;
  const withEmbedding = (
    db.query("SELECT COUNT(*) as c FROM memory_chunks WHERE embedding IS NOT NULL").get() as {
      c: number;
    }
  ).c;

  const bySourceRows = db
    .query("SELECT source, COUNT(*) as c FROM memory_chunks GROUP BY source")
    .all() as Array<{ source: string; c: number }>;

  const bySource: Record<string, number> = {};
  for (const r of bySourceRows) bySource[r.source] = r.c;

  return { total, withEmbedding, bySource };
}
