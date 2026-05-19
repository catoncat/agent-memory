#!/usr/bin/env bun

import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { getDb, closeDb, searchSemantic, type ChunkSource, type SearchResult } from "./lib/memory-db";
import { embedQuery } from "./lib/ai-client";

const ROOT = resolve(import.meta.dir, "..");

function usage() {
  console.log(`用法:
  envchain mom bun tools/mom-recall.ts "搜索词"              # 语义搜索（默认）
  envchain mom bun tools/mom-recall.ts "搜索词" --source log # 限制来源 (log|knowledge|memory)
  envchain mom bun tools/mom-recall.ts "搜索词" --limit 3    # 限制结果数
  envchain mom bun tools/mom-recall.ts "搜索词" --json       # JSON 输出
  bun tools/mom-recall.ts "搜索词" --grep                    # 传统 grep；无结果时查 agent-memory 事件库`);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    query: "",
    source: undefined as ChunkSource | undefined,
    limit: 5,
    grep: false,
    json: false,
    help: false,
  };

  const positionals: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      opts.help = true;
    } else if (arg === "--grep") {
      opts.grep = true;
    } else if (arg === "--json") {
      opts.json = true;
    } else if (arg === "--source" && i + 1 < args.length) {
      opts.source = args[++i] as ChunkSource;
    } else if (arg === "--limit" && i + 1 < args.length) {
      opts.limit = parseInt(args[++i], 10);
    } else if (!arg.startsWith("-")) {
      positionals.push(arg);
    }
  }

  opts.query = positionals.join(" ");
  return opts;
}

type GrepResult = {
  mode: "grep" | "grep tokens";
  found: boolean;
  output: string;
};

type AgentMemoryRow = {
  ts: string;
  source: string;
  kind: string;
  title: string;
  summary?: string;
  cwd?: string;
  url?: string;
};

function runGrepFallback(query: string, source?: ChunkSource): GrepResult {
  const dirs: string[] = [];
  if (!source || source === "log") dirs.push("10 Journal/Daily/");
  if (!source || source === "knowledge") dirs.push("20 Library/knowledge/");
  if (!source || source === "memory") dirs.push("MEMORY.md");

  try {
    const result = execFileSync("rg", ["-n", "-i", "-F", "--", query, ...dirs], {
      cwd: ROOT,
      encoding: "utf-8",
      timeout: 5000,
    });
    return {
      mode: "grep",
      found: true,
      output: result.trim(),
    };
  } catch (e: unknown) {
    const err = e as { status?: number; stdout?: string };
    if (err.status === 1) {
      const tokens = tokenizeQuery(query);
      if (tokens.length > 1) {
        try {
          const firstToken = tokens.reduce((a, b) => (b.length > a.length ? b : a), tokens[0]);
          const result = execFileSync("rg", ["-n", "-i", "-F", "--", firstToken, ...dirs], {
            cwd: ROOT,
            encoding: "utf-8",
            timeout: 5000,
          });
          const lines = result
            .split("\n")
            .filter((line) => {
              const lower = line.toLowerCase();
              return tokens.every((token) => lower.includes(token));
            })
            .join("\n")
            .trim();
          if (lines) {
            return {
              mode: "grep tokens",
              found: true,
              output: lines,
            };
          }
        } catch {
          // fall through to "无结果"
        }
      }
      return {
        mode: "grep",
        found: false,
        output: "",
      };
    } else {
      throw e;
    }
  }
}

function printGrepFallback(query: string, source?: ChunkSource): boolean {
  const result = runGrepFallback(query, source);
  console.log(`搜索: "${query}" (${result.mode})\n`);
  console.log(result.found ? result.output : "无结果");
  return result.found;
}

function looksQuotaError(message: string): boolean {
  return /429|quota|rate[- ]?limit/i.test(message);
}

function shouldSearchAgentMemory(source?: ChunkSource): boolean {
  return !source || source === "log" || source === "memory";
}

function searchAgentMemory(query: string, limit: number): AgentMemoryRow[] {
  const script = resolve(ROOT, "tools/mom-agent-memory.ts");
  const raw = execFileSync(process.execPath, [script, "search", query, "--limit", String(limit)], {
    cwd: ROOT,
    encoding: "utf-8",
    timeout: 5000,
  });
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? (parsed as AgentMemoryRow[]) : [];
}

