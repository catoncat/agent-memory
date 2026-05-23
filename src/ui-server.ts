#!/usr/bin/env bun

import { Database } from "bun:sqlite";
import { existsSync, readFileSync, mkdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dir, "..");
const STATIC_DIR = path.join(ROOT, "ui");
const MEMORY_ROOT = process.env.AGENT_MEMORY_ROOT || path.join(homedir(), ".agents", "memory");
const EVENT_DB = path.join(MEMORY_ROOT, "indexes", "events.sqlite");
const STATUS_PATH = path.join(MEMORY_ROOT, "runtime", "status.json");
const METRICS_PATH = path.join(MEMORY_ROOT, "runtime", "metrics.prom");
const X_BOOKMARK_DB = path.join(ROOT, "tools", "data", "opencli-twitter", "bookmarks.sqlite");
const LABEL = process.env.AGENT_MEMORY_UI_LAUNCHD_LABEL || "com.envvar.agent-memory-ui";
const PLIST_PATH = path.join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const LOG_DIR = path.join(homedir(), "Library", "Logs", "agent-memory");

type JsonRecord = Record<string, unknown>;

function usage(exitCode = 0): never {
  const text = `Usage:
  agent-memory-ui [--port 4799] [--host 127.0.0.1]
  agent-memory-ui install-wrappers
  agent-memory-ui install-launchd [--port 4799]
  agent-memory-ui uninstall-launchd

Default:
  http://127.0.0.1:4799
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
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function json(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...(init?.headers || {}),
    },
  });
}

function problem(status: number, message: string, detail?: unknown): Response {
  return json({ ok: false, error: message, detail }, { status });
}

function readJsonFile(file: string): JsonRecord | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function parsePrometheusMetrics(raw: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of raw.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const [name, value] = line.trim().split(/\s+/, 2);
    const n = Number(value);
    if (name && Number.isFinite(n)) out[name] = n;
  }
  return out;
}

function readMetrics(): Record<string, number> {
  if (!existsSync(METRICS_PATH)) return {};
  try {
    return parsePrometheusMetrics(readFileSync(METRICS_PATH, "utf8"));
  } catch {
    return {};
  }
}

function openEventDb(): Database {
  if (!existsSync(EVENT_DB)) throw new Error(`event db not found: ${EVENT_DB}`);
  const db = new Database(EVENT_DB, { readonly: true });
  db.run("PRAGMA busy_timeout=5000");
  return db;
}

function openBookmarkDb(): Database {
  if (!existsSync(X_BOOKMARK_DB)) throw new Error(`bookmark db not found: ${X_BOOKMARK_DB}`);
  const db = new Database(X_BOOKMARK_DB);
  db.run("PRAGMA busy_timeout=5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS x_bookmark_reader_state (
      id TEXT PRIMARY KEY,
      is_read INTEGER NOT NULL DEFAULT 0,
      starred INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      tags_json TEXT NOT NULL DEFAULT '[]',
      note TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_x_bookmark_state_read ON x_bookmark_reader_state(is_read);
    CREATE INDEX IF NOT EXISTS idx_x_bookmark_state_starred ON x_bookmark_reader_state(starred);
    CREATE INDEX IF NOT EXISTS idx_x_bookmark_state_archived ON x_bookmark_reader_state(archived);
  `);
  return db;
}

function buildFtsQuery(raw: string): string {
  const tokens = Array.from(new Set(String(raw).match(/[\p{L}\p{N}_-]+/gu) || []))
    .map((token) => token.trim())
    .filter(Boolean)
    .slice(0, 12);
  return tokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(" ");
}

function normalizeLimit(raw: string | null, fallback = 80, max = 300): number {
  const n = raw ? Number(raw) : fallback;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(max, Math.trunc(n)));
}

