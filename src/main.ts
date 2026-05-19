#!/usr/bin/env bun

import { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import { embed, embedQuery } from "./lib/ai-client";

type EventInput = {
  ts: string;
  source: string;
  sourceId: string;
  kind: string;
  title: string;
  summary?: string;
  content?: string;
  url?: string;
  cwd?: string;
  app?: string;
  sensitivity?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
};

type CommandStats = Record<string, unknown>;

type EventSearchRow = {
  id?: number;
  ts: string;
  source: string;
  kind: string;
  title: string;
  summary: string;
  content?: string;
  cwd: string | null;
  url: string | null;
  rank?: number;
  semanticScore?: number;
  snippet?: string;
  matchMode: "fts" | "like" | "semantic" | "hybrid";
};

type ActiveFocusSnapshot = {
  ts: string;
  app: string;
  windowTitle: string;
  chromeTitle?: string;
  chromeUrl?: string;
};

type ObserverState = {
  focusKey: string;
  sourceId: string;
  firstSeenAt: string;
  lastSeenAt: string;
  observedCount: number;
};

const MEMORY_ROOT = process.env.AGENT_MEMORY_ROOT || path.join(homedir(), ".agents", "memory");
const DB_PATH = path.join(MEMORY_ROOT, "indexes", "events.sqlite");
const EVENT_DIR = path.join(MEMORY_ROOT, "events");
const DEFAULT_CODEX_ROOT = path.join(homedir(), ".codex", "sessions");
const X_BOOKMARK_DB = path.join(process.cwd(), "tools", "data", "opencli-twitter", "bookmarks.sqlite");
const LOCAL_EMBED_MODEL = "local-hash-v1";
const LOCAL_EMBED_DIMENSIONS = 384;

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\bAIza[0-9A-Za-z_-]{20,}\b/g, "[REDACTED_GOOGLE_API_KEY]"],
  [/\bsk-[0-9A-Za-z_-]{20,}\b/g, "[REDACTED_API_KEY]"],
  [/\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|password|secret|cookie)\s*[:=]\s*[^\s,}]+/gi, "$1=[REDACTED]"],
  [/(密码|管理密码|口令|passcode)\s*(?:是|都是|为|:|=)\s*[^\s,，。；;]+/gi, "$1=[REDACTED]"],
  [/Bearer\s+[0-9A-Za-z._~+/=-]{12,}/g, "Bearer [REDACTED]"],
];

const SENSITIVE_URL_PARAM =
  /^(access_token|id_token|refresh_token|auth|authorization|api[_-]?key|apikey|key|password|pass|secret|session|sessionid|sid|code|jwt|token)$/i;
const SECRET_SCAN_PATTERN =
  "\\bAIza[0-9A-Za-z_-]{20,}\\b|\\bsk-[0-9A-Za-z_-]{20,}\\b|Bearer\\s+[0-9A-Za-z._~+/=-]{12,}";

function usage(exitCode = 0): never {
  const text = `Usage:
  agent-memory init
  agent-memory stats
  agent-memory doctor [--json]
  agent-memory recent [--limit 10]
  agent-memory search "query" [--limit 10]
  agent-memory trail
  agent-memory context "query" [--limit 6] [--refresh] [--semantic] [--local]
  agent-memory observe [--json] [--timeout-ms 5000]
  agent-memory dream [--since-hours 24] [--limit 240] [--dry-run]
  agent-memory embed [--limit 25] [--force] [--wait] [--local]
  agent-memory capture --title "..." [--summary "..."] [--content "..."] [--tag tag] [--stdin]
  agent-memory closeout --title "..." [--summary "..."] [--content "..."] [--status success] [--stdin]
  agent-memory add --source manual --kind note --title "..." --content "..."
  agent-memory refresh [--since-hours 24] [--limit-files 40] [--x-limit 100] [--tab-limit 100]
  agent-memory ingest-codex [--since-hours 72] [--limit-files 80]
  agent-memory ingest-x-bookmarks [--limit 200]
  agent-memory ingest-chrome-tabs [--limit 200] [--timeout-ms 5000]
  agent-memory rebuild

Storage:
  ${DB_PATH}
  ${EVENT_DIR}/YYYY-MM-DD.jsonl
`;
  (exitCode === 0 ? console.log : console.error)(text);
  process.exit(exitCode);
}

function argValue(args: string[], name: string, fallback = ""): string {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] || fallback : fallback;
}

function argNumber(args: string[], name: string, fallback: number): number {
  const raw = argValue(args, name, "");
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function sanitize(raw: unknown, maxLength = 6000): string {
  let text = String(raw ?? "");
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    text = text.replace(pattern, replacement);
  }
  text = text.replace(/\s+$/g, "");
  return text.length > maxLength ? `${text.slice(0, maxLength)}... [truncated]` : text;
}