function printAgentMemoryFallback(query: string, source: ChunkSource | undefined, limit: number): AgentMemoryRow[] {
  if (!shouldSearchAgentMemory(source)) return [];
  let rows: AgentMemoryRow[] = [];
  try {
    rows = searchAgentMemory(query, limit);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`事件记忆 fallback 不可用：${msg}`);
    return [];
  }

  console.log(`\n事件记忆 fallback: "${query}"\n`);
  if (rows.length === 0) {
    console.log("无结果");
    return rows;
  }

  rows.forEach((row, idx) => {
    const preview = [row.summary, row.url, row.cwd].filter(Boolean).join(" | ").slice(0, 220);
    console.log(`${idx + 1}. [${row.source}/${row.kind}] ${row.title}`);
    console.log(`   ${row.ts}${preview ? `\n   ${preview}` : ""}`);
    if (idx < rows.length - 1) console.log();
  });
  return rows;
}

function searchAgentMemoryForSource(
  query: string,
  source: ChunkSource | undefined,
  limit: number,
): AgentMemoryRow[] {
  if (!shouldSearchAgentMemory(source)) return [];
  return searchAgentMemory(query, limit);
}

interface RankedResult extends SearchResult {
  rankScore: number;
  semanticSimilarity: number;
  lexicalScore: number;
}

function normalizeText(text: string): string {
  return text.toLowerCase().trim();
}

function tokenizeQuery(query: string): string[] {
  return Array.from(
    new Set(
      normalizeText(query)
        .split(/[\s/._:-]+/)
        .map((t) => t.trim())
        .filter((t) => t.length >= 2),
    ),
  );
}

function parseDateSafe(raw: string): Date | null {
  const value = raw.trim();
  if (!value) return null;
  // "2026-02-15 10:52" -> "2026-02-15T10:52:00"
  const isoLike = value.includes(" ")
    ? `${value.replace(" ", "T")}${value.length === 16 ? ":00" : ""}`
    : value;
  const date = new Date(isoLike);
  return Number.isNaN(date.getTime()) ? null : date;
}

function recencyBoost(createdAt: string): number {
  const date = parseDateSafe(createdAt);
  if (!date) return 0;
  const diffMs = Date.now() - date.getTime();
  if (diffMs < 0) return 0;
  const days = diffMs / (1000 * 60 * 60 * 24);
  if (days <= 1) return 1.2;
  if (days <= 7) return 0.8;
  if (days <= 30) return 0.4;
  return 0;
}

function lexicalBoost(r: SearchResult, query: string, tokens: string[]): number {
  const q = normalizeText(query);
  const title = normalizeText(r.title || "");
  const content = normalizeText(r.content || "");
  const sourceFile = normalizeText(r.source_file || "");

  let score = 0;

  if (title === q) score += 12;
  if (sourceFile === q) score += 11;
  if (title.includes(q)) score += 8;
  if (sourceFile.includes(q)) score += 7;
  if (content.includes(q)) score += 5;

  if (tokens.length > 0) {
    let hitCount = 0;
    for (const t of tokens) {
      if (title.includes(t) || sourceFile.includes(t) || content.includes(t)) {
        hitCount += 1;
      }
    }
    score += (hitCount / tokens.length) * 4;
  }

  // 含数字或版本尾缀（如 v2）时，提高精确匹配权重。
  if (/\d/.test(q) || /-v\d+\b/.test(q)) {
    if (title.includes(q) || sourceFile.includes(q)) score += 3;
  }

  return score;
}