function parseJsonArray(raw: unknown): string[] {
  try {
    const parsed = JSON.parse(String(raw || "[]")) as unknown;
    return Array.isArray(parsed) ? parsed.map((item) => String(item)).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function eventStats(db: Database): JsonRecord {
  const total = db.query("SELECT COUNT(*) AS c FROM events").get() as { c: number };
  const ftsRows = db.query("SELECT COUNT(*) AS c FROM events_fts").get() as { c: number };
  const semanticRows = db
    .query(
      `
      SELECT COUNT(DISTINCT ee.event_id) AS c
      FROM event_embeddings ee
      JOIN events e ON e.id = ee.event_id
      WHERE ee.content_hash = e.content_hash
    `,
    )
    .get() as { c: number };
  const bySource = db
    .query("SELECT source, COUNT(*) AS count FROM events GROUP BY source ORDER BY count DESC")
    .all();
  const byKind = db.query("SELECT kind, COUNT(*) AS count FROM events GROUP BY kind ORDER BY count DESC").all();
  const newest = db.query("SELECT ts, source, kind, title, url FROM events ORDER BY ts DESC LIMIT 1").get();
  return { total: total.c, ftsRows: ftsRows.c, semanticRows: semanticRows.c, bySource, byKind, newest };
}

function bookmarkStats(): JsonRecord {
  if (!existsSync(X_BOOKMARK_DB)) return { ok: false, total: 0 };
  const db = openBookmarkDb();
  try {
    const row = db
      .query(
        `
        SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN COALESCE(s.archived, 0) = 0 THEN 1 ELSE 0 END) AS inbox,
          SUM(CASE WHEN COALESCE(s.archived, 0) = 0 AND COALESCE(s.is_read, 0) = 0 THEN 1 ELSE 0 END) AS unread,
          SUM(CASE WHEN COALESCE(s.starred, 0) = 1 THEN 1 ELSE 0 END) AS starred,
          SUM(CASE WHEN COALESCE(s.archived, 0) = 1 THEN 1 ELSE 0 END) AS archived,
          SUM(CASE WHEN COALESCE(i.media_urls_json, '[]') NOT IN ('[]', '', 'null') THEN 1 ELSE 0 END) AS media
        FROM x_bookmark_items i
        LEFT JOIN x_bookmark_reader_state s ON s.id = i.id
      `,
      )
      .get() as Record<string, number | null>;
    return Object.fromEntries(Object.entries({ ok: true, ...row }).map(([key, value]) => [key, value ?? 0]));
  } finally {
    db.close();
  }
}

function mapEvent(row: JsonRecord): JsonRecord {
  return {
    ...row,
    tags: parseJsonArray(row.tags_json),
    metadata: (() => {
      try {
        return JSON.parse(String(row.metadata_json || "{}"));
      } catch {
        return {};
      }
    })(),
  };
}

function listEvents(url: URL): Response {
  const q = (url.searchParams.get("q") || "").trim();
  const source = (url.searchParams.get("source") || "all").trim();
  const limit = normalizeLimit(url.searchParams.get("limit"), 80, 500);
  const db = openEventDb();
  try {
    const sourceWhere = source !== "all" ? " AND e.source = $source" : "";
    const sourceParam = source !== "all" ? { $source: source } : {};
    if (q) {
      const fts = buildFtsQuery(q);
      if (fts) {
        try {
          const rows = db
            .query(
              `
              SELECT e.id, e.ts, e.source, e.kind, e.title, e.summary, e.content, e.url, e.cwd,
                     e.tags_json, e.metadata_json,
                     bm25(events_fts, 5.0, 3.0, 1.0, 0.8, 0.8, 0.6, 0.6, 0.5) AS rank,
                     snippet(events_fts, 2, '', '', '...', 24) AS snippet,
                     'fts' AS match_mode
              FROM events_fts
              JOIN events e ON e.id = events_fts.rowid
              WHERE events_fts MATCH $fts ${sourceWhere}
              ORDER BY rank ASC, e.ts DESC
              LIMIT $limit
            `,
            )
            .all({ $fts: fts, $limit: limit, ...sourceParam }) as JsonRecord[];
          if (rows.length > 0) return json({ ok: true, mode: "fts", items: rows.map(mapEvent) });
        } catch {
          // Fall through to LIKE.
        }
      }

      const like = `%${q.replace(/[%_]/g, " ")}%`;
      const rows = db
        .query(
          `
          SELECT e.id, e.ts, e.source, e.kind, e.title, e.summary, e.content, e.url, e.cwd,
                 e.tags_json, e.metadata_json, 'like' AS match_mode
          FROM events e
          WHERE (e.title LIKE $like OR e.summary LIKE $like OR e.content LIKE $like OR e.url LIKE $like OR e.cwd LIKE $like)
          ${sourceWhere}
          ORDER BY e.ts DESC
          LIMIT $limit
        `,
        )
        .all({ $like: like, $limit: limit, ...sourceParam }) as JsonRecord[];
      return json({ ok: true, mode: "like", items: rows.map(mapEvent) });
    }

    const rows = db
      .query(
        `
        SELECT e.id, e.ts, e.source, e.kind, e.title, e.summary, e.content, e.url, e.cwd,
               e.tags_json, e.metadata_json, 'recent' AS match_mode
        FROM events e
        WHERE 1 = 1 ${sourceWhere}
        ORDER BY e.ts DESC
        LIMIT $limit
      `,
      )
      .all({ $limit: limit, ...sourceParam }) as JsonRecord[];
    return json({ ok: true, mode: "recent", items: rows.map(mapEvent) });
  } finally {
    db.close();
  }
}

function contextSearch(url: URL): Response {
  const q = (url.searchParams.get("q") || "").trim();
  if (!q) return problem(400, "missing q");
  const limit = String(normalizeLimit(url.searchParams.get("limit"), 8, 20));
  const result = spawnSync("agent-memory", ["context", q, "--semantic", "--local", "--limit", limit], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 20_000,
    maxBuffer: 5 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    return problem(500, "context failed", result.error?.message || result.stderr || result.stdout);
  }
  try {
    return json({ ok: true, data: JSON.parse(result.stdout) });
  } catch {
    return problem(500, "context returned non-json", result.stdout);
  }
}

function listDreams(url: URL): Response {
  const limit = normalizeLimit(url.searchParams.get("limit"), 12, 80);
  const db = openEventDb();
  try {
    const rows = db
      .query(
        `
        SELECT e.id, e.ts, e.source, e.kind, e.title, e.summary, e.content, e.url, e.cwd,
               e.tags_json, e.metadata_json, 'dream' AS match_mode
        FROM events e
        WHERE e.source = 'agent-dream'
        ORDER BY e.ts DESC
        LIMIT $limit
      `,
      )
      .all({ $limit: limit }) as JsonRecord[];
    return json({ ok: true, items: rows.map(mapEvent) });
  } finally {
    db.close();
  }
}

async function runDream(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as JsonRecord;
  const sinceHours = Math.max(1, Math.min(168, Number(body.sinceHours || 24)));
  const limit = Math.max(20, Math.min(1000, Number(body.limit || 240)));
  const dream = spawnSync("agent-memory", ["dream", "--since-hours", String(sinceHours), "--limit", String(limit)], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  const output = [dream.stdout, dream.stderr].filter(Boolean).join("\n").trim();
  if (dream.error || dream.status !== 0) {
    return problem(500, "dream failed", dream.error?.message || output || `exit=${dream.status ?? "unknown"}`);
  }
  spawnSync("agent-memory", ["embed", "--local", "--limit", "80"], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 30_000,
  });
  try {
    return json({ ok: true, data: JSON.parse(dream.stdout) });
  } catch {
    return json({ ok: true, output });
  }
}

function listBookmarks(url: URL): Response {
  if (!existsSync(X_BOOKMARK_DB)) return json({ ok: true, items: [], stats: bookmarkStats(), missing: true });
  const q = (url.searchParams.get("q") || "").trim().toLowerCase();
  const filter = url.searchParams.get("filter") || "inbox";
  const sort = url.searchParams.get("sort") || "saved_desc";
  const limit = normalizeLimit(url.searchParams.get("limit"), 120, 500);
  const db = openBookmarkDb();
  try {
    const where = ["1=1"];
    const params: JsonRecord = { $limit: limit };
    if (q) {
      params.$q = `%${q}%`;
      where.push(`
        (LOWER(COALESCE(i.text, '')) LIKE $q
          OR LOWER(COALESCE(i.author, '')) LIKE $q
          OR LOWER(COALESCE(i.name, '')) LIKE $q
          OR LOWER(COALESCE(i.url, '')) LIKE $q)
      `);
    }
    if (filter === "unread") where.push("COALESCE(s.is_read, 0) = 0 AND COALESCE(s.archived, 0) = 0");
    else if (filter === "starred") where.push("COALESCE(s.starred, 0) = 1");
    else if (filter === "archived") where.push("COALESCE(s.archived, 0) = 1");
    else if (filter === "media") where.push("COALESCE(i.media_urls_json, '[]') NOT IN ('[]', '', 'null') AND COALESCE(s.archived, 0) = 0");
    else if (filter === "inbox") where.push("COALESCE(s.archived, 0) = 0");

    const orderBy =
      {
        saved_asc: "DATETIME(i.first_seen_at) ASC, DATETIME(i.created_at) ASC",
        tweet_desc: "DATETIME(i.created_at) DESC, DATETIME(i.first_seen_at) DESC",
        popular: "COALESCE(i.likes, 0) + COALESCE(i.retweets, 0) * 3 + COALESCE(i.bookmarks, 0) * 5 DESC",
        author: "LOWER(COALESCE(i.author, i.name, '')) ASC, DATETIME(i.first_seen_at) DESC",
      }[sort] || "DATETIME(i.first_seen_at) DESC, DATETIME(i.created_at) DESC";

    const rows = db
      .query(
        `
        SELECT i.id, i.url, i.author, i.name, i.text, i.likes, i.retweets, i.bookmarks,
               i.created_at, i.has_media, i.media_urls_json, i.first_seen_at, i.last_seen_at,
               COALESCE(s.is_read, 0) AS is_read,
               COALESCE(s.starred, 0) AS starred,
               COALESCE(s.archived, 0) AS archived,
               COALESCE(s.tags_json, '[]') AS tags_json,
               COALESCE(s.note, '') AS note
        FROM x_bookmark_items i
        LEFT JOIN x_bookmark_reader_state s ON s.id = i.id
        WHERE ${where.join(" AND ")}
        ORDER BY ${orderBy}
        LIMIT $limit
      `,
      )
      .all(params) as JsonRecord[];
    return json({
      ok: true,
      stats: bookmarkStats(),
      items: rows.map((row) => ({
        ...row,
        likes: Number(row.likes || 0),
        retweets: Number(row.retweets || 0),
        bookmarks: Number(row.bookmarks || 0),
        has_media: Boolean(row.has_media),
        media_urls: parseJsonArray(row.media_urls_json),
        is_read: Boolean(row.is_read),
        starred: Boolean(row.starred),
        archived: Boolean(row.archived),
        tags: parseJsonArray(row.tags_json),
      })),
    });
  } finally {
    db.close();
  }
}

async function updateBookmarkState(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as JsonRecord;
  const id = String(body.id || "").trim();
  if (!id) return problem(400, "missing id");
  const db = openBookmarkDb();
  try {
    const current = db
      .query("SELECT id, is_read, starred, archived, tags_json, note FROM x_bookmark_reader_state WHERE id = $id")
      .get({ $id: id }) as JsonRecord | null;
    const next = {
      is_read: "is_read" in body ? (body.is_read ? 1 : 0) : Number(current?.is_read || 0),
      starred: "starred" in body ? (body.starred ? 1 : 0) : Number(current?.starred || 0),
      archived: "archived" in body ? (body.archived ? 1 : 0) : Number(current?.archived || 0),
      tags_json: "tags" in body ? JSON.stringify(Array.isArray(body.tags) ? body.tags : []) : String(current?.tags_json || "[]"),
      note: "note" in body ? String(body.note || "") : String(current?.note || ""),
    };
    db.query(
      `
      INSERT INTO x_bookmark_reader_state (id, is_read, starred, archived, tags_json, note, updated_at)
      VALUES ($id, $is_read, $starred, $archived, $tags_json, $note, $updated_at)
      ON CONFLICT(id) DO UPDATE SET
        is_read = excluded.is_read,
        starred = excluded.starred,
        archived = excluded.archived,
        tags_json = excluded.tags_json,
        note = excluded.note,
        updated_at = excluded.updated_at
    `,
    ).run({
      $id: id,
      $is_read: next.is_read,
      $starred: next.starred,
      $archived: next.archived,
      $tags_json: next.tags_json,
      $note: next.note,
      $updated_at: new Date().toISOString(),
    });
    return json({ ok: true, stats: bookmarkStats() });
  } finally {
    db.close();
  }
}

function runCommand(command: string, args: string[], timeoutMs: number): Response {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 20 * 1024 * 1024,
  });
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  if (result.error || result.status !== 0) {
    return problem(500, `${command} failed`, result.error?.message || output || `exit=${result.status ?? "unknown"}`);
  }
  return json({ ok: true, output });
}