function compactLine(raw: unknown, maxLength = 240): string {
  return sanitize(raw, maxLength).replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function sanitizeUrl(raw: unknown, maxLength = 1000): string {
  const text = sanitize(raw, maxLength).trim();
  if (!text) return "";
  try {
    const url = new URL(text);
    for (const [key, value] of Array.from(url.searchParams.entries())) {
      if (SENSITIVE_URL_PARAM.test(key) || /^[0-9A-Za-z._~+/=-]{48,}$/.test(value)) {
        url.searchParams.set(key, "[REDACTED]");
      }
    }
    return sanitize(url.toString(), maxLength);
  } catch {
    return text;
  }
}

function normalizeTimestamp(raw: string): string {
  const value = String(raw || "").trim();
  const parsed = value ? new Date(value) : new Date();
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  return new Date().toISOString();
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function ensureDirs() {
  mkdirSync(path.dirname(DB_PATH), { recursive: true });
  mkdirSync(EVENT_DIR, { recursive: true });
}

function openDb(): Database {
  ensureDirs();
  const db = new Database(DB_PATH);
  db.run("PRAGMA busy_timeout=5000");
  db.run("PRAGMA journal_mode=WAL");
  db.run("PRAGMA synchronous=NORMAL");
  db.run(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      source TEXT NOT NULL,
      source_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL DEFAULT '',
      url TEXT,
      cwd TEXT,
      app TEXT,
      sensitivity TEXT NOT NULL DEFAULT 'private',
      tags_json TEXT NOT NULL DEFAULT '[]',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      content_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(source, source_id)
    )
  `);
  db.run("CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts)");
  db.run("CREATE INDEX IF NOT EXISTS idx_events_source ON events(source, kind)");
  db.run("CREATE INDEX IF NOT EXISTS idx_events_cwd ON events(cwd)");
  ensureTrailSchema(db);
  db.run(`
    CREATE TABLE IF NOT EXISTS event_embeddings (
      event_id INTEGER NOT NULL,
      model TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      vector_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(event_id, model),
      FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE
    )
  `);
  ensureEventEmbeddingSchema(db);
  db.run("CREATE INDEX IF NOT EXISTS idx_event_embeddings_model ON event_embeddings(model)");
  db.run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
      title,
      summary,
      content,
      url,
      cwd,
      source,
      kind,
      tags,
      tokenize='unicode61'
    )
  `);
  backfillFtsIfNeeded(db);
  return db;
}

function ensureTrailSchema(db: Database) {
  db.run(`
    CREATE TABLE IF NOT EXISTS raw_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      source TEXT NOT NULL,
      source_id TEXT NOT NULL,
      action TEXT NOT NULL,
      app TEXT,
      window_title TEXT,
      title TEXT NOT NULL DEFAULT '',
      url TEXT,
      payload_json TEXT NOT NULL DEFAULT '{}',
      payload_hash TEXT NOT NULL,
      artifact_ids_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(source, source_id)
    )
  `);
  db.run("CREATE INDEX IF NOT EXISTS idx_raw_events_ts ON raw_events(ts)");
  db.run("CREATE INDEX IF NOT EXISTS idx_raw_events_source_action ON raw_events(source, action)");
  db.run(`
    CREATE TABLE IF NOT EXISTS artifacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      kind TEXT NOT NULL,
      path TEXT,
      content_hash TEXT NOT NULL,
      mime TEXT,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      ttl_until TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  db.run("CREATE INDEX IF NOT EXISTS idx_artifacts_ttl ON artifacts(ttl_until)");
  db.run(`
    CREATE TABLE IF NOT EXISTS signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      raw_event_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      value REAL NOT NULL DEFAULT 0,
      score REAL NOT NULL DEFAULT 0,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL,
      UNIQUE(raw_event_id, name),
      FOREIGN KEY(raw_event_id) REFERENCES raw_events(id) ON DELETE CASCADE
    )
  `);
  db.run("CREATE INDEX IF NOT EXISTS idx_signals_name_score ON signals(name, score)");
  db.run(`
    CREATE TABLE IF NOT EXISTS episodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id TEXT NOT NULL UNIQUE,
      start_ts TEXT NOT NULL,
      end_ts TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      score REAL NOT NULL DEFAULT 0,
      evidence_json TEXT NOT NULL DEFAULT '[]',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0,
      evidence_json TEXT NOT NULL DEFAULT '[]',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS observer_state (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
}

function ensureEventEmbeddingSchema(db: Database) {
  const columns = db.query("PRAGMA table_info(event_embeddings)").all() as Array<{
    name: string;
    pk: number;
  }>;
  const eventIdPk = columns.find((column) => column.name === "event_id")?.pk || 0;
  const modelPk = columns.find((column) => column.name === "model")?.pk || 0;
  if (eventIdPk > 0 && modelPk > 0) return;

  db.run("DROP INDEX IF EXISTS idx_event_embeddings_model");
  const tx = db.transaction(() => {
    db.run("ALTER TABLE event_embeddings RENAME TO event_embeddings_legacy");
    db.run(`
      CREATE TABLE event_embeddings (
        event_id INTEGER NOT NULL,
        model TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        dimensions INTEGER NOT NULL,
        vector_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(event_id, model),
        FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE
      )
    `);
    db.run(`
      INSERT OR REPLACE INTO event_embeddings (
        event_id, model, content_hash, dimensions, vector_json, updated_at
      )
      SELECT event_id, model, content_hash, dimensions, vector_json, updated_at
      FROM event_embeddings_legacy
      WHERE event_id IS NOT NULL AND model IS NOT NULL
    `);
    db.run("DROP TABLE event_embeddings_legacy");
  });
  tx();
}

function syncEventFts(
  db: Database,
  rowid: number,
  event: {
    title: string;
    summary?: string;
    content?: string;
    url?: string;
    cwd?: string;
    source: string;
    kind: string;
    tags?: string[];
  },
) {
  db.run("DELETE FROM events_fts WHERE rowid = ?", [rowid]);
  db.run(
    `
    INSERT INTO events_fts (rowid, title, summary, content, url, cwd, source, kind, tags)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    [
      rowid,
      event.title || "",
      event.summary || "",
      event.content || "",
      event.url || "",
      event.cwd || "",
      event.source || "",
      event.kind || "",
      (event.tags || []).join(" "),
    ],
  );
}

function rebuildFts(db: Database): number {
  db.run("DELETE FROM events_fts");
  const rows = db
    .query(
      `
      SELECT id, source, kind, title, summary, content, url, cwd, tags_json
      FROM events
      ORDER BY id
    `,
    )
    .all() as Array<{
    id: number;
    source: string;
    kind: string;
    title: string;
    summary: string;
    content: string;
    url: string | null;
    cwd: string | null;
    tags_json: string;
  }>;
  for (const row of rows) {
    let tags: string[] = [];
    try {
      tags = JSON.parse(row.tags_json);
    } catch {
      tags = [];
    }
    syncEventFts(db, row.id, {
      source: row.source,
      kind: row.kind,
      title: row.title,
      summary: row.summary,
      content: row.content,
      url: row.url || "",
      cwd: row.cwd || "",
      tags,
    });
  }
  return rows.length;
}

function backfillFtsIfNeeded(db: Database) {
  const eventCount = db.query("SELECT COUNT(*) AS c FROM events").get() as { c: number };
  const ftsCount = db.query("SELECT COUNT(*) AS c FROM events_fts").get() as { c: number };
  if (eventCount.c !== ftsCount.c) {
    try {
      rebuildFts(db);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/SQLITE_BUSY|database is locked/i.test(message)) return;
      throw err;
    }
  }
}

function normalizeEvent(input: EventInput): EventInput & { contentHash: string } {
  const event = {
    ...input,
    ts: normalizeTimestamp(input.ts),
    title: compactLine(input.title, 240) || "(untitled)",
    summary: sanitize(input.summary || "", 1000),
    content: sanitize(input.content || "", 6000),
    url: input.url ? sanitizeUrl(input.url, 1000) : undefined,
    cwd: input.cwd ? sanitize(input.cwd, 1000) : undefined,
    app: input.app ? sanitize(input.app, 120) : undefined,
    sensitivity: input.sensitivity || "private",
    tags: Array.from(new Set(input.tags || [])).sort(),
    metadata: input.metadata || {},
  };
  const contentHash = sha256(
    JSON.stringify({
      ts: event.ts,
      source: event.source,
      sourceId: event.sourceId,
      kind: event.kind,
      title: event.title,
      summary: event.summary,
      content: event.content,
      url: event.url,
      cwd: event.cwd,
      app: event.app,
      sensitivity: event.sensitivity,
      tags: event.tags,
      metadata: event.metadata,
    }),
  );
  return { ...event, contentHash };
}

async function appendJsonl(event: ReturnType<typeof normalizeEvent>, action: "insert" | "update") {
  const day = event.ts.slice(0, 10);
  const file = path.join(EVENT_DIR, `${day}.jsonl`);
  const row = {
    action,
    ts: new Date().toISOString(),
    event,
  };
  await appendFile(file, `${JSON.stringify(row)}\n`, "utf8");
}

async function upsertEvent(db: Database, input: EventInput, mirror = true): Promise<"insert" | "update" | "skip"> {
  const event = normalizeEvent(input);
  const now = new Date().toISOString();
  const existing = db
    .query("SELECT id, content_hash FROM events WHERE source = ? AND source_id = ?")
    .get(event.source, event.sourceId) as { id: number; content_hash: string } | null;

  if (existing?.content_hash === event.contentHash) return "skip";

  const tagsJson = JSON.stringify(event.tags);
  const metadataJson = JSON.stringify(event.metadata);
  if (existing) {
    db.run(
      `
      UPDATE events
      SET ts = ?, kind = ?, title = ?, summary = ?, content = ?, url = ?, cwd = ?, app = ?,
          sensitivity = ?, tags_json = ?, metadata_json = ?, content_hash = ?, updated_at = ?
      WHERE id = ?
    `,
      [
        event.ts,
        event.kind,
        event.title,
        event.summary,
        event.content,
        event.url || null,
        event.cwd || null,
        event.app || null,
        event.sensitivity,
        tagsJson,
        metadataJson,
        event.contentHash,
        now,
        existing.id,
      ],
    );
    db.run("DELETE FROM event_embeddings WHERE event_id = ?", [existing.id]);
    syncEventFts(db, existing.id, event);
    if (mirror) await appendJsonl(event, "update");
    return "update";
  }

  db.run(
    `
    INSERT INTO events (
      ts, source, source_id, kind, title, summary, content, url, cwd, app, sensitivity,
      tags_json, metadata_json, content_hash, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    [
      event.ts,
      event.source,
      event.sourceId,
      event.kind,
      event.title,
      event.summary,
      event.content,
      event.url || null,
      event.cwd || null,
      event.app || null,
      event.sensitivity,
      tagsJson,
      metadataJson,
      event.contentHash,
      now,
      now,
    ],
  );
  const inserted = db
    .query("SELECT id FROM events WHERE source = ? AND source_id = ?")
    .get(event.source, event.sourceId) as { id: number } | null;
  if (inserted) syncEventFts(db, inserted.id, event);
  if (mirror) await appendJsonl(event, "insert");
  return "insert";
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (typeof record.text === "string") parts.push(record.text);
    if (typeof record.output_text === "string") parts.push(record.output_text);
  }
  return parts.join("\n");
}

function isCodexContextNoise(text: string): boolean {
  const trimmed = text.trim();
  return (
    trimmed.startsWith("# AGENTS.md instructions") ||
    trimmed.startsWith("<goal_context>") ||
    trimmed.startsWith("<environment_context>") ||
    trimmed.startsWith("<developer_context>") ||
    trimmed.includes("Current date:") && trimmed.includes("You are Codex")
  );
}

type CodexDigest = {
  sessionId: string;
  ts: string;
  cwd?: string;
  model?: string;
  title: string;
  content: string;
  messageCount: number;
  userCount: number;
  assistantCount: number;
};

type ChromeTabSnapshot = {
  windowIndex: number;
  tabIndex: number;
  active: boolean;
  title: string;
  url: string;
};

async function digestCodexSession(file: string): Promise<CodexDigest | null> {
  let sessionId = path.basename(file).replace(/^rollout-/, "").replace(/\.jsonl$/, "");
  let ts = statSync(file).mtime.toISOString();
  let cwd = "";
  let model = "";
  const snippets: string[] = [];
  let userCount = 0;
  let assistantCount = 0;

  const rl = readline.createInterface({
    input: createReadStream(file, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }

    if (row.type === "session_meta") {
      const payload = row.payload as Record<string, unknown> | undefined;
      if (payload?.id) sessionId = String(payload.id);
      if (payload?.timestamp) ts = String(payload.timestamp);
      if (payload?.cwd) cwd = String(payload.cwd);
      if (payload?.model) model = String(payload.model);
      continue;
    }

    if (row.type !== "response_item") continue;
    const payload = row.payload as Record<string, unknown> | undefined;
    if (!payload || payload.type !== "message") continue;
    const role = String(payload.role || "");
    if (role !== "user" && role !== "assistant") continue;

    const text = sanitize(extractTextFromContent(payload.content), 900);
    if (!text.trim()) continue;
    if (isCodexContextNoise(text)) continue;
    if (role === "user") userCount += 1;
    if (role === "assistant") assistantCount += 1;
    if (snippets.length < 8) {
      snippets.push(`${role}: ${text.trim().split("\n").slice(0, 6).join("\n")}`);
    }
  }

  if (snippets.length === 0) return null;
  const firstUser = snippets.find((line) => line.startsWith("user:")) || snippets[0];
  return {
    sessionId,
    ts: normalizeTimestamp(ts),
    cwd,
    model,
    title: compactLine(firstUser.replace(/^user:\s*/, ""), 180),
    content: snippets.join("\n\n"),
    messageCount: userCount + assistantCount,
    userCount,
    assistantCount,
  };
}

function listRecentFiles(root: string, sinceHours: number, limitFiles: number): string[] {
  if (!existsSync(root)) return [];
  const cutoff = Date.now() - sinceHours * 60 * 60 * 1000;
  const files: Array<{ file: string; mtime: number }> = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(file);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const stat = statSync(file);
      if (stat.mtimeMs >= cutoff) files.push({ file, mtime: stat.mtimeMs });
    }
  }
  return files
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limitFiles)
    .map((item) => item.file);
}

