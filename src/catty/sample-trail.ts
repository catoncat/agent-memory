// Catty v0 — a recorded sample trail for the Spike A wiring test.
// Mirrors the dream-merge-bug morning: Cursor → Chrome (sqlite-vec) → back to Cursor.
// The Chrome→Cursor return is the "context switch" the predictor triggers on.

import type { TrailEvent } from "./types";

export const SAMPLE_TRAIL: TrailEvent[] = [
  { ts: "2026-05-24T09:14:00Z", app: "Cursor", title: "agent-memory/src/dream.ts", kind: "code" },
  { ts: "2026-05-24T09:31:00Z", app: "Cursor", title: "agent-memory/src/dream.ts", kind: "code" },
  { ts: "2026-05-24T09:48:00Z", app: "Chrome", title: "sqlite-vec readme", url: "github.com/asg017/sqlite-vec", kind: "browse" },
  { ts: "2026-05-24T09:55:00Z", app: "Chrome", title: "sqlite-vec rust source", url: "github.com/asg017/sqlite-vec/tree/main/rust", kind: "browse" },
  { ts: "2026-05-24T10:05:00Z", app: "Cursor", title: "agent-memory/src/dream.ts", kind: "code" },
];
