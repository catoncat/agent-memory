#!/usr/bin/env bun
// Catty v0 — Spike A: prove the predict pipe end-to-end on a recorded trail.
//   bun src/catty/spike.ts                  # StubBrain + sample trail
//   bun src/catty/spike.ts --real           # StubBrain + real raw_events
//   envchain mom bun src/catty/spike.ts --real --pi   # PiBrain + real raw_events

import { predictNextStep } from "./predict";
import { StubBrain, PiBrain } from "./brain";
import { SAMPLE_TRAIL } from "./sample-trail";
import { buildPredictionContext, DEFAULT_EVENTS_DB, loadTrailFromEventsDb, trailSurface } from "./trail";

function argValue(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

const useRealTrail = process.argv.includes("--real");
const brain = process.argv.includes("--pi") ? new PiBrain() : new StubBrain();
const dbPath = argValue("--db") ?? DEFAULT_EVENTS_DB;
const limit = positiveInt(argValue("--limit"), 80);
const trail = useRealTrail ? loadTrailFromEventsDb({ dbPath, limit }) : SAMPLE_TRAIL;
const ctx = buildPredictionContext(trail);
const hypothesis = await predictNextStep(ctx, brain);

console.log(
  JSON.stringify(
    {
      brain: brain.name,
      trail: { source: useRealTrail ? "raw_events" : "sample", events: trail.length, dbPath: useRealTrail ? dbPath : undefined },
      contextSwitch: {
        from: ctx.switchedFrom ? trailSurface(ctx.switchedFrom) : undefined,
        to: trailSurface(ctx.switchedTo),
        at: ctx.now,
      },
      hypothesis,
    },
    null,
    2,
  ),
);