async function ingestCodex(args: string[], print = true): Promise<CommandStats> {
  const sinceHours = argNumber(args, "--since-hours", 72);
  const limitFiles = argNumber(args, "--limit-files", 80);
  const root = argValue(args, "--root", DEFAULT_CODEX_ROOT);
  const db = openDb();
  const files = listRecentFiles(root, sinceHours, limitFiles);
  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  for (const file of files) {
    const digest = await digestCodexSession(file);
    if (!digest) continue;
    const result = await upsertEvent(db, {
      ts: digest.ts,
      source: "codex",
      sourceId: digest.sessionId,
      kind: "conversation",
      title: digest.title,
      summary: `${digest.userCount} user messages, ${digest.assistantCount} assistant messages`,
      content: digest.content,
      cwd: digest.cwd,
      app: "Codex",
      sensitivity: "private",
      tags: ["codex", "conversation"],
      metadata: {
        file,
        model: digest.model,
        messageCount: digest.messageCount,
      },
    });
    if (result === "insert") inserted += 1;
    else if (result === "update") updated += 1;
    else skipped += 1;
  }

  db.close();
  const output = { source: "codex", scanned: files.length, inserted, updated, skipped };
  if (print) console.log(JSON.stringify(output, null, 2));
  return output;
}

async function ingestXBookmarks(args: string[], print = true): Promise<CommandStats> {
  const limit = argNumber(args, "--limit", 200);
  const dbPath = argValue(args, "--db", X_BOOKMARK_DB);
  if (!existsSync(dbPath)) {
    const output = { source: "x-bookmarks", scanned: 0, inserted: 0, updated: 0, skipped: 0, reason: "db_not_found" };
    if (print) console.log(JSON.stringify(output, null, 2));
    return output;
  }

  const sourceDb = new Database(dbPath, { readonly: true });
  const rows = sourceDb
    .query(
      `
      SELECT id, url, author, name, text, likes, retweets, bookmarks, created_at, first_seen_at, last_seen_at, has_media
      FROM x_bookmark_items
      ORDER BY COALESCE(last_seen_at, first_seen_at, created_at) DESC
      LIMIT ?
    `,
    )
    .all(limit) as Array<Record<string, unknown>>;
  sourceDb.close();

  const db = openDb();
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  for (const row of rows) {
    const author = String(row.author || row.name || "unknown");
    const title = compactLine(`${author}: ${String(row.text || row.url || "")}`, 180);
    const safeUrl = sanitizeUrl(row.url || "");
    const result = await upsertEvent(db, {
      ts: String(row.created_at || row.first_seen_at || new Date().toISOString()),
      source: "x-bookmarks",
      sourceId: String(row.id),
      kind: "browser_bookmark",
      title,
      summary: String(row.text || ""),
      content: String(row.text || ""),
      url: safeUrl,
      app: "Chrome/X",
      sensitivity: "private",
      tags: ["browser", "x", "bookmark"],
      metadata: {
        author,
        likes: row.likes,
        retweets: row.retweets,
        bookmarks: row.bookmarks,
        hasMedia: Boolean(row.has_media),
        firstSeenAt: row.first_seen_at,
        lastSeenAt: row.last_seen_at,
      },
    });
    if (result === "insert") inserted += 1;
    else if (result === "update") updated += 1;
    else skipped += 1;
  }
  db.close();
  const output = { source: "x-bookmarks", scanned: rows.length, inserted, updated, skipped };
  if (print) console.log(JSON.stringify(output, null, 2));
  return output;
}

function readChromeTabs(timeoutMs: number): { running: boolean; tabs: ChromeTabSnapshot[] } {
  const script = String.raw`
const chrome = Application("Google Chrome");
if (!chrome.running()) {
  JSON.stringify({ running: false, tabs: [] });
} else {
  const windows = chrome.windows();
  const tabs = [];
  for (let wi = 0; wi < windows.length; wi += 1) {
    const win = windows[wi];
    let activeTabIndex = -1;
    try {
      activeTabIndex = Number(win.activeTabIndex());
    } catch (_) {}
    const winTabs = win.tabs();
    for (let ti = 0; ti < winTabs.length; ti += 1) {
      const tab = winTabs[ti];
      tabs.push({
        windowIndex: wi + 1,
        tabIndex: ti + 1,
        active: activeTabIndex === ti + 1,
        title: String(tab.title() || ""),
        url: String(tab.url() || "")
      });
    }
  }
  JSON.stringify({ running: true, tabs });
}
`;
  const raw = execFileSync("osascript", ["-l", "JavaScript", "-e", script], {
    encoding: "utf8",
    timeout: timeoutMs,
  }).trim();
  const parsed = JSON.parse(raw) as { running?: boolean; tabs?: ChromeTabSnapshot[] };
  return {
    running: Boolean(parsed.running),
    tabs: Array.isArray(parsed.tabs) ? parsed.tabs : [],
  };
}

function readActiveFocus(timeoutMs: number): ActiveFocusSnapshot {
  const script = String.raw`
const systemEvents = Application("System Events");
let app = "";
let windowTitle = "";
try {
  const processes = systemEvents.processes.whose({ frontmost: true })();
  if (processes.length > 0) {
    const process = processes[0];
    app = String(process.name() || "");
    try {
      const windows = process.windows();
      if (windows.length > 0) windowTitle = String(windows[0].name() || "");
    } catch (_) {}
  }
} catch (_) {}
JSON.stringify({ app, windowTitle });
`;
  const raw = execFileSync("osascript", ["-l", "JavaScript", "-e", script], {
    encoding: "utf8",
    timeout: timeoutMs,
  }).trim();
  const parsed = JSON.parse(raw) as { app?: string; windowTitle?: string };
  let chromeTitle = "";
  let chromeUrl = "";
  if (parsed.app === "Google Chrome") {
    try {
      const snapshot = readChromeTabs(Math.min(timeoutMs, 4000));
      const active = snapshot.tabs.find((tab) => tab.active) || snapshot.tabs[0];
      chromeTitle = active?.title || "";
      chromeUrl = active?.url || "";
    } catch {
      chromeTitle = "";
      chromeUrl = "";
    }
  }
  return {
    ts: new Date().toISOString(),
    app: compactLine(parsed.app || "Unknown", 120),
    windowTitle: compactLine(parsed.windowTitle || "", 240),
    chromeTitle: compactLine(chromeTitle, 240),
    chromeUrl: sanitizeUrl(chromeUrl) || undefined,
  };
}

function observerFocusKey(snapshot: ActiveFocusSnapshot): string {
  return sha256(
    JSON.stringify({
      app: snapshot.app,
      windowTitle: snapshot.windowTitle,
      chromeTitle: snapshot.chromeTitle || "",
      chromeUrl: snapshot.chromeUrl || "",
    }),
  ).slice(0, 24);
}

function readObserverState(db: Database, key: string): ObserverState | null {
  const row = db.query("SELECT value_json FROM observer_state WHERE key = ?").get(key) as { value_json: string } | null;
  if (!row) return null;
  try {
    return JSON.parse(row.value_json) as ObserverState;
  } catch {
    return null;
  }
}

function writeObserverState(db: Database, key: string, value: ObserverState) {
  db.run(
    `
    INSERT INTO observer_state (key, value_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
  `,
    [key, JSON.stringify(value), new Date().toISOString()],
  );
}