async function refreshMemory(): Promise<Response> {
  return runCommand("agent-memory-ops", ["status", "--live"], 120_000);
}

async function syncBookmarks(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as JsonRecord;
  const limit = Math.max(1, Math.min(1000, Number(body.limit || 100)));
  const sync = spawnSync("bun", ["tools/x-bookmark-sync-opencli.ts", "--limit", String(limit), "--db", X_BOOKMARK_DB], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 5 * 60 * 1000,
    maxBuffer: 20 * 1024 * 1024,
  });
  const output = [sync.stdout, sync.stderr].filter(Boolean).join("\n").trim();
  if (sync.error || sync.status !== 0) {
    return problem(500, "bookmark sync failed", sync.error?.message || output || `exit=${sync.status ?? "unknown"}`);
  }
  spawnSync("agent-memory", ["refresh", "--x-limit", String(limit), "--limit-files", "1", "--tab-limit", "1"], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 30_000,
  });
  spawnSync("agent-memory", ["embed", "--local", "--limit", "300"], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 30_000,
  });
  return json({ ok: true, output, stats: bookmarkStats() });
}

function overview(): Response {
  let stats: JsonRecord = { total: 0, ftsRows: 0, semanticRows: 0, bySource: [], byKind: [] };
  try {
    const db = openEventDb();
    try {
      stats = eventStats(db);
    } finally {
      db.close();
    }
  } catch (error) {
    stats = { error: error instanceof Error ? error.message : String(error) };
  }
  const status = readJsonFile(STATUS_PATH);
  const metrics = readMetrics();
  return json({
    ok: true,
    memoryRoot: MEMORY_ROOT,
    eventDb: EVENT_DB,
    bookmarkDb: X_BOOKMARK_DB,
    stats,
    bookmarkStats: bookmarkStats(),
    status,
    metrics,
  });
}