function escapeLike(raw: string): string {
  return raw.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

function buildRankedResults(
  query: string,
  source: ChunkSource | undefined,
  semanticRows: SearchResult[],
  lexicalRows: SearchResult[],
  limit: number,
): RankedResult[] {
  const tokens = tokenizeQuery(query);
  const byKey = new Map<string, SearchResult>();

  const keyOf = (r: SearchResult) => `${r.id ?? "na"}|${r.source}|${r.source_file}|${r.content_hash}`;

  for (const row of semanticRows) {
    byKey.set(keyOf(row), row);
  }
  for (const row of lexicalRows) {
    const key = keyOf(row);
    if (!byKey.has(key)) byKey.set(key, row);
  }

  const ranked: RankedResult[] = [];
  for (const row of byKey.values()) {
    if (source && row.source !== source) continue;
    const semanticSimilarity = Math.max(0, Math.min(1, 1 - row.distance));
    const lexicalScore = lexicalBoost(row, query, tokens);
    const score = semanticSimilarity * 2 + lexicalScore + recencyBoost(row.created_at);
    ranked.push({
      ...row,
      rankScore: score,
      semanticSimilarity,
      lexicalScore,
    });
  }

  ranked.sort((a, b) => b.rankScore - a.rankScore);
  return ranked.slice(0, limit);
}

function formatResult(r: RankedResult, idx: number): string {
  const score = r.rankScore.toFixed(2);
  const sem = r.semanticSimilarity.toFixed(2);
  const sourceLabel = `[${r.source}]`;
  const preview = r.content.split("\n").slice(0, 3).join("\n   ").slice(0, 200);

  let location = r.source_file;
  if (r.source === "knowledge" && r.title) {
    location = `${r.source_file} > ${r.title}`;
  }

  return `${idx + 1}. ${sourceLabel} ${r.title || "(无标题)"} (match=${score}, sem=${sem})
   ${location}
   ${preview}`;
}

// ── Main ──────────────────────────────────

const opts = parseArgs();

if (opts.help || !opts.query) {
  usage();
  process.exit(opts.help ? 0 : 1);
}

if (opts.grep) {
  const found = printGrepFallback(opts.query, opts.source);
  if (!found) printAgentMemoryFallback(opts.query, opts.source, opts.limit);
  process.exit(0);
}

// 语义搜索
let queryVec: number[];
try {
  queryVec = await embedQuery(opts.query);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  if (looksQuotaError(msg)) {
    console.warn(
      "语义搜索暂时不可用：Gemini free tier quota/rate limit 已触发。可先用 --grep，或稍后再跑语义召回。",
    );
  } else {
    console.warn(`语义搜索不可用，自动回退 grep：${msg}`);
  }
  const grep = runGrepFallback(opts.query, opts.source);
  if (opts.json) {
    let eventRows: AgentMemoryRow[] = [];
    let eventMemoryError = "";
    try {
      eventRows = searchAgentMemoryForSource(opts.query, opts.source, opts.limit);
    } catch (eventErr) {
      eventMemoryError = eventErr instanceof Error ? eventErr.message : String(eventErr);
    }
    console.log(
      JSON.stringify(
        {
          mode: "fallback",
          reason: looksQuotaError(msg) ? "semantic_quota" : "semantic_error",
          grep,
          event_memory: eventRows,
          event_memory_error: eventMemoryError || undefined,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(`搜索: "${opts.query}" (${grep.mode})\n`);
    console.log(grep.found ? grep.output : "无结果");
    printAgentMemoryFallback(opts.query, opts.source, opts.limit);
  }
  process.exit(0);
}
const db = getDb();
const candidateLimit = Math.max(opts.limit * 8, 40);
const semanticRows = searchSemantic(db, queryVec, {
  limit: candidateLimit,
  source: opts.source,
});

const like = `%${escapeLike(normalizeText(opts.query))}%`;
const lexicalRows = db
  .query(
    `
      SELECT id, source, source_file, title, content, content_hash, created_at, 0.5 AS distance
      FROM memory_chunks
      WHERE (?1 IS NULL OR source = ?1)
        AND (
          lower(title) LIKE ?2 ESCAPE '\\'
          OR lower(content) LIKE ?2 ESCAPE '\\'
          OR lower(source_file) LIKE ?2 ESCAPE '\\'
        )
      ORDER BY created_at DESC
      LIMIT ?3
    `,
  )
  .all(opts.source ?? null, like, candidateLimit) as SearchResult[];

const results = buildRankedResults(
  opts.query,
  opts.source,
  semanticRows,
  lexicalRows,
  opts.limit,
);
closeDb();

if (opts.json) {
  const output = results.map((r) => ({
    source: r.source,
    source_file: r.source_file,
    title: r.title,
    content: r.content,
    distance: r.distance,
    similarity: parseFloat((1 - r.distance).toFixed(4)),
    rank_score: parseFloat(r.rankScore.toFixed(4)),
    lexical_score: parseFloat(r.lexicalScore.toFixed(4)),
    created_at: r.created_at,
  }));
  console.log(JSON.stringify(output, null, 2));
} else {
  console.log(`搜索: "${opts.query}" (语义)\n`);
  if (results.length === 0) {
    console.log("无结果。尝试本地事件记忆 fallback。");
    printAgentMemoryFallback(opts.query, opts.source, opts.limit);
  } else {
    for (let i = 0; i < results.length; i++) {
      console.log(formatResult(results[i], i));
      if (i < results.length - 1) console.log();
    }
  }
}
