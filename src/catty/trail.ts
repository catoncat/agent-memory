// Catty v0 - trail input and context-switch trigger helpers.
// This stays separate from src/main.ts so Spike B can reuse runtime data without
// growing the old monolith.

import { Database } from "bun:sqlite";
import path from "node:path";
import type { PredictionContext, TrailEvent } from "./types";

const DEFAULT_LIMIT = 80;
const CONTEXT_WINDOW = 8;
const TIME_GAP_BOUNDARY_MS = 30 * 60 * 1000;

export const DEFAULT_EVENTS_DB = path.join(Bun.env.HOME ?? "", ".agents", "memory", "indexes", "events.sqlite");

type RawEventRow = {
  id: number;
  ts: string;
  source: string;
  action: string;
  app: string | null;
  window_title: string | null;
  title: string;
  url: string | null;
};

export type LoadTrailOptions = {
  dbPath?: string;
  limit?: number;
};

function hostFromUrl(raw: string | undefined): string {
  if (!raw) return "";
  try {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
    return new URL(withScheme).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function rawEventToTrailEvent(row: RawEventRow): TrailEvent {
  const app = row.app || hostFromUrl(row.url ?? undefined) || row.source;
  return {
    ts: row.ts,
    app,
    title: row.title || row.window_title || row.action,
    url: row.url ?? undefined,
    kind: row.action,
  };
}

export function trailSurface(event: TrailEvent): string {
  const host = hostFromUrl(event.url);
  return host ? `${event.app}@${host}` : event.app;
}

function boundaryKey(event: TrailEvent): string {
  return trailSurface(event).toLowerCase();
}

function isTimeGapBoundary(previous: TrailEvent, current: TrailEvent): boolean {
  const gapMs = new Date(current.ts).getTime() - new Date(previous.ts).getTime();
  return Number.isFinite(gapMs) && gapMs > TIME_GAP_BOUNDARY_MS;
}

export function buildPredictionContext(trail: TrailEvent[], recentWindow = CONTEXT_WINDOW): PredictionContext {
  if (trail.length === 0) {
    throw new Error("Catty needs at least one trail event to build a prediction context.");
  }

  let idx = trail.length - 1;
  for (let i = trail.length - 1; i > 0; i -= 1) {
    const current = trail[i];
    const previous = trail[i - 1];
    if (!current || !previous) continue;
    if (boundaryKey(current) !== boundaryKey(previous) || isTimeGapBoundary(previous, current)) {
      idx = i;
      break;
    }
  }

  const switchedTo = trail[idx];
  if (!switchedTo) {
    throw new Error("Catty failed to select a prediction boundary from the trail.");
  }

  return {
    now: switchedTo.ts,
    recent: trail.slice(Math.max(0, idx - recentWindow + 1), idx + 1),
    switchedFrom: idx > 0 ? trail[idx - 1] : undefined,
    switchedTo,
  };
}

export function loadTrailFromEventsDb(options: LoadTrailOptions = {}): TrailEvent[] {
  const dbPath = options.dbPath ?? DEFAULT_EVENTS_DB;
  const limit = Math.max(1, Math.floor(options.limit ?? DEFAULT_LIMIT));
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db
      .query(
        `
        SELECT id, ts, source, action, app, window_title, title, url
        FROM raw_events
        WHERE source = 'observer' AND action = 'active_focus'
        ORDER BY ts DESC
        LIMIT ?
      `,
      )
      .all(limit) as RawEventRow[];

    return rows.reverse().map(rawEventToTrailEvent);
  } finally {
    db.close();
  }
}
