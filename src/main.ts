#!/usr/bin/env bun

import { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import { chat, chatJson, embed, embedQuery } from "./lib/ai-client";

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
  agent-memory context "query" [--limit 6] [--refresh] [--semantic]
  agent-memory observe [--json] [--timeout-ms 5000]
  agent-memory dream [--since-hours 24] [--limit 240] [--dry-run]
  agent-memory correct <thread:..|episode:..|link:..|eventId> <boost|demote|wrong-summary|split|merge> [--delta N] [--note "..."]
  agent-memory links [--limit 20]
  agent-memory notify [--since-min 35] [--limit 5] [--link-sim 0.90] [--episode-score 400] [--dry-run]
  agent-memory embed [--limit 25] [--force] [--wait]
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
    CREATE TABLE IF NOT EXISTS salience_feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      target_kind TEXT NOT NULL,
      target_id TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT '',
      app TEXT NOT NULL DEFAULT '',
      signal TEXT NOT NULL,
      delta REAL NOT NULL DEFAULT 0,
      note TEXT NOT NULL DEFAULT '',
      metadata_json TEXT NOT NULL DEFAULT '{}'
    )
  `);
  db.run("CREATE INDEX IF NOT EXISTS idx_salience_feedback_bucket ON salience_feedback(source, app)");
  db.run(`
    CREATE TABLE IF NOT EXISTS thread_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      src_thread TEXT NOT NULL,
      dst_thread TEXT NOT NULL,
      relation TEXT NOT NULL DEFAULT 'cross-surface',
      similarity REAL NOT NULL DEFAULT 0,
      time_gap_min REAL NOT NULL DEFAULT 0,
      src_app TEXT NOT NULL DEFAULT '',
      dst_app TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(src_thread, dst_thread)
    )
  `);
  db.run("CREATE INDEX IF NOT EXISTS idx_thread_links_src ON thread_links(src_thread)");
  db.run("CREATE INDEX IF NOT EXISTS idx_thread_links_dst ON thread_links(dst_thread)");
  db.run(`
    CREATE TABLE IF NOT EXISTS episodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id TEXT NOT NULL UNIQUE,
      thread_id TEXT REFERENCES episode_threads(id),
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
    CREATE TABLE IF NOT EXISTS episode_threads (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open',
      main_app TEXT NOT NULL DEFAULT '',
      count INTEGER NOT NULL DEFAULT 0,
      centroid_json TEXT,
      event_ids TEXT NOT NULL DEFAULT '[]',
      start_ts TEXT,
      end_ts TEXT,
      merged_into TEXT REFERENCES episode_threads(id),
      score REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      closed_at TEXT
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
  db.run(`
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rule TEXT NOT NULL,
      dedupe_key TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      delivered INTEGER NOT NULL DEFAULT 0,
      delivered_at TEXT
    )
  `);
  db.run("CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications(created_at)");
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
    const raw = execFileSync("rg", ["-l", SECRET_SCAN_PATTERN, MEMORY_ROOT, "--iglob", "!config.json"], {
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

  // Episode status
  const episodeStats = (() => {
    try {
      const localDb = openDb();
      const threadCount = (localDb.query("SELECT COUNT(*) as c FROM episode_threads").get() as { c: number })?.c || 0;
      const episodeCount = (localDb.query("SELECT COUNT(*) as c FROM episodes").get() as { c: number })?.c || 0;
      const openThreads = (localDb.query("SELECT COUNT(*) as c FROM episode_threads WHERE status = 'open'").get() as { c: number })?.c || 0;
      localDb.close();
      return { threads: threadCount, episodes: episodeCount, openThreads };
    } catch {
      return { threads: 0, episodes: 0, openThreads: 0 };
    }
  })();
  const ok = checks.every((check) => check.ok);
  const output = {
    ok,
    memoryRoot: MEMORY_ROOT,
    stats: currentStats,
    episodeStats,
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
    console.log(`info\tepisode_stats\tthreads=${episodeStats.threads} episodes=${episodeStats.episodes} open_threads=${episodeStats.openThreads}`);
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

function embeddingModelName(): string {
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
  const model = embeddingModelName();
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
  vector_json: string | null;
};

type DreamSegment = {
  eventIds: number[];
  mainApp: string;
  start: string;
  end: string;
  count: number;
  centroid: number[] | null;
  score: number;
};

type DreamThread = {
  id: string;
  label: string;
  mainApp: string;
  eventIds: number[];
  start: string;
  end: string;
  count: number;
  centroid: number[] | null;
  score: number;
  status: "open" | "closed" | "merged";
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

function rowSalience(row: DreamInputRow, learned?: Map<string, number>): number {
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
  if (learned) {
    const app = eventApp(row);
    score +=
      learned.get(`${row.source}|${app}`) ??
      learned.get(`*|${app}`) ??
      learned.get(`${row.source}|*`) ??
      0;
  }
  return Math.max(0.1, score);
}

function eventApp(row: DreamInputRow): string {
  if (row.app) return row.app;
  const host = hostFromUrl(row.url);
  if (host) return host;
  return row.source;
}

function centroidOf(vectors: number[][]): number[] | null {
  if (vectors.length === 0) return null;
  const dims = vectors[0].length;
  const sum = new Array(dims).fill(0);
  for (const vec of vectors) {
    for (let i = 0; i < dims; i++) sum[i] += vec[i];
  }
  return sum.map((v) => v / vectors.length);
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

// ── Step 1: Deterministic Segmentation ──

function segmentByApp(events: DreamInputRow[], learned?: Map<string, number>): DreamSegment[] {
  const segments: DreamSegment[] = [];
  let current: DreamInputRow[] = [];

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (current.length === 0) {
      current.push(ev);
      continue;
    }
    const prev = current[current.length - 1];
    const prevApp = eventApp(prev);
    const curApp = eventApp(ev);
    const timeGapMs = new Date(ev.ts).getTime() - new Date(prev.ts).getTime();
    const timeGapMin = timeGapMs / 60000;

    if (prevApp !== curApp) {
      segments.push(buildSegment(current, learned));
      current = [ev];
      continue;
    }

    if (timeGapMin > 30) {
      segments.push(buildSegment(current, learned));
      current = [ev];
      continue;
    }

    current.push(ev);
  }

  if (current.length > 0) {
    segments.push(buildSegment(current, learned));
  }

  return segments;
}

function buildSegment(events: DreamInputRow[], learned?: Map<string, number>): DreamSegment {
  const ids = events.map((e) => e.id);
  const vectors = events
    .map((e) => {
      try {
        return e.vector_json ? JSON.parse(e.vector_json) : null;
      } catch {
        return null;
      }
    })
    .filter((v): v is number[] => v !== null);

  let score = 0;
  for (const ev of events) score += rowSalience(ev, learned);

  return {
    eventIds: ids,
    mainApp: eventApp(events[0]),
    start: events[0].ts,
    end: events[events.length - 1].ts,
    count: events.length,
    centroid: centroidOf(vectors),
    score: Number(score.toFixed(1)),
  };
}

// ── Step 2: Embedding Merge ──

function mergeSegments(segments: DreamSegment[]): DreamSegment[] {
  if (segments.length <= 1) return segments;

  const merged: DreamSegment[] = [];
  let current = segments[0];

  for (let i = 1; i < segments.length; i++) {
    const next = segments[i];
    let shouldMerge = false;

    if (current.mainApp !== next.mainApp) {
      merged.push(current);
      current = next;
      continue;
    }

    if (current.centroid && next.centroid) {
      const cos = cosineSimilarity(current.centroid, next.centroid);
      const timeGapMs = new Date(next.start).getTime() - new Date(current.end).getTime();
      const timeGapMin = timeGapMs / 60000;

      if (cos > 0.95) shouldMerge = true;
      if (cos > 0.90 && timeGapMin < 5) shouldMerge = true;
    }

    if (shouldMerge) {
      current.eventIds.push(...next.eventIds);
      current.end = next.end;
      current.count += next.count;
      current.score = Number((current.score + next.score).toFixed(1));
      if (current.centroid && next.centroid) {
        const dims = current.centroid.length;
        const total = current.count + next.count;
        const avg = new Array(dims).fill(0);
        for (let j = 0; j < dims; j++) {
          avg[j] = (current.centroid[j] * current.count + next.centroid[j] * next.count) / total;
        }
        current.centroid = avg;
      }
    } else {
      merged.push(current);
      current = next;
    }
  }

  merged.push(current);
  return merged;
}

// ── Step 3: Thread Assignment ──

function assignToThreads(segments: DreamSegment[], existingThreads: DreamThread[]): DreamThread[] {
  const threads = [...existingThreads];
  const now = new Date().toISOString();

  for (const seg of segments) {
    let bestMatch: DreamThread | null = null;
    let bestScore = 0;

    for (const thread of threads) {
      if (thread.status !== "open") continue;

      let combined = 0;
      const appMatch = seg.mainApp === thread.mainApp ? 1 : 0;
      combined += appMatch * 0.5;

      const threadEndMs = new Date(thread.end).getTime();
      const segStartMs = new Date(seg.start).getTime();
      const timeDeltaMin = (segStartMs - threadEndMs) / 60000;
      const timeClose = timeDeltaMin >= 0 && timeDeltaMin <= 30 ? 1 : 0;
      combined += timeClose * 0.2;

      if (seg.centroid && thread.centroid) {
        const cos = cosineSimilarity(seg.centroid, thread.centroid);
        combined += cos * 0.3;
      }

      if (combined > bestScore) {
        bestScore = combined;
        bestMatch = thread;
      }
    }

    if (bestMatch && bestScore > 0.5) {
      bestMatch.eventIds.push(...seg.eventIds);
      bestMatch.count += seg.count;
      bestMatch.score = Number((bestMatch.score + seg.score).toFixed(1));
      if (seg.end > bestMatch.end) bestMatch.end = seg.end;
      if (seg.start < bestMatch.start) bestMatch.start = seg.start;

      if (seg.centroid && bestMatch.centroid) {
        const dims = seg.centroid.length;
        const total = bestMatch.count + seg.count;
        const avg = new Array(dims).fill(0);
        for (let j = 0; j < dims; j++) {
          avg[j] = (bestMatch.centroid[j] * bestMatch.count + seg.centroid[j] * seg.count) / total;
        }
        bestMatch.centroid = avg;
      }
    } else {
      const threadId = `thread:${now.slice(0, 10)}:${seg.mainApp}:${threads.length}`;
      threads.push({
        id: threadId,
        label: seg.mainApp,
        mainApp: seg.mainApp,
        eventIds: [...seg.eventIds],
        start: seg.start,
        end: seg.end,
        count: seg.count,
        centroid: seg.centroid ? [...seg.centroid] : null,
        score: seg.score,
        status: "open",
      });
    }
  }

  return threads;
}

function buildDreamContent(params: {
  sinceHours: number;
  scanned: number;
  segments: DreamSegment[];
  threads: DreamThread[];
  decayCandidates: number;
  bySource: Array<{ source: string; count: number }>;
  crossLinks: ThreadLink[];
}): string {
  const lines = [
    `# Agent Memory Dream`,
    ``,
    `Window: last ${params.sinceHours}h`,
    `Input events: ${params.scanned}`,
    `Segments: ${params.segments.length}`,
    `Threads: ${params.threads.length} (open=${params.threads.filter((t) => t.status === "open").length}, closed=${params.threads.filter((t) => t.status === "closed").length})`,
    `Low-signal raw events that can decay: ${params.decayCandidates}`,
    ``,
    `## Source Mix`,
    ...params.bySource.map((item) => `- ${item.source}: ${item.count}`),
    ``,
    `## Segments`,
    ...params.segments.map((seg, i) => {
      const timeRange = `${seg.start.slice(5, 19)} → ${seg.end.slice(11, 19)}`;
      return `${i + 1}. [${seg.mainApp}] ${seg.count} events, score=${seg.score}, ${timeRange}`;
    }),
    ``,
    `## Threads`,
    ...params.threads.map((thr, i) => {
      const timeRange = `${thr.start.slice(5, 19)} → ${thr.end.slice(11, 19)}`;
      return `${i + 1}. [${thr.label}] (${thr.status}) ${thr.count} events, score=${thr.score}, ${timeRange}`;
    }),
    ``,
    `## Cross-Surface Links (${params.crossLinks.length})`,
    ...(params.crossLinks.length === 0
      ? [`- (none this cycle)`]
      : params.crossLinks.map(
          (l) => `- [${l.srcApp}] ↔ [${l.dstApp}] sim=${l.similarity}, gap=${l.gapMin}min`,
        )),
    ``,
    `## Forget Policy`,
    `- Keep this dream episode as the durable memory.`,
    `- Let short dwell, non-active browser-tab raw events decay first.`,
    `- Keep events that were active, copied into agent work, closeouts, captures, or repeated across sources.`,
  ];
  return lines.join("\n");
}

// ── Salience feedback (P1: correction loop) ──

const SIGNAL_DELTA: Record<string, number> = {
  boost: 2,
  demote: -2,
  "wrong-summary": -1,
  split: -1.5,
  merge: 1,
};

// Aggregate corrections into per-(source,app) salience nudges.
// Half-life decay (14d) so recent corrections dominate; clamp ±4 so a few
// signals can't overwhelm the hardcoded baseline — convergence, not override.
function loadLearnedWeights(db: Database): Map<string, number> {
  const rows = db
    .query("SELECT source, app, delta, ts FROM salience_feedback")
    .all() as Array<{ source: string; app: string; delta: number; ts: string }>;
  const now = Date.now();
  const halfLifeDays = 14;
  const acc = new Map<string, number>();
  for (const r of rows) {
    const ageDays = (now - new Date(r.ts).getTime()) / 86400000;
    const weight = r.delta * Math.pow(0.5, ageDays / halfLifeDays);
    const exact = `${r.source}|${r.app}`;
    const wildcard = `${r.source}|*`;
    acc.set(exact, (acc.get(exact) ?? 0) + weight);
    acc.set(wildcard, (acc.get(wildcard) ?? 0) + weight * 0.5);
  }
  for (const [k, v] of acc) acc.set(k, Math.max(-4, Math.min(4, v)));
  return acc;
}

async function correct(args: string[]) {
  const target = args[0];
  const signal = args[1];
  if (!target || !signal || !(signal in SIGNAL_DELTA)) {
    console.error(
      `usage: agent-memory correct <thread:..|episode:..|link:..|eventId> <${Object.keys(SIGNAL_DELTA).join("|")}> [--delta N] [--note "..."]`,
    );
    usage(1);
  }
  const note = argValue(args, "--note", "");
  const deltaRaw = argValue(args, "--delta", "");
  const delta = deltaRaw ? Number(deltaRaw) : SIGNAL_DELTA[signal];
  if (!Number.isFinite(delta)) usage(1);

  const db = openDb();
  let kind = "event";
  let source = "";
  let app = "";

  if (target.startsWith("thread:")) {
    kind = "thread";
    source = "*"; // thread is app-siloed → nudge the whole app bucket
    const t = db.query("SELECT main_app FROM episode_threads WHERE id = ?").get(target) as
      | { main_app: string }
      | null;
    if (!t) {
      console.error(`thread not found: ${target}`);
      usage(1);
    }
    app = t!.main_app ?? "";
  } else if (target.startsWith("episode:")) {
    kind = "episode";
    source = "*"; // episode rolls up a thread → app-wide nudge
    const e = db.query("SELECT metadata_json FROM episodes WHERE source_id = ?").get(target) as
      | { metadata_json: string }
      | null;
    if (!e) {
      console.error(`episode not found: ${target}`);
      usage(1);
    }
    try {
      app = String(JSON.parse(e!.metadata_json)?.mainApp ?? "");
    } catch {
      app = "";
    }
  } else if (target.startsWith("link:")) {
    kind = "link";
    const linkId = Number(target.slice("link:".length));
    const row = db.query("SELECT src_app, dst_app FROM thread_links WHERE id = ?").get(linkId) as
      | { src_app: string; dst_app: string }
      | null;
    if (!row) {
      console.error(`link not found: ${target}`);
      usage(1);
    }
    // normalize the app pair so feedback is direction-agnostic (appLo|appHi)
    [source, app] = [row!.src_app, row!.dst_app].sort();
  } else {
    const e = db.query("SELECT source, app FROM events WHERE id = ?").get(Number(target)) as
      | { source: string; app: string | null }
      | null;
    if (!e) {
      console.error(`event not found: ${target}`);
      usage(1);
    }
    source = e!.source ?? "";
    app = e!.app ?? "";
  }

  db.run(
    `INSERT INTO salience_feedback (ts, target_kind, target_id, source, app, signal, delta, note, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [new Date().toISOString(), kind, target, source, app, signal, delta, note, "{}"],
  );

  // P2.5: demoting a cross-surface link prunes that app-pair's edges now;
  // future dream cycles also see a raised threshold via loadLinkFeedback.
  let pruned = 0;
  if (kind === "link" && delta < 0) {
    pruned = db
      .query(
        `DELETE FROM thread_links
         WHERE (src_app = ? AND dst_app = ?) OR (src_app = ? AND dst_app = ?)`,
      )
      .run(source, app, app, source).changes;
  }

  console.log(
    JSON.stringify(
      { ok: true, target, kind, signal, delta, bucket: `${source}|${app}`, ...(kind === "link" ? { prunedLinks: pruned } : {}) },
      null,
      2,
    ),
  );
}

// ── Cross-surface synthesis (P2: central gardener) ──
// dream's segmentation/merge is app-siloed by design; this second pass links
// threads ACROSS different apps when they're semantically related and
// temporally adjacent — turning the per-surface thread list into a graph.

const CROSS_SIM_MIN = 0.85; // centroid cosine floor for a cross-surface link
const CROSS_GAP_MAX_MIN = 30; // max idle gap between the two threads' intervals
const CROSS_TOPK_PER_THREAD = 3; // cap links per thread (embedding is anisotropic; rank locally)
const CROSS_ADJ_SCALE = 0.03; // P2.5: per-point shift of the sim threshold from link feedback

function intervalGapMin(aStart: string, aEnd: string, bStart: string, bEnd: string): number {
  const as = new Date(aStart).getTime();
  const ae = new Date(aEnd).getTime();
  const bs = new Date(bStart).getTime();
  const be = new Date(bEnd).getTime();
  if (ae >= bs && be >= as) return 0; // overlapping intervals
  if (be < as) return (as - be) / 60000;
  return (bs - ae) / 60000;
}

interface ThreadLink {
  src: string;
  dst: string;
  srcApp: string;
  dstApp: string;
  similarity: number;
  gapMin: number;
}

// P2.5: per-(appLo|appHi) link feedback. Mirrors loadLearnedWeights (14d
// half-life, clamp ±4) so the link and salience correction loops behave alike.
function loadLinkFeedback(db: Database): Map<string, number> {
  const rows = db
    .query("SELECT source, app, delta, ts FROM salience_feedback WHERE target_kind = 'link'")
    .all() as Array<{ source: string; app: string; delta: number; ts: string }>;
  const now = Date.now();
  const halfLifeDays = 14;
  const acc = new Map<string, number>();
  for (const r of rows) {
    const ageDays = (now - new Date(r.ts).getTime()) / 86400000;
    const weight = r.delta * Math.pow(0.5, ageDays / halfLifeDays);
    const key = [r.source, r.app].sort().join("|");
    acc.set(key, (acc.get(key) ?? 0) + weight);
  }
  for (const [k, v] of acc) acc.set(k, Math.max(-4, Math.min(4, v)));
  return acc;
}

function synthesizeCrossSurface(
  threads: DreamThread[],
  linkAdj?: Map<string, number>,
): ThreadLink[] {
  const usable = threads.filter((t) => t.centroid && t.centroid.length > 0);

  // 1) candidate cross-app pairs passing the similarity + time-gap filters
  const candidates: ThreadLink[] = [];
  for (let i = 0; i < usable.length; i++) {
    for (let j = i + 1; j < usable.length; j++) {
      const a = usable[i];
      const b = usable[j];
      if (a.mainApp === b.mainApp) continue; // cross-surface only
      const sim = cosineSimilarity(a.centroid!, b.centroid!);
      // P2.5: link feedback shifts this app-pair's bar — boost (adj>0) lowers it,
      // demote (adj<0) raises it, so corrected pairs converge over dream cycles.
      const adj = linkAdj?.get([a.mainApp, b.mainApp].sort().join("|")) ?? 0;
      if (sim < CROSS_SIM_MIN - adj * CROSS_ADJ_SCALE) continue;
      const gap = intervalGapMin(a.start, a.end, b.start, b.end);
      if (gap > CROSS_GAP_MAX_MIN) continue;
      // deterministic src/dst order so UNIQUE(src,dst) stays stable
      const [src, dst] = a.id < b.id ? [a, b] : [b, a];
      candidates.push({
        src: src.id,
        dst: dst.id,
        srcApp: src.mainApp,
        dstApp: dst.mainApp,
        similarity: Number(sim.toFixed(4)),
        gapMin: Number(gap.toFixed(1)),
      });
    }
  }

  // 2) keep a link only if it ranks in the top-K (by similarity) of at least one
  //    endpoint. gemini-embedding-2 is anisotropic so absolute cosine is a weak
  //    discriminator; local ranking caps graph density on busy sessions.
  const byThread = new Map<string, ThreadLink[]>();
  for (const l of candidates) {
    for (const id of [l.src, l.dst]) {
      const list = byThread.get(id) ?? [];
      list.push(l);
      byThread.set(id, list);
    }
  }
  const keep = new Set<string>();
  for (const list of byThread.values()) {
    list.sort((x, y) => y.similarity - x.similarity);
    for (const l of list.slice(0, CROSS_TOPK_PER_THREAD)) keep.add(`${l.src}|${l.dst}`);
  }
  return candidates.filter((l) => keep.has(`${l.src}|${l.dst}`));
}

function persistThreadLinks(db: Database, links: ThreadLink[]): void {
  if (links.length === 0) return;
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO thread_links (src_thread, dst_thread, relation, similarity, time_gap_min, src_app, dst_app, created_at, updated_at)
    VALUES (?, ?, 'cross-surface', ?, ?, ?, ?, ?, ?)
    ON CONFLICT(src_thread, dst_thread) DO UPDATE SET
      similarity = excluded.similarity,
      time_gap_min = excluded.time_gap_min,
      src_app = excluded.src_app,
      dst_app = excluded.dst_app,
      updated_at = excluded.updated_at
  `);
  const tx = db.transaction(() => {
    for (const l of links) {
      stmt.run(l.src, l.dst, l.similarity, l.gapMin, l.srcApp, l.dstApp, now, now);
    }
  });
  tx();
}

async function links(args: string[]) {
  const limit = argNumber(args, "--limit", 20);
  const db = openDb();
  const rows = db
    .query(
      `SELECT l.id, l.src_thread, l.dst_thread, l.src_app, l.dst_app, l.similarity, l.time_gap_min, l.updated_at,
              s.label AS src_label, d.label AS dst_label
       FROM thread_links l
       LEFT JOIN episode_threads s ON s.id = l.src_thread
       LEFT JOIN episode_threads d ON d.id = l.dst_thread
       ORDER BY l.updated_at DESC
       LIMIT ?`,
    )
    .all(limit);
  db.close();
  console.log(JSON.stringify(rows, null, 2));
}

// ── Proactive outreach (P3: Background tier) ──
// After dream consolidates the trail, a small rule engine scans the freshest
// memory state and surfaces low-urgency pings via a local notify-client (macOS
// Notification Center, no sound). A dedupe ledger (notifications table, UNIQUE
// dedupe_key) guarantees each finding fires at most once, so the 30-min
// heartbeat can call this every cycle without spamming.

const NOTIFY_LINK_SIM_MIN = 0.9; // only the strongest cross-surface links earn a ping
const NOTIFY_EPISODE_SCORE_MIN = 400; // salient-episode floor (avg≈186, max≈1546 in practice)
const NOTIFY_SINCE_MIN = 35; // freshness window, slightly wider than the 30-min dream throttle
const NOTIFY_LIMIT = 5; // cap deliveries per run so a catch-up burst stays gentle

interface NotifyCandidate {
  rule: string;
  dedupeKey: string;
  title: string;
  body: string;
  payload: Record<string, unknown>;
  weight: number; // higher = surfaced first when --limit clips the batch
}

// macOS Notification Center via osascript. Background tier = quiet (no sound).
// Escapes for an AppleScript string literal and collapses newlines.
function deliverNotification(title: string, body: string): boolean {
  const esc = (s: string) =>
    `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n]+/g, " ")}"`;
  const script = `display notification ${esc(body)} with title ${esc(title)}`;
  try {
    execFileSync("osascript", ["-e", script], { timeout: 5000, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function notify(args: string[]) {
  const sinceMin = Math.max(1, argNumber(args, "--since-min", NOTIFY_SINCE_MIN));
  const limit = Math.max(1, argNumber(args, "--limit", NOTIFY_LIMIT));
  const linkSim = Number(argValue(args, "--link-sim", "")) || NOTIFY_LINK_SIM_MIN;
  const episodeScore = Number(argValue(args, "--episode-score", "")) || NOTIFY_EPISODE_SCORE_MIN;
  const dryRun = hasFlag(args, "--dry-run");
  const cutoff = new Date(Date.now() - sinceMin * 60 * 1000).toISOString();
  const db = openDb();

  const candidates: NotifyCandidate[] = [];

  // Rule 1 — cross-surface link: a fresh, high-similarity edge between two apps
  // (the P2/P2.5 graph). Noisy app pairs self-correct via `correct link:<id>
  // demote`, which prunes the edge and raises its bar next cycle.
  const linkRows = db
    .query(
      `SELECT l.src_thread, l.dst_thread, l.src_app, l.dst_app, l.similarity,
              s.label AS src_label, d.label AS dst_label
       FROM thread_links l
       LEFT JOIN episode_threads s ON s.id = l.src_thread
       LEFT JOIN episode_threads d ON d.id = l.dst_thread
       WHERE l.updated_at >= ? AND l.similarity >= ?
       ORDER BY l.similarity DESC`,
    )
    .all(cutoff, linkSim) as Array<{
    src_thread: string;
    dst_thread: string;
    src_app: string;
    dst_app: string;
    similarity: number;
    src_label: string | null;
    dst_label: string | null;
  }>;
  for (const r of linkRows) {
    const srcLabel = r.src_label || r.src_app;
    const dstLabel = r.dst_label || r.dst_app;
    // dedupe at the app-pair level, not thread-pair: two IM apps spawn many
    // near-identical edges, and the proactive signal is "these surfaces are
    // connected", which the app pair captures. One ping per cross-surface combo.
    candidates.push({
      rule: "cross-surface",
      dedupeKey: `link:${[r.src_app, r.dst_app].sort().join("|")}`,
      title: "🔗 跨 surface 关联",
      body: `${r.src_app}「${srcLabel}」↔ ${r.dst_app}「${dstLabel}」(${r.similarity.toFixed(2)})`,
      payload: { srcThread: r.src_thread, dstThread: r.dst_thread, similarity: r.similarity },
      weight: r.similarity,
    });
  }

  // Rule 2 — salient episode: a newly consolidated dream episode whose score
  // clears the floor. Episodes are insert-once (source_id UNIQUE), so updated_at
  // stays at creation time and the freshness window catches only new ones.
  const epRows = db
    .query(
      `SELECT source_id, title, score
       FROM episodes
       WHERE updated_at >= ? AND score >= ?
       ORDER BY score DESC`,
    )
    .all(cutoff, episodeScore) as Array<{ source_id: string; title: string; score: number }>;
  for (const r of epRows) {
    candidates.push({
      rule: "salient-episode",
      dedupeKey: `episode:${r.source_id}`,
      title: "🌙 高价值记忆",
      body: `${r.title}（score ${Math.round(r.score)}）`,
      payload: { sourceId: r.source_id, score: r.score },
      weight: r.score,
    });
  }

  // Collapse same-key candidates within this run (keep the highest weight), so
  // many edges of one app pair become a single ping and we never deliver twice
  // for one dedupe_key.
  const byKey = new Map<string, NotifyCandidate>();
  for (const c of candidates) {
    const prev = byKey.get(c.dedupeKey);
    if (!prev || c.weight > prev.weight) byKey.set(c.dedupeKey, c);
  }
  const collapsed = Array.from(byKey.values());

  // Drop anything already in the ledger.
  const seen = new Set(
    (db.query("SELECT dedupe_key FROM notifications").all() as Array<{ dedupe_key: string }>).map(
      (r) => r.dedupe_key,
    ),
  );
  const fresh = collapsed.filter((c) => !seen.has(c.dedupeKey));
  const suppressed = collapsed.length - fresh.length;

  // Interleave per-rule (each sorted by weight desc) round-robin under --limit.
  // link similarity (0–1) and episode score (hundreds) live on different scales,
  // so a global weight sort would let episodes starve links; round-robin keeps
  // Background-tier variety instead.
  const groups = new Map<string, NotifyCandidate[]>();
  for (const c of fresh) {
    const g = groups.get(c.rule) ?? [];
    g.push(c);
    groups.set(c.rule, g);
  }
  const lists = Array.from(groups.values());
  for (const g of lists) g.sort((a, b) => b.weight - a.weight);
  const batch: NotifyCandidate[] = [];
  for (let i = 0; batch.length < limit && lists.some((l) => l.length > 0); i++) {
    const next = lists[i % lists.length].shift();
    if (next) batch.push(next);
  }

  const insertStmt = db.prepare(
    `INSERT OR IGNORE INTO notifications (rule, dedupe_key, title, body, payload_json, created_at, delivered, delivered_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const markStmt = db.prepare("UPDATE notifications SET delivered = 1, delivered_at = ? WHERE dedupe_key = ?");

  const fired: Array<{ rule: string; dedupeKey: string; body: string; delivered: boolean }> = [];
  for (const c of batch) {
    let delivered = false;
    if (!dryRun) {
      const nowIso = new Date().toISOString();
      insertStmt.run(c.rule, c.dedupeKey, c.title, c.body, JSON.stringify(c.payload), nowIso, 0, null);
      delivered = deliverNotification(c.title, c.body);
      if (delivered) markStmt.run(nowIso, c.dedupeKey);
    }
    fired.push({ rule: c.rule, dedupeKey: c.dedupeKey, body: c.body, delivered });
  }
  db.close();

  console.log(
    JSON.stringify(
      {
        source: "agent-memory-notify",
        sinceMin,
        thresholds: { linkSim, episodeScore },
        evaluated: { links: linkRows.length, episodes: epRows.length },
        suppressed,
        fired,
        dryRun,
      },
      null,
      2,
    ),
  );
}

async function dream(args: string[]) {
  const sinceHours = Math.max(1, argNumber(args, "--since-hours", 24));
  const limit = Math.max(20, Math.min(1000, argNumber(args, "--limit", 240)));
  const dryRun = hasFlag(args, "--dry-run");
  const cutoff = new Date(Date.now() - sinceHours * 60 * 60 * 1000).toISOString();
  const embedModel = embeddingModelName();
  const db = openDb();

  const rows = db
    .query(
      `
      SELECT e.id, e.ts, e.source, e.kind, e.title, e.summary, e.content, e.url, e.cwd, e.app, e.tags_json, e.metadata_json,
             ee.vector_json
      FROM events e
      LEFT JOIN event_embeddings ee ON ee.event_id = e.id AND ee.model = ? AND ee.content_hash = e.content_hash
      WHERE e.ts >= ?
        AND e.source NOT IN ('agent-dream')
      ORDER BY e.ts ASC
      LIMIT ?
    `,
    )
    .all(embedModel, cutoff, limit) as DreamInputRow[];

  const dbThreads = db
    .query(
      `SELECT id, label, status, main_app, count, centroid_json, event_ids, start_ts, end_ts, score, created_at, closed_at
       FROM episode_threads
       WHERE status = 'open'
       ORDER BY end_ts DESC`,
    )
    .all() as Array<{
    id: string;
    label: string;
    status: string;
    main_app: string;
    count: number;
    centroid_json: string | null;
    event_ids: string;
    start_ts: string | null;
    end_ts: string | null;
    score: number;
    created_at: string;
    closed_at: string | null;
  }>;

  const existingThreads: DreamThread[] = dbThreads.map((t) => ({
    id: t.id,
    label: t.label,
    mainApp: t.main_app,
    eventIds: JSON.parse(t.event_ids || "[]"),
    start: t.start_ts || t.created_at,
    end: t.end_ts || t.created_at,
    count: t.count,
    centroid: (() => {
      try {
        return t.centroid_json ? JSON.parse(t.centroid_json) : null;
      } catch {
        return null;
      }
    })(),
    score: t.score,
    status: t.status as "open" | "closed" | "merged",
  }));

  const learned = loadLearnedWeights(db);
  const rawSegments = segmentByApp(rows, learned);
  const mergedSegments = mergeSegments(rawSegments);
  const threads = assignToThreads(mergedSegments, existingThreads);

  // Close stale threads (> 2h no activity)
  const now = new Date();
  const nowIso = now.toISOString();
  for (const thread of threads) {
    if (thread.status !== "open") continue;
    const threadEnd = new Date(thread.end);
    const idleHours = (now.getTime() - threadEnd.getTime()) / 3600000;
    if (idleHours > 2) thread.status = "closed";
  }

  // ── Step 4: LLM Episode Summary for closed threads ──
  const episodes: Array<{ threadId: string; title: string; summary: string; score: number }> = [];
  const existingEpisodeThreadIds = new Set(
    (db.query(`SELECT thread_id FROM episodes WHERE thread_id IS NOT NULL`).all() as Array<{ thread_id: string }>).map(
      (r) => r.thread_id,
    ),
  );

  // Build a lookup of event details for closed threads
  const closedThreadsForSummary = threads.filter(
    (t) => t.status === "closed" && t.count >= 3 && !existingEpisodeThreadIds.has(t.id),
  );

  if (closedThreadsForSummary.length > 0 && !dryRun) {
    // Fetch event details per thread per-thread (avoid huge IN clause)
    const getEvents = db.prepare(`SELECT id, source, kind, title, summary, url, ts FROM events WHERE id = ?`);

    for (const thread of closedThreadsForSummary) {
      const eventIds = thread.eventIds.slice(0, 50); // cap at 50 most recent events
      const threadEvents: Array<{
        id: number;
        source: string;
        kind: string;
        title: string;
        summary: string;
        url: string | null;
        ts: string;
      }> = [];

      for (const id of eventIds) {
        const row = getEvents.get(id) as { id: number; source: string; kind: string; title: string; summary: string; url: string | null; ts: string } | undefined;
        if (row) threadEvents.push(row);
      }

      if (threadEvents.length < 3) continue;

      const titles = threadEvents.map((e) => `  - [${e.source}] ${e.title || e.url || "(no title)"}`).slice(0, 15);
      const timeRange = `${thread.start.slice(0, 16)} → ${thread.end.slice(0, 16)}`;

      try {
        const { data } = await chatJson<{ title: string; summary: string }>(
          [
            {
              role: "system",
              content:
                "You are an activity summarizer. Given a list of events from a user's computer session, produce a concise episode title (≤8 words) and a one-sentence summary (≤30 words) that captures what they were doing. Respond in JSON: { \"title\": string, \"summary\": string }",
            },
            {
              role: "user",
              content: `App: ${thread.mainApp}\nTime: ${timeRange}\nEvents (${threadEvents.length}):\n${titles.join("\n")}`,
            },
          ],
          { model: "gpt-5.4-mini", temperature: 0.2 },
        );

        episodes.push({
          threadId: thread.id,
          title: data.title,
          summary: data.summary,
          score: thread.score,
        });
      } catch (err) {
        console.error(`LLM summary failed for ${thread.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // Write episodes to DB
  const upsertEpisode = db.prepare(`
    INSERT INTO episodes (source_id, thread_id, start_ts, end_ts, title, summary, score, evidence_json, metadata_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const episodeList: Array<{ threadId: string; title: string; summary: string; score: number }> = [];

  for (const ep of episodes) {
    const thread = threads.find((t) => t.id === ep.threadId);
    if (!thread) continue;
    try {
      upsertEpisode.run(
        `episode:${thread.id}`,
        thread.id,
        thread.start,
        thread.end,
        ep.title,
        ep.summary,
        ep.score,
        JSON.stringify(thread.eventIds),
        JSON.stringify({ mainApp: thread.mainApp, eventCount: thread.count }),
        nowIso,
        nowIso,
      );
      episodeList.push(ep);
    } catch (err) {
      console.error(`Episode INSERT failed for ${ep.threadId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Persist threads
  const upsertThread = db.prepare(`
    INSERT INTO episode_threads (id, label, status, main_app, count, centroid_json, event_ids, start_ts, end_ts, score, created_at, closed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      status = excluded.status,
      count = excluded.count,
      centroid_json = excluded.centroid_json,
      event_ids = excluded.event_ids,
      start_ts = excluded.start_ts,
      end_ts = excluded.end_ts,
      score = excluded.score,
      closed_at = excluded.closed_at
  `);

  for (const thread of threads) {
    const existing = dbThreads.find((t) => t.id === thread.id);
    upsertThread.run(
      thread.id,
      thread.label,
      thread.status,
      thread.mainApp,
      thread.count,
      thread.centroid ? JSON.stringify(thread.centroid) : null,
      JSON.stringify(thread.eventIds),
      thread.start,
      thread.end,
      thread.score,
      existing?.created_at || nowIso,
      thread.status === "closed" ? nowIso : null,
    );
  }

  // P2: cross-surface synthesis — link related threads across different apps
  // into a graph (central gardener). Runs after threads are persisted.
  const linkAdj = loadLinkFeedback(db);
  const crossLinks = synthesizeCrossSurface(threads, linkAdj);
  if (!dryRun) persistThreadLinks(db, crossLinks);

  const decayCandidates = rows.filter((row) => row.source === "chrome-tabs" && rowSalience(row) <= 1.5).length;
  const bySource = Array.from(
    rows.reduce((map, row) => map.set(row.source, (map.get(row.source) || 0) + 1), new Map<string, number>()),
  )
    .map(([source, count]) => ({ source, count }))
    .sort((a, b) => b.count - a.count);

  const sourceId = `dream:${nowIso.slice(0, 10)}`;
  const content = buildDreamContent({
    sinceHours,
    scanned: rows.length,
    segments: mergedSegments,
    threads,
    decayCandidates,
    bySource,
    crossLinks,
  });

  let result: "insert" | "update" | "skip" | "dry-run" = "dry-run";
  if (!dryRun && rows.length > 0) {
    result = await upsertEvent(db, {
      ts: nowIso,
      source: "agent-dream",
      sourceId,
      kind: "memory_episode",
      title: `Dream: ${nowIso.slice(0, 10)} usage trail`,
      summary: `Segmented ${rows.length} trail events into ${mergedSegments.length} segments, ${threads.length} threads (${threads.filter((t) => t.status === "open").length} open, ${threads.filter((t) => t.status === "closed").length} closed); generated ${episodeList.length} episode summaries; ${decayCandidates} low-signal raw events can decay.`,
      content,
      app: "Agent Memory",
      sensitivity: "private",
      tags: ["dream", "trail", "memory", "episode_segmentation"],
      metadata: {
        sinceHours,
        inputEvents: rows.length,
        segments: mergedSegments.length,
        threads: threads.length,
        openThreads: threads.filter((t) => t.status === "open").length,
        closedThreads: threads.filter((t) => t.status === "closed").length,
        decayCandidates,
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
        segments: mergedSegments.length,
        threads: threads.map((t) => ({
          id: t.id,
          label: t.label,
          status: t.status,
          count: t.count,
          score: t.score,
          time: `${t.start.slice(5, 19)} → ${t.end.slice(11, 19)}`,
        })),
        episodes: episodeList.map((e) => ({
          threadId: e.threadId,
          title: e.title,
          summary: e.summary,
          score: e.score,
        })),
        decayCandidates,
        crossSurfaceLinks: crossLinks,
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
      semanticModel = embeddingModelName();
      const queryVec = await embedQuery(query, { timeoutMs: argNumber(args, "--timeout-ms", 30000) });
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
  if (cmd === "correct") return correct(args);
  if (cmd === "links") return links(args);
  if (cmd === "notify") return notify(args);
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
