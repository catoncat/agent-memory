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

export type PredictionCaseOptions = {
  minActualEvents?: number;
  maxActualEvents?: number;
  recentWindow?: number;
};

export type PredictionCase = {
  context: PredictionContext;
  actualTrail: TrailEvent[];
  boundaryIndex: number;
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

function isBoundaryAt(trail: TrailEvent[], idx: number): boolean {
  if (idx <= 0) return false;
  const current = trail[idx];
  const previous = trail[idx - 1];
  if (!current || !previous) return false;
  return boundaryKey(current) !== boundaryKey(previous) || isTimeGapBoundary(previous, current);
}

function contextAt(trail: TrailEvent[], idx: number, recentWindow = CONTEXT_WINDOW): PredictionContext {
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

export function buildPredictionContext(trail: TrailEvent[], recentWindow = CONTEXT_WINDOW): PredictionContext {
  if (trail.length === 0) {
    throw new Error("Catty needs at least one trail event to build a prediction context.");
  }

  let idx = trail.length - 1;
  for (let i = trail.length - 1; i > 0; i -= 1) {
    if (isBoundaryAt(trail, i)) {
      idx = i;
      break;
    }
  }

  return contextAt(trail, idx, recentWindow);
}

export function buildPredictionCase(trail: TrailEvent[], options: PredictionCaseOptions = {}): PredictionCase {
  if (trail.length === 0) {
    throw new Error("Catty needs at least one trail event to build a prediction case.");
  }

  const minActualEvents = Math.max(0, Math.floor(options.minActualEvents ?? 1));
  const maxBoundaryIndex = trail.length - minActualEvents - 1;
  if (maxBoundaryIndex < 0) {
    throw new Error("Catty needs enough later trail events to judge a prediction.");
  }

  let idx = maxBoundaryIndex;
  for (let i = maxBoundaryIndex; i > 0; i -= 1) {
    if (isBoundaryAt(trail, i)) {
      idx = i;
      break;
    }
  }

  const actualEnd = options.maxActualEvents ? idx + 1 + Math.max(1, Math.floor(options.maxActualEvents)) : undefined;
  return {
    context: contextAt(trail, idx, options.recentWindow),
    actualTrail: trail.slice(idx + 1, actualEnd),
    boundaryIndex: idx,
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