function upsertRawEvent(
  db: Database,
  input: {
    ts: string;
    source: string;
    sourceId: string;
    action: string;
    app?: string;
    windowTitle?: string;
    title?: string;
    url?: string;
    payload: Record<string, unknown>;
    artifactIds?: number[];
  },
): { id: number; result: "insert" | "update" | "skip" } {
  const payloadJson = JSON.stringify(input.payload || {});
  const artifactIdsJson = JSON.stringify(input.artifactIds || []);
  const payloadHash = sha256(
    JSON.stringify({
      action: input.action,
      app: input.app || "",
      windowTitle: input.windowTitle || "",
      title: input.title || "",
      url: input.url || "",
      payload: input.payload || {},
      artifactIds: input.artifactIds || [],
    }),
  );
  const now = new Date().toISOString();
  const existing = db
    .query("SELECT id, payload_hash FROM raw_events WHERE source = ? AND source_id = ?")
    .get(input.source, input.sourceId) as { id: number; payload_hash: string } | null;
  if (existing?.payload_hash === payloadHash) return { id: existing.id, result: "skip" };
  if (existing) {
    db.run(
      `
      UPDATE raw_events
      SET ts = ?, action = ?, app = ?, window_title = ?, title = ?, url = ?,
          payload_json = ?, payload_hash = ?, artifact_ids_json = ?, updated_at = ?
      WHERE id = ?
    `,
      [
        input.ts,
        input.action,
        input.app || null,
        input.windowTitle || null,
        input.title || "",
        input.url || null,
        payloadJson,
        payloadHash,
        artifactIdsJson,
        now,
        existing.id,
      ],
    );
    return { id: existing.id, result: "update" };
  }
  db.run(
    `
    INSERT INTO raw_events (
      ts, source, source_id, action, app, window_title, title, url,
      payload_json, payload_hash, artifact_ids_json, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    [
      input.ts,
      input.source,
      input.sourceId,
      input.action,
      input.app || null,
      input.windowTitle || null,
      input.title || "",
      input.url || null,
      payloadJson,
      payloadHash,
      artifactIdsJson,
      now,
      now,
    ],
  );
  const inserted = db
    .query("SELECT id FROM raw_events WHERE source = ? AND source_id = ?")
    .get(input.source, input.sourceId) as { id: number } | null;
  if (!inserted) throw new Error("failed to read inserted raw event");
  return { id: inserted.id, result: "insert" };
}

function upsertSignal(
  db: Database,
  rawEventId: number,
  name: string,
  value: number,
  score: number,
  metadata: Record<string, unknown> = {},
) {
  db.run(
    `
    INSERT INTO signals (raw_event_id, name, value, score, metadata_json, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(raw_event_id, name) DO UPDATE SET
      value = excluded.value,
      score = excluded.score,
      metadata_json = excluded.metadata_json,
      updated_at = excluded.updated_at
  `,
    [rawEventId, name, value, score, JSON.stringify(metadata), new Date().toISOString()],
  );
}

function computeTrailScore(snapshot: ActiveFocusSnapshot, dwellMs: number, observedCount: number): number {
  let score = 1;
  if (snapshot.app === "Google Chrome") score += 1;
  if (snapshot.chromeUrl) score += 1;
  if (snapshot.windowTitle || snapshot.chromeTitle) score += 0.5;
  score += Math.min(8, dwellMs / 60_000);
  score += Math.min(3, observedCount / 5);
  return Number(score.toFixed(3));
}

async function observe(args: string[]) {
  const jsonOutput = hasFlag(args, "--json");
  const timeoutMs = argNumber(args, "--timeout-ms", 5000);
  const snapshot = readActiveFocus(timeoutMs);
  const focusKey = observerFocusKey(snapshot);
  const db = openDb();
  const previous = readObserverState(db, "active_focus");
  const nowMs = new Date(snapshot.ts).getTime();
  const continuing = previous?.focusKey === focusKey;
  const sourceId = continuing
    ? previous.sourceId
    : `focus:${snapshot.ts.slice(0, 10)}:${focusKey}:${nowMs.toString(36)}`;
  const firstSeenAt = continuing ? previous.firstSeenAt : snapshot.ts;
  const lastSeenAt = snapshot.ts;
  const observedCount = continuing ? previous.observedCount + 1 : 1;
  const dwellMs = Math.max(0, nowMs - new Date(firstSeenAt).getTime());
  const score = computeTrailScore(snapshot, dwellMs, observedCount);
  const title = snapshot.chromeTitle || snapshot.windowTitle || snapshot.app || "Active focus";
  const raw = upsertRawEvent(db, {
    ts: snapshot.ts,
    source: "observer",
    sourceId,
    action: "active_focus",
    app: snapshot.app,
    windowTitle: snapshot.windowTitle,
    title,
    url: snapshot.chromeUrl,
    payload: {
      focusKey,
      firstSeenAt,
      lastSeenAt,
      observedCount,
      dwellMs,
      score,
      snapshot,
    },
  });
  upsertSignal(db, raw.id, "active_focus", 1, 1, { app: snapshot.app });
  upsertSignal(db, raw.id, "observed_count", observedCount, Math.min(3, observedCount / 5), {});
  upsertSignal(db, raw.id, "dwell_ms", dwellMs, Math.min(8, dwellMs / 60_000), {});
  upsertSignal(db, raw.id, "salience", score, score, { strategy: "mvp-v1" });

  const eventResult = await upsertEvent(db, {
    ts: snapshot.ts,
    source: "observer",
    sourceId,
    kind: "usage_trail",
    title,
    summary: `${snapshot.app}${snapshot.windowTitle ? ` · ${snapshot.windowTitle}` : ""}`,
    content: [
      `app: ${snapshot.app}`,
      snapshot.windowTitle ? `window: ${snapshot.windowTitle}` : "",
      snapshot.chromeTitle ? `chrome: ${snapshot.chromeTitle}` : "",
      snapshot.chromeUrl ? `url: ${snapshot.chromeUrl}` : "",
      `dwell_ms: ${dwellMs}`,
      `observed_count: ${observedCount}`,
      `score: ${score}`,
    ]
      .filter(Boolean)
      .join("\n"),
    url: snapshot.chromeUrl,
    app: snapshot.app,
    sensitivity: "private",
    tags: ["trail", "observer", "active"],
    metadata: {
      rawEventId: raw.id,
      focusKey,
      firstSeenAt,
      lastSeenAt,
      observedCount,
      dwellMs,
      score,
    },
  });
  const state: ObserverState = { focusKey, sourceId, firstSeenAt, lastSeenAt, observedCount };
  writeObserverState(db, "active_focus", state);
  db.close();

  const output = {
    source: "agent-memory-observer",
    ok: true,
    rawEventId: raw.id,
    rawResult: raw.result,
    eventResult,
    focusKey,
    sourceId,
    firstSeenAt,
    lastSeenAt,
    observedCount,
    dwellMs,
    score,
    snapshot,
  };
  if (jsonOutput) console.log(JSON.stringify(output, null, 2));
  else {
    console.log(
      `observer: ${eventResult}; ${snapshot.app}; dwell=${dwellMs}ms; count=${observedCount}; score=${score}; ${title}`,
    );
  }
}

async function ingestChromeTabs(args: string[], print = true): Promise<CommandStats> {
  const limit = argNumber(args, "--limit", 200);
  const timeoutMs = argNumber(args, "--timeout-ms", 5000);
  let snapshot: { running: boolean; tabs: ChromeTabSnapshot[] };
  try {
    snapshot = readChromeTabs(timeoutMs);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const output = {
      source: "chrome-tabs",
      scanned: 0,
      inserted: 0,
      updated: 0,
      skipped: 0,
      error: "chrome_automation_failed",
      message: compactLine(message, 400),
    };
    if (print) {
      console.error(JSON.stringify(output, null, 2));
      process.exitCode = 2;
    }
    return output;
  }

  if (!snapshot.running) {
    const output = { source: "chrome-tabs", scanned: 0, inserted: 0, updated: 0, skipped: 0, reason: "chrome_not_running" };
    if (print) console.log(JSON.stringify(output, null, 2));
    return output;
  }

  const now = new Date().toISOString();
  const day = now.slice(0, 10);
  const rows = snapshot.tabs.filter((tab) => tab.url || tab.title).slice(0, limit);
  const db = openDb();
  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  for (const tab of rows) {
    const safeUrl = sanitizeUrl(tab.url);
    const urlHash = sha256(safeUrl || `${tab.windowIndex}:${tab.tabIndex}:${tab.title}`).slice(0, 20);
    const title = compactLine(tab.title || safeUrl || "(untitled chrome tab)", 180);
    const result = await upsertEvent(db, {
      ts: now,
      source: "chrome-tabs",
      sourceId: `chrome-tab:${day}:${urlHash}`,
      kind: "browser_tab",
      title,
      summary: safeUrl,
      content: [tab.title, safeUrl].filter(Boolean).join("\n"),
      url: safeUrl || undefined,
      app: "Google Chrome",
      sensitivity: "private",
      tags: ["browser", "chrome", "tab", ...(tab.active ? ["active"] : [])],
      metadata: {
        windowIndex: tab.windowIndex,
        tabIndex: tab.tabIndex,
        active: tab.active,
        snapshotAt: now,
      },
    });
    if (result === "insert") inserted += 1;
    else if (result === "update") updated += 1;
    else skipped += 1;
  }

  db.close();
  const output = {
    source: "chrome-tabs",
    scanned: snapshot.tabs.length,
    ingested: rows.length,
    inserted,
    updated,
    skipped,
  };
  if (print) console.log(JSON.stringify(output, null, 2));
  return output;
}

async function addManual(args: string[]) {
  const source = argValue(args, "--source", "manual");
  const kind = argValue(args, "--kind", "note");
  const title = argValue(args, "--title", "");
  const content = argValue(args, "--content", "");
  if (!title && !content) usage(1);
  const db = openDb();
  const result = await upsertEvent(db, {
    ts: argValue(args, "--ts", new Date().toISOString()),
    source,
    sourceId: argValue(args, "--source-id", `${source}:${Date.now()}`),
    kind,
    title: title || content.slice(0, 120),
    summary: argValue(args, "--summary", ""),
    content,
    url: sanitizeUrl(argValue(args, "--url", "")) || undefined,
    cwd: argValue(args, "--cwd", "") || undefined,
    app: argValue(args, "--app", "") || undefined,
    sensitivity: argValue(args, "--sensitivity", "private"),
    tags: args.filter((arg, index) => args[index - 1] === "--tag"),
  });
  db.close();
  console.log(JSON.stringify({ result }, null, 2));
}

function argValues(args: string[], name: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === name && args[i + 1]) {
      values.push(args[i + 1]);
      i += 1;
    }
  }
  return values;
}

async function readStdinText(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function captureEvent(args: string[], defaults: Partial<EventInput> = {}) {
  const shouldReadStdin = hasFlag(args, "--stdin") || !process.stdin.isTTY;
  const stdinText = shouldReadStdin ? await readStdinText() : "";
  const title = argValue(args, "--title", defaults.title || "");
  const summary = argValue(args, "--summary", defaults.summary || "");
  const content = argValue(args, "--content", defaults.content || stdinText || "");
  if (!title && !summary && !content) usage(1);

  const source = argValue(args, "--source", defaults.source || "agent-capture");
  const kind = argValue(args, "--kind", defaults.kind || "note");
  const now = normalizeTimestamp(argValue(args, "--ts", new Date().toISOString()));
  const tags = Array.from(
    new Set([...(defaults.tags || []), ...argValues(args, "--tag")].filter(Boolean)),
  );
  const status = argValue(args, "--status", "");
  const result = argValue(args, "--result", "");
  const sourceId =
    argValue(args, "--source-id", "") ||
    `${source}:${now}:${sha256([title, summary, content, status, result].join("\n")).slice(0, 16)}`;

  const db = openDb();
  const writeResult = await upsertEvent(db, {
    ts: now,
    source,
    sourceId,
    kind,
    title: title || compactLine(summary || content, 180),
    summary,
    content,
    url: sanitizeUrl(argValue(args, "--url", defaults.url || "")) || undefined,
    cwd: argValue(args, "--cwd", defaults.cwd || process.cwd()) || undefined,
    app: argValue(args, "--app", defaults.app || "Agent") || undefined,
    sensitivity: argValue(args, "--sensitivity", defaults.sensitivity || "private"),
    tags,
    metadata: {
      status: status || undefined,
      result: result || undefined,
      capturedBy: "agent-memory",
    },
  });
  db.close();
  console.log(
    JSON.stringify(
      {
        result: writeResult,
        source,
        kind,
        sourceId,
        title: title || compactLine(summary || content, 180),
        tags,
      },
      null,
      2,
    ),
  );
}

async function capture(args: string[]) {
  return captureEvent(args, {
    source: "agent-capture",
    kind: "note",
    tags: ["agent", "capture"],
  });
}

async function closeout(args: string[]) {
  return captureEvent(args, {
    source: "agent-closeout",
    kind: "task_closeout",
    app: "Codex",
    tags: ["agent", "closeout", "mom"],
  });
}

function collectStats(): CommandStats {
  const db = openDb();
  const total = db.query("SELECT COUNT(*) AS c FROM events").get() as { c: number };
  const fts = db.query("SELECT COUNT(*) AS c FROM events_fts").get() as { c: number };
  const rawEvents = db.query("SELECT COUNT(*) AS c FROM raw_events").get() as { c: number };
  const artifacts = db.query("SELECT COUNT(*) AS c FROM artifacts").get() as { c: number };
  const signals = db.query("SELECT COUNT(*) AS c FROM signals").get() as { c: number };
  const episodes = db.query("SELECT COUNT(*) AS c FROM episodes").get() as { c: number };
  const memories = db.query("SELECT COUNT(*) AS c FROM memories").get() as { c: number };
  const semantic = db
    .query(
      `
      SELECT COUNT(DISTINCT ee.event_id) AS c
      FROM event_embeddings ee
      JOIN events e ON e.id = ee.event_id
      WHERE ee.content_hash = e.content_hash
    `,
    )
    .get() as { c: number };
  const semanticEmbeddingRows = db
    .query(
      `
      SELECT COUNT(*) AS c
      FROM event_embeddings ee
      JOIN events e ON e.id = ee.event_id
      WHERE ee.content_hash = e.content_hash
    `,
    )
    .get() as { c: number };
  const semanticByModel = db
    .query(
      `
      SELECT ee.model, COUNT(*) AS c, MIN(ee.dimensions) AS minDimensions, MAX(ee.dimensions) AS maxDimensions
      FROM event_embeddings ee
      JOIN events e ON e.id = ee.event_id
      WHERE ee.content_hash = e.content_hash
      GROUP BY ee.model
      ORDER BY c DESC, ee.model ASC
    `,
    )
    .all();
  const bySource = db.query("SELECT source, COUNT(*) AS c FROM events GROUP BY source ORDER BY c DESC").all();
  const byKind = db.query("SELECT kind, COUNT(*) AS c FROM events GROUP BY kind ORDER BY c DESC").all();
  const newest = db.query("SELECT ts, source, kind, title FROM events ORDER BY ts DESC LIMIT 1").get();
  db.close();
  return {
    dbPath: DB_PATH,
    total: total.c,
    ftsRows: fts.c,
    semanticRows: semantic.c,
    semanticEmbeddingRows: semanticEmbeddingRows.c,
    semanticByModel,
    bySource,
    byKind,
    newest,
    trail: {
      rawEvents: rawEvents.c,
      artifacts: artifacts.c,
      signals: signals.c,
      episodes: episodes.c,
      memories: memories.c,
    },
  };
}

function stats() {
  console.log(JSON.stringify(collectStats(), null, 2));
}

function countEventJsonl(): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  if (!existsSync(EVENT_DIR)) return { files, bytes };
  for (const name of readdirSync(EVENT_DIR)) {
    if (!name.endsWith(".jsonl")) continue;
    files += 1;
    bytes += statSync(path.join(EVENT_DIR, name)).size;
  }
  return { files, bytes };
}

function directorySizeKb(dir: string): number | null {
  try {
    const raw = execFileSync("du", ["-sk", dir], { encoding: "utf8", timeout: 5000 });
    const value = Number.parseInt(raw.trim().split(/\s+/)[0] || "", 10);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function secretScanHits(): string[] {
  try {
    const raw = execFileSync("rg", ["-l", SECRET_SCAN_PATTERN, MEMORY_ROOT], {
      encoding: "utf8",
      timeout: 5000,
    });
    return raw.split("\n").map((line) => line.trim()).filter(Boolean);
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 1) return [];
    return ["scan_error"];
  }
}

function listCapabilityIds(): { ok: boolean; count: number; ids: string[]; error?: string } {
  try {
    const raw = execFileSync("mom-cap", ["doctor", "--json", "--no-smoke"], { encoding: "utf8", timeout: 5000 });
    const parsed = JSON.parse(raw) as { ok?: boolean; capabilities?: Array<{ id?: string; ok?: boolean }> };
    const ids = (parsed.capabilities || []).map((item) => item.id || "").filter(Boolean);
    return { ok: Boolean(parsed.ok), count: ids.length, ids };
  } catch (err) {
    return {
      ok: false,
      count: 0,
      ids: [],
      error: compactLine(err instanceof Error ? err.message : String(err), 300),
    };
  }
}

function isResidualAgentProcess(command: string): boolean {
  if (/\brg\s+.*mom-agent-memory|git diff .*mom-agent-memory/.test(command)) return false;
  if (/\bosascript\b/.test(command)) return true;
  if (/\b(bun|node)\s+\/Users\/envvar\/mom\/tools\/mom-memory-index/.test(command)) return true;
  if (/\b(bun|node)\s+\/Users\/envvar\/mom\/tools\/mom-agent-memory\.ts\b/.test(command)) {
    return !/\bmom-agent-memory\.ts\s+doctor\b/.test(command);
  }
  if (/(^|\s)agent-memory(\s|$)/.test(command)) {
    return !/(^|\s)agent-memory\s+doctor(\s|$)/.test(command);
  }
  return false;
}

function residualProcesses(): Array<{ pid: number; command: string }> {
  try {
    const raw = execFileSync("ps", ["axo", "pid=,command="], { encoding: "utf8", timeout: 5000 });
    return raw
      .split("\n")
      .map((line) => {
        const match = line.trim().match(/^(\d+)\s+(.+)$/);
        if (!match) return null;
        return { pid: Number.parseInt(match[1], 10), command: match[2] };
      })
      .filter((row): row is { pid: number; command: string } => Boolean(row))
      .filter((row) => row.pid !== process.pid)
      .filter((row) => isResidualAgentProcess(row.command));
  } catch {
    return [{ pid: -1, command: "process_scan_error" }];
  }
}

function doctor(args: string[]) {
  const jsonOutput = hasFlag(args, "--json");
  const currentStats = collectStats() as {
    total: number;
    ftsRows: number;
    semanticRows: number;
    semanticEmbeddingRows?: number;
    dbPath: string;
    trail?: {
      rawEvents?: number;
      artifacts?: number;
      signals?: number;
      episodes?: number;
      memories?: number;
    };
  };
  const jsonl = countEventJsonl();
  const sizeKb = directorySizeKb(MEMORY_ROOT);
  const secretHits = secretScanHits();
  const capabilities = listCapabilityIds();
  const processes = residualProcesses();
  const checks = [
    { name: "events_present", ok: currentStats.total > 0, detail: `${currentStats.total} events` },
    {
      name: "fts_consistent",
      ok: currentStats.total === currentStats.ftsRows,
      detail: `${currentStats.ftsRows}/${currentStats.total} fts rows`,
    },
    { name: "jsonl_recovery_source", ok: jsonl.files > 0, detail: `${jsonl.files} files, ${jsonl.bytes} bytes` },
    {
      name: "semantic_index_optional",
      ok: currentStats.semanticRows <= currentStats.total,
      detail: `${currentStats.semanticRows}/${currentStats.total} semantic events, ${
        currentStats.semanticEmbeddingRows ?? currentStats.semanticRows
      } embedding rows`,
    },
    {
      name: "memory_size_small",
      ok: sizeKb === null ? false : sizeKb < 100 * 1024,
      detail: sizeKb === null ? "unknown" : `${sizeKb} KiB`,
    },
    {
      name: "trail_schema_present",
      ok: Boolean(currentStats.trail),
      detail: currentStats.trail
        ? `raw=${currentStats.trail.rawEvents || 0} signals=${currentStats.trail.signals || 0} artifacts=${
            currentStats.trail.artifacts || 0
          }`
        : "missing",
    },
    { name: "secret_scan", ok: secretHits.length === 0, detail: secretHits.length ? secretHits.join(", ") : "no hits" },
    {
      name: "capability_broker",
      ok: capabilities.ok && capabilities.count > 0,
      detail: capabilities.ok ? capabilities.ids.join(", ") : capabilities.error || "unavailable",
    },
    {
      name: "no_residual_processes",
      ok: processes.length === 0,
      detail: processes.length ? processes.map((p) => `${p.pid}:${p.command}`).join(" | ").slice(0, 500) : "none",
    },
  ];
  const ok = checks.every((check) => check.ok);
  const output = {
    ok,
    memoryRoot: MEMORY_ROOT,
    stats: currentStats,
    jsonl,
    sizeKb,
    capabilities,
    checks,
  };
  if (jsonOutput) {
    console.log(JSON.stringify(output, null, 2));
  } else {
    console.log(`agent-memory doctor: ${ok ? "ok" : "needs_attention"}`);
    for (const check of checks) {
      console.log(`${check.ok ? "ok" : "fail"}\t${check.name}\t${check.detail}`);
    }
  }
  if (!ok) process.exitCode = 2;
}

function recent(args: string[]) {
  const limit = argNumber(args, "--limit", 10);
  const db = openDb();
  const rows = db
    .query("SELECT ts, source, kind, title, cwd, url FROM events ORDER BY ts DESC LIMIT ?")
    .all(limit);
  db.close();
  console.log(JSON.stringify(rows, null, 2));
}

const VALUE_OPTIONS = new Set([
  "--limit",
  "--since-hours",
  "--limit-files",
  "--x-limit",
  "--tab-limit",
  "--timeout-ms",
  "--root",
  "--db",
  "--format",
  "--title",
  "--summary",
  "--content",
  "--source",
  "--source-id",
  "--kind",
  "--cwd",
  "--url",
  "--app",
  "--sensitivity",
  "--tag",
  "--status",
  "--result",
]);

function queryFromArgs(args: string[]): string {
  const terms: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (VALUE_OPTIONS.has(arg)) {
      i += 1;
      continue;
    }
    if (arg.startsWith("--")) continue;
    terms.push(arg);
  }
  return terms.join(" ").trim();
}

function buildFtsQuery(raw: string): string {
  const tokens = Array.from(
    new Set(String(raw).match(/[\p{L}\p{N}_-]+/gu) || []),
  )
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
    .slice(0, 12);
  return tokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(" ");
}

function searchRows(db: Database, query: string, limit: number): EventSearchRow[] {
  const ftsQuery = buildFtsQuery(query);
  if (ftsQuery) {
    try {
      const rows = db
        .query(
          `
          SELECT e.id, e.ts, e.source, e.kind, e.title, e.summary, e.cwd, e.url,
                 bm25(events_fts, 5.0, 3.0, 1.0, 0.8, 0.8, 0.6, 0.6, 0.5) AS rank,
                 snippet(events_fts, 2, '', '', '...', 18) AS snippet,
                 'fts' AS matchMode
          FROM events_fts
          JOIN events e ON e.id = events_fts.rowid
          WHERE events_fts MATCH ?
          ORDER BY rank ASC, e.ts DESC
          LIMIT ?
        `,
        )
        .all(ftsQuery, limit) as EventSearchRow[];
      if (rows.length > 0) return rows;
    } catch {
      // Fall through to LIKE for punctuation-heavy or otherwise invalid FTS queries.
    }
  }

  const like = `%${query.replace(/[%_]/g, " ")}%`;
  return db
    .query(
      `
      SELECT id, ts, source, kind, title, summary, cwd, url, 'like' AS matchMode
      FROM events
      WHERE title LIKE ? OR summary LIKE ? OR content LIKE ? OR url LIKE ? OR cwd LIKE ?
      ORDER BY ts DESC
      LIMIT ?
    `,
    )
    .all(like, like, like, like, like, limit) as EventSearchRow[];
}

function embeddingModelName(local = false): string {
  if (local) return LOCAL_EMBED_MODEL;
  return (process.env.GEMINI_EMBED_MODEL || "gemini-embedding-2").trim();
}

function eventEmbeddingText(row: {
  source: string;
  kind: string;
  title: string;
  summary?: string;
  content?: string;
  url?: string | null;
  cwd?: string | null;
  tags_json?: string;
}): string {
  let tags: string[] = [];
  try {
    tags = row.tags_json ? JSON.parse(row.tags_json) : [];
  } catch {
    tags = [];
  }
  return [
    `source: ${row.source}`,
    `kind: ${row.kind}`,
    `title: ${row.title}`,
    row.summary ? `summary: ${row.summary}` : "",
    row.content ? `content: ${row.content}` : "",
    row.url ? `url: ${row.url}` : "",
    row.cwd ? `cwd: ${row.cwd}` : "",
    tags.length > 0 ? `tags: ${tags.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, 6000);
}

function hashFeature(feature: string): number {
  let hash = 2166136261;
  for (let i = 0; i < feature.length; i += 1) {
    hash ^= feature.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function addLocalFeature(vector: number[], feature: string, weight: number) {
  if (!feature) return;
  const hash = hashFeature(feature);
  const index = hash % vector.length;
  const sign = hash & 0x80000000 ? -1 : 1;
  vector[index] += sign * weight;
}

function localHashVector(text: string): number[] {
  const vector = Array.from({ length: LOCAL_EMBED_DIMENSIONS }, () => 0);
  const normalized = text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, " ")
    .trim();
  const tokens = normalized.match(/[\p{L}\p{N}_-]+/gu)?.slice(0, 700) || [];

  for (const token of tokens) {
    addLocalFeature(vector, `tok:${token}`, 2);
  }
  for (let i = 0; i < tokens.length - 1; i += 1) {
    addLocalFeature(vector, `bi:${tokens[i]} ${tokens[i + 1]}`, 3);
  }

  const compact = Array.from(normalized.replace(/\s+/g, "")).slice(0, 2500);
  for (const size of [2, 3, 4]) {
    for (let i = 0; i <= compact.length - size; i += 1) {
      addLocalFeature(vector, `ng${size}:${compact.slice(i, i + size).join("")}`, size === 2 ? 0.5 : 1);
    }
  }

  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (!norm) return vector;
  return vector.map((value) => Number((value / norm).toFixed(8)));
}

function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i += 1) {
    const av = a[i] || 0;
    const bv = b[i] || 0;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (!normA || !normB) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function semanticRows(db: Database, queryVec: number[], limit: number, model: string): EventSearchRow[] {
  const rows = db
    .query(
      `
      SELECT e.id, e.ts, e.source, e.kind, e.title, e.summary, e.cwd, e.url,
             ee.vector_json
      FROM event_embeddings ee
      JOIN events e ON e.id = ee.event_id
      WHERE ee.content_hash = e.content_hash AND ee.model = ?
      ORDER BY e.ts DESC
    `,
    )
    .all(model) as Array<EventSearchRow & { vector_json: string }>;

  return rows
    .map((row) => {
      let vector: number[] = [];
      try {
        vector = JSON.parse(row.vector_json);
      } catch {
        vector = [];
      }
      const semanticScore = cosineSimilarity(queryVec, vector);
      return {
        id: row.id,
        ts: row.ts,
        source: row.source,
        kind: row.kind,
        title: row.title,
        summary: row.summary,
        cwd: row.cwd,
        url: row.url,
        semanticScore,
        matchMode: "semantic" as const,
      };
    })
    .sort((a, b) => (b.semanticScore || 0) - (a.semanticScore || 0))
    .slice(0, limit);
}

function mergeContextRows(ftsRows: EventSearchRow[], semantic: EventSearchRow[], limit: number): EventSearchRow[] {
  const byId = new Map<number | string, EventSearchRow>();
  for (const row of ftsRows) {
    byId.set(row.id ?? `${row.source}:${row.title}:${row.ts}`, row);
  }
  for (const row of semantic) {
    const key = row.id ?? `${row.source}:${row.title}:${row.ts}`;
    const existing = byId.get(key);
    if (existing) {
      existing.semanticScore = row.semanticScore;
      existing.matchMode = "hybrid";
    } else {
      byId.set(key, row);
    }
  }
  return Array.from(byId.values())
    .sort((a, b) => {
      const aFts = typeof a.rank === "number" ? -a.rank / 10 : 0;
      const bFts = typeof b.rank === "number" ? -b.rank / 10 : 0;
      const aScore = (a.semanticScore || 0) * 2 + aFts;
      const bScore = (b.semanticScore || 0) * 2 + bFts;
      return bScore - aScore;
    })
    .slice(0, limit);
}

function search(args: string[]) {
  const limit = argNumber(args, "--limit", 10);
  const query = queryFromArgs(args);
  if (!query) usage(1);
  const db = openDb();
  const rows = searchRows(db, query, limit);
  db.close();
  console.log(JSON.stringify(rows, null, 2));
}

async function embedEvents(args: string[]): Promise<CommandStats> {
  const limit = argNumber(args, "--limit", 25);
  const force = hasFlag(args, "--force");
  const useLocal = hasFlag(args, "--local");
  const model = embeddingModelName(useLocal);
  const db = openDb();
  const rows = db
    .query(
      `
      SELECT e.id, e.source, e.kind, e.title, e.summary, e.content, e.url, e.cwd, e.tags_json, e.content_hash
      FROM events e
      LEFT JOIN event_embeddings ee
        ON ee.event_id = e.id AND ee.model = ? AND ee.content_hash = e.content_hash
      WHERE (? OR ee.event_id IS NULL)
      ORDER BY e.ts DESC
      LIMIT ?
    `,
    )
    .all(model, force ? 1 : 0, limit) as Array<{
    id: number;
    source: string;
    kind: string;
    title: string;
    summary: string;
    content: string;
    url: string | null;
    cwd: string | null;
    tags_json: string;
    content_hash: string;
  }>;

  if (rows.length === 0) {
    db.close();
    const stats = collectStats();
    const output = { source: "agent-memory-embed", model, scanned: 0, embedded: 0, stats };
    console.log(JSON.stringify(output, null, 2));
    return output;
  }

  let embeddedCount = 0;
  let lastError = "";
  if (useLocal) {
    const now = new Date().toISOString();
    const tx = db.transaction(() => {
      for (const row of rows) {
        const vector = localHashVector(eventEmbeddingText(row));
        db.run(
          `
          INSERT INTO event_embeddings (event_id, model, content_hash, dimensions, vector_json, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(event_id, model) DO UPDATE SET
            content_hash = excluded.content_hash,
            dimensions = excluded.dimensions,
            vector_json = excluded.vector_json,
            updated_at = excluded.updated_at
        `,
          [row.id, model, row.content_hash, vector.length, JSON.stringify(vector), now],
        );
        embeddedCount += 1;
      }
    });
    tx();
    db.close();
    const stats = collectStats();
    const output = {
      source: "agent-memory-embed",
      model,
      scanned: rows.length,
      embedded: embeddedCount,
      stats,
    };
    console.log(JSON.stringify(output, null, 2));
    return output;
  }

  try {
    await embed(rows.map(eventEmbeddingText), {
      timeoutMs: argNumber(args, "--timeout-ms", 30000),
      waitOnRateLimit: hasFlag(args, "--wait"),
      onBatch: (batchStart, vectors) => {
        const now = new Date().toISOString();
        const tx = db.transaction(() => {
          for (let i = 0; i < vectors.length; i += 1) {
            const row = rows[batchStart + i];
            const vector = vectors[i];
            if (!row || !vector) continue;
            db.run(
              `
              INSERT INTO event_embeddings (event_id, model, content_hash, dimensions, vector_json, updated_at)
              VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(event_id, model) DO UPDATE SET
                content_hash = excluded.content_hash,
                dimensions = excluded.dimensions,
                vector_json = excluded.vector_json,
                updated_at = excluded.updated_at
            `,
              [row.id, model, row.content_hash, vector.length, JSON.stringify(vector), now],
            );
            embeddedCount += 1;
          }
        });
        tx();
      },
    });
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
  }

  db.close();
  const stats = collectStats();
  const output = {
    source: "agent-memory-embed",
    model,
    scanned: rows.length,
    embedded: embeddedCount,
    error: lastError || undefined,
    stats,
  };
  console.log(JSON.stringify(output, null, 2));
  if (lastError && embeddedCount === 0) process.exitCode = 2;
  return output;
}

async function refreshData(args: string[]): Promise<CommandStats> {
  const steps: CommandStats[] = [];
  if (!hasFlag(args, "--skip-codex")) {
    const root = argValue(args, "--root", "");
    steps.push(
      await ingestCodex(
        [
          "--since-hours",
          String(argNumber(args, "--since-hours", 24)),
          "--limit-files",
          String(argNumber(args, "--limit-files", 40)),
          ...(root ? ["--root", root] : []),
        ],
        false,
      ),
    );
  }
  if (!hasFlag(args, "--skip-x")) {
    const dbPath = argValue(args, "--db", "");
    steps.push(
      await ingestXBookmarks(
        ["--limit", String(argNumber(args, "--x-limit", 100)), ...(dbPath ? ["--db", dbPath] : [])],
        false,
      ),
    );
  }
  if (!hasFlag(args, "--skip-chrome")) {
    steps.push(
      await ingestChromeTabs(
        [
          "--limit",
          String(argNumber(args, "--tab-limit", 100)),
          "--timeout-ms",
          String(argNumber(args, "--timeout-ms", 5000)),
        ],
        false,
      ),
    );
  }
  return { source: "agent-memory-refresh", steps, stats: collectStats() };
}

async function refresh(args: string[]) {
  console.log(JSON.stringify(await refreshData(args), null, 2));
}

function formatContextResult(row: EventSearchRow) {
  return {
    ts: row.ts,
    source: row.source,
    kind: row.kind,
    title: row.title,
    summary: compactLine(row.summary || row.snippet || "", 320),
    cwd: row.cwd,
    url: row.url,
    match: row.matchMode,
    rank: typeof row.rank === "number" ? Number(row.rank.toFixed(4)) : undefined,
    semanticScore: typeof row.semanticScore === "number" ? Number(row.semanticScore.toFixed(4)) : undefined,
  };
}

function rawEventStats(db: Database): JsonRecord {
  const total = db.query("SELECT COUNT(*) AS c FROM raw_events").get() as { c: number };
  const recent = db
    .query(
      `
      SELECT id, ts, source, action, app, window_title, title, url
      FROM raw_events
      ORDER BY ts DESC
      LIMIT 10
    `,
    )
    .all();
  const signalRows = db
    .query(
      `
      SELECT name, COUNT(*) AS count, ROUND(AVG(value), 3) AS avgValue, ROUND(AVG(score), 3) AS avgScore
      FROM signals
      GROUP BY name
      ORDER BY count DESC, name ASC
    `,
    )
    .all();
  const state = readObserverState(db, "active_focus");
  return { total: total.c, recent, signals: signalRows, state };
}

function trail(args: string[]) {
  const db = openDb();
  const output = rawEventStats(db);
  db.close();
  console.log(JSON.stringify(output, null, 2));
}

type DreamInputRow = {
  id: number;
  ts: string;
  source: string;
  kind: string;
  title: string;
  summary: string;
  content: string;
  url: string | null;
  cwd: string | null;
  app: string | null;
  tags_json: string;
  metadata_json: string;
};

type DreamEpisode = {
  key: string;
  title: string;
  start: string;
  end: string;
  count: number;
  score: number;
  sources: string[];
  kinds: string[];
  urls: string[];
  titles: string[];
};

function parseStringArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw || "[]") as unknown;
    return Array.isArray(parsed) ? parsed.map((item) => String(item)).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function hostFromUrl(raw: string | null): string {
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    return parsed.hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function baseName(raw: string | null): string {
  if (!raw) return "";
  const parts = raw.split("/").filter(Boolean);
  return compactLine(parts.at(-1) || raw, 80);
}

function dreamAnchor(row: DreamInputRow): { key: string; title: string } {
  const host = hostFromUrl(row.url);
  if (row.source === "codex") {
    const project = baseName(row.cwd) || "Codex";
    return { key: `codex:${project}`, title: `Codex: ${project}` };
  }
  if (row.source === "agent-closeout") return { key: "closeout", title: "Task closeouts" };
  if (host) return { key: `web:${host}`, title: host };
  const source = row.source || "memory";
  return { key: `${source}:${row.kind}`, title: `${source} / ${row.kind}` };
}

function rowSalience(row: DreamInputRow): number {
  const tags = parseStringArray(row.tags_json);
  let score = 1;
  if (tags.includes("active")) score += 4;
  if (row.source === "agent-closeout") score += 8;
  if (row.source === "codex") score += 4;
  if (row.source === "agent-capture") score += 5;
  if (row.source === "x-bookmarks") score += 2;
  if (row.kind.includes("bookmark")) score += 2;
  if (row.summary && row.summary !== row.url) score += 1;
  if (row.content.length > 800) score += 2;
  if (hostFromUrl(row.url)) score += 1;
  if (row.source === "chrome-tabs" && !tags.includes("active")) score -= 0.5;
  return Math.max(0.1, score);
}

function makeDreamEpisodes(rows: DreamInputRow[], maxEpisodes = 10): DreamEpisode[] {
  const episodes = new Map<string, DreamEpisode>();
  for (const row of rows) {
    const anchor = dreamAnchor(row);
    const existing =
      episodes.get(anchor.key) ||
      ({
        key: anchor.key,
        title: anchor.title,
        start: row.ts,
        end: row.ts,
        count: 0,
        score: 0,
        sources: [],
        kinds: [],
        urls: [],
        titles: [],
      } satisfies DreamEpisode);
    existing.start = existing.start < row.ts ? existing.start : row.ts;
    existing.end = existing.end > row.ts ? existing.end : row.ts;
    existing.count += 1;
    existing.score += rowSalience(row);
    if (!existing.sources.includes(row.source)) existing.sources.push(row.source);
    if (!existing.kinds.includes(row.kind)) existing.kinds.push(row.kind);
    const url = row.url || "";
    if (url && existing.urls.length < 5 && !existing.urls.includes(url)) existing.urls.push(url);
    const title = compactLine(row.title || row.summary || url, 140);
    if (title && existing.titles.length < 8 && !existing.titles.includes(title)) existing.titles.push(title);
    episodes.set(anchor.key, existing);
  }
  return Array.from(episodes.values())
    .sort((a, b) => b.score - a.score || b.count - a.count || b.end.localeCompare(a.end))
    .slice(0, maxEpisodes)
    .map((episode) => ({ ...episode, score: Number(episode.score.toFixed(2)) }));
}

function buildDreamContent(params: {
  sinceHours: number;
  scanned: number;
  episodes: DreamEpisode[];
  decayCandidates: number;
  bySource: Array<{ source: string; count: number }>;
}): string {
  const lines = [
    `# Agent Memory Dream`,
    ``,
    `Window: last ${params.sinceHours}h`,
    `Input events: ${params.scanned}`,
    `Episodes: ${params.episodes.length}`,
    `Low-signal raw events that can decay: ${params.decayCandidates}`,
    ``,
    `## Source Mix`,
    ...params.bySource.map((item) => `- ${item.source}: ${item.count}`),
    ``,
    `## Episodes`,
    ...params.episodes.flatMap((episode, index) => [
      `${index + 1}. ${episode.title}`,
      `   - score: ${episode.score}; events: ${episode.count}; time: ${episode.start} -> ${episode.end}`,
      `   - sources: ${episode.sources.join(", ")}; kinds: ${episode.kinds.join(", ")}`,
      ...episode.titles.slice(0, 4).map((title) => `   - ${title}`),
      ...episode.urls.slice(0, 2).map((url) => `   - ${url}`),
    ]),
    ``,
    `## Forget Policy`,
    `- Keep this dream episode as the durable memory.`,
    `- Let short dwell, non-active browser-tab raw events decay first.`,
    `- Keep events that were active, copied into agent work, closeouts, captures, or repeated across sources.`,
  ];
  return lines.join("\n");
}

async function dream(args: string[]) {
  const sinceHours = Math.max(1, argNumber(args, "--since-hours", 24));
  const limit = Math.max(20, Math.min(1000, argNumber(args, "--limit", 240)));
  const dryRun = hasFlag(args, "--dry-run");
  const cutoff = new Date(Date.now() - sinceHours * 60 * 60 * 1000).toISOString();
  const db = openDb();
  const rows = db
    .query(
      `
      SELECT id, ts, source, kind, title, summary, content, url, cwd, app, tags_json, metadata_json
      FROM events
      WHERE ts >= ?
        AND source NOT IN ('agent-dream')
      ORDER BY ts ASC
      LIMIT ?
    `,
    )
    .all(cutoff, limit) as DreamInputRow[];

  const episodes = makeDreamEpisodes(rows);
  const decayCandidates = rows.filter((row) => row.source === "chrome-tabs" && rowSalience(row) <= 1.5).length;
  const bySource = Array.from(
    rows.reduce((map, row) => map.set(row.source, (map.get(row.source) || 0) + 1), new Map<string, number>()),
  )
    .map(([source, count]) => ({ source, count }))
    .sort((a, b) => b.count - a.count);
  const now = new Date().toISOString();
  const sourceId = `dream:${now.slice(0, 10)}`;
  const content = buildDreamContent({ sinceHours, scanned: rows.length, episodes, decayCandidates, bySource });
  let result: "insert" | "update" | "skip" | "dry-run" = "dry-run";
  if (!dryRun && rows.length > 0) {
    result = await upsertEvent(db, {
      ts: now,
      source: "agent-dream",
      sourceId,
      kind: "memory_episode",
      title: `Dream: ${now.slice(0, 10)} usage trail`,
      summary: `Consolidated ${rows.length} trail events into ${episodes.length} episodes; ${decayCandidates} low-signal raw events can decay.`,
      content,
      app: "Agent Memory",
      sensitivity: "private",
      tags: ["dream", "trail", "memory", "consolidated"],
      metadata: {
        sinceHours,
        inputEvents: rows.length,
        decayCandidates,
        episodes,
        bySource,
      },
    });
  }
  db.close();

  console.log(
    JSON.stringify(
      {
        source: "agent-memory-dream",
        sinceHours,
        scanned: rows.length,
        episodes,
        decayCandidates,
        result,
        sourceId,
        dryRun,
      },
      null,
      2,
    ),
  );
}

async function context(args: string[]) {
  const limit = argNumber(args, "--limit", 6);
  const query = queryFromArgs(args);
  if (!query) usage(1);

  let refreshed: CommandStats | null = null;
  if (hasFlag(args, "--refresh")) {
    refreshed = await refreshData(args);
  }

  const db = openDb();
  let rows = searchRows(db, query, Math.max(limit, limit * 2));
  let semanticError = "";
  let semanticModel = "";
  if (hasFlag(args, "--semantic")) {
    try {
      const useLocal = hasFlag(args, "--local");
      semanticModel = embeddingModelName(useLocal);
      const queryVec = useLocal
        ? localHashVector(query)
        : await embedQuery(query, { timeoutMs: argNumber(args, "--timeout-ms", 30000) });
      rows = mergeContextRows(rows, semanticRows(db, queryVec, Math.max(limit, limit * 2), semanticModel), limit);
    } catch (err) {
      semanticError = compactLine(err instanceof Error ? err.message : String(err), 320);
      rows = rows.slice(0, limit);
    }
  } else {
    rows = rows.slice(0, limit);
  }
  db.close();

  console.log(
    JSON.stringify(
      {
        source: "agent-memory-context",
        query,
        refreshed,
        semantic: hasFlag(args, "--semantic")
          ? {
              enabled: true,
              model: semanticModel || undefined,
              local: hasFlag(args, "--local") || undefined,
              error: semanticError || undefined,
            }
          : { enabled: false },
        results: rows.map(formatContextResult),
        notes: [
          "SQLite/FTS are indexes; JSONL files under ~/.agents/memory/events are the recovery source.",
          "Secret values are not stored here; use mom-cap/envchain for credential-backed actions.",
        ],
      },
      null,
      2,
    ),
  );
}

async function rebuildFromJsonl() {
  const db = openDb();
  db.run("DELETE FROM event_embeddings");
  db.run("DELETE FROM events_fts");
  db.run("DELETE FROM events");
  let files = 0;
  let applied = 0;
  if (existsSync(EVENT_DIR)) {
    for (const name of readdirSync(EVENT_DIR).filter((item) => item.endsWith(".jsonl")).sort()) {
      files += 1;
      const raw = await readFile(path.join(EVENT_DIR, name), "utf8");
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        const row = JSON.parse(line) as { event?: ReturnType<typeof normalizeEvent> };
        if (!row.event) continue;
        await upsertEvent(db, row.event, false);
        applied += 1;
      }
    }
  }
  rebuildFts(db);
  db.close();
  const stats = collectStats();
  console.log(
    JSON.stringify(
      {
        files,
        applied,
        rows: Number((stats as { total: number }).total),
        ftsRows: Number((stats as { ftsRows: number }).ftsRows),
        semanticRows: Number((stats as { semanticRows: number }).semanticRows),
        dbPath: DB_PATH,
      },
      null,
      2,
    ),
  );
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd || cmd === "-h" || cmd === "--help") usage(0);
  if (cmd === "init") {
    const db = openDb();
    db.close();
    console.log(JSON.stringify({ dbPath: DB_PATH, eventDir: EVENT_DIR }, null, 2));
    return;
  }
  if (cmd === "stats") return stats();
  if (cmd === "doctor") return doctor(args);
  if (cmd === "recent") return recent(args);
  if (cmd === "search") return search(args);
  if (cmd === "trail") return trail(args);
  if (cmd === "context") return context(args);
  if (cmd === "observe") return observe(args);
  if (cmd === "dream") return dream(args);
  if (cmd === "capture") return capture(args);
  if (cmd === "closeout") return closeout(args);
  if (cmd === "add") return addManual(args);
  if (cmd === "refresh") return refresh(args);
  if (cmd === "embed") return embedEvents(args);
  if (cmd === "ingest-codex") return ingestCodex(args);
  if (cmd === "ingest-x-bookmarks") return ingestXBookmarks(args);
  if (cmd === "ingest-chrome-tabs") return ingestChromeTabs(args);
  if (cmd === "rebuild") return rebuildFromJsonl();
  usage(1);
}

await main();