async function serveStatic(pathname: string): Promise<Response> {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  if (safePath.includes("..")) return problem(400, "bad path");
  const filePath = path.join(STATIC_DIR, safePath);
  if (!existsSync(filePath)) return problem(404, "not found");
  const type =
    {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "application/javascript; charset=utf-8",
      ".svg": "image/svg+xml",
      ".png": "image/png",
    }[path.extname(filePath)] || "application/octet-stream";
  return new Response(Bun.file(filePath), { headers: { "content-type": type, "cache-control": "no-store" } });
}

function installWrappers() {
  const targets = [path.join(homedir(), ".agents", "bin"), path.join(homedir(), ".local", "bin")];
  for (const dir of targets) {
    mkdirSync(dir, { recursive: true });
    const target = path.join(dir, "agent-memory-ui");
    if (existsSync(target)) unlinkSync(target);
    symlinkSync(import.meta.path, target);
  }
  console.log(JSON.stringify({ ok: true, targets: targets.map((dir) => path.join(dir, "agent-memory-ui")) }, null, 2));
}

function commandPath(): string {
  return [
    path.join(homedir(), ".agents", "bin"),
    path.join(homedir(), ".local", "bin"),
    path.join(homedir(), ".bun", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ].join(":");
}

function guiTarget(): string {
  return `gui/${process.getuid?.() || Number(spawnSync("id", ["-u"], { encoding: "utf8" }).stdout.trim())}`;
}

function launchdPlist(port: number, host: string): string {
  const bun = process.env.BUN_PATH || path.join(homedir(), ".bun", "bin", "bun");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${LABEL}</string>

    <key>ProgramArguments</key>
    <array>
      <string>${bun}</string>
      <string>${import.meta.path}</string>
      <string>--host</string>
      <string>${host}</string>
      <string>--port</string>
      <string>${port}</string>
    </array>

    <key>WorkingDirectory</key>
    <string>${ROOT}</string>

    <key>EnvironmentVariables</key>
    <dict>
      <key>HOME</key>
      <string>${homedir()}</string>
      <key>PATH</key>
      <string>${commandPath()}</string>
      <key>AGENT_MEMORY_ROOT</key>
      <string>${MEMORY_ROOT}</string>
      <key>NO_COLOR</key>
      <string>1</string>
    </dict>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>StandardOutPath</key>
    <string>${path.join(LOG_DIR, "ui.out.log")}</string>

    <key>StandardErrorPath</key>
    <string>${path.join(LOG_DIR, "ui.err.log")}</string>
  </dict>
</plist>
`;
}

function installLaunchd(args: string[]) {
  const port = Math.max(1, Math.min(65535, argNumber(args, "--port", Number(process.env.AGENT_MEMORY_UI_PORT || 4799))));
  const host = argValue(args, "--host", process.env.AGENT_MEMORY_UI_HOST || "127.0.0.1");
  mkdirSync(path.dirname(PLIST_PATH), { recursive: true });
  mkdirSync(LOG_DIR, { recursive: true });
  writeFileSync(PLIST_PATH, launchdPlist(port, host), "utf8");
  spawnSync("launchctl", ["bootout", guiTarget(), PLIST_PATH], { stdio: "ignore" });
  const bootstrap = spawnSync("launchctl", ["bootstrap", guiTarget(), PLIST_PATH], { encoding: "utf8" });
  if (bootstrap.status !== 0) {
    console.error(bootstrap.stderr || bootstrap.stdout || "launchctl bootstrap failed");
    process.exit(2);
  }
  const kick = spawnSync("launchctl", ["kickstart", "-k", `${guiTarget()}/${LABEL}`], { encoding: "utf8" });
  if (kick.status !== 0) {
    console.error(kick.stderr || kick.stdout || "launchctl kickstart failed");
    process.exit(2);
  }
  console.log(JSON.stringify({ ok: true, label: LABEL, plistPath: PLIST_PATH, url: `http://${host}:${port}` }, null, 2));
}

function uninstallLaunchd() {
  spawnSync("launchctl", ["bootout", guiTarget(), PLIST_PATH], { stdio: "ignore" });
  if (existsSync(PLIST_PATH)) unlinkSync(PLIST_PATH);
  console.log(JSON.stringify({ ok: true, label: LABEL, removed: PLIST_PATH }, null, 2));
}

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  try {
    if (url.pathname === "/api/overview") return overview();
    if (url.pathname === "/api/events") return listEvents(url);
    if (url.pathname === "/api/context") return contextSearch(url);
    if (url.pathname === "/api/dream" && req.method === "GET") return listDreams(url);
    if (url.pathname === "/api/dream" && req.method === "POST") return runDream(req);
    if (url.pathname === "/api/bookmarks") return listBookmarks(url);
    if (url.pathname === "/api/bookmark-state" && req.method === "POST") return updateBookmarkState(req);
    if (url.pathname === "/api/refresh" && req.method === "POST") return refreshMemory();
    if (url.pathname === "/api/bookmark-sync" && req.method === "POST") return syncBookmarks(req);
    if (url.pathname === "/api/health") return json({ ok: true });
    if (url.pathname.startsWith("/api/")) return problem(404, "not found");
    return serveStatic(url.pathname);
  } catch (error) {
    return problem(500, error instanceof Error ? error.message : String(error));
  }
}

async function main() {
  const [cmd, ...rest] = Bun.argv.slice(2);
  if (cmd === "--help" || cmd === "-h") usage(0);
  if (cmd === "install-wrappers") return installWrappers();
  if (cmd === "install-launchd") return installLaunchd(rest);
  if (cmd === "uninstall-launchd") return uninstallLaunchd();
  const args = cmd ? [cmd, ...rest] : rest;
  const port = Math.max(1, Math.min(65535, argNumber(args, "--port", Number(process.env.AGENT_MEMORY_UI_PORT || 4799))));
  const host = argValue(args, "--host", process.env.AGENT_MEMORY_UI_HOST || "127.0.0.1");
  const server = Bun.serve({ hostname: host, port, fetch: handle });
  console.log(`Agent Memory UI: http://${server.hostname}:${server.port}`);
  console.log(`Events: ${EVENT_DB}`);
  console.log(`Bookmarks: ${X_BOOKMARK_DB}`);
  await new Promise(() => {});
}

await main();
