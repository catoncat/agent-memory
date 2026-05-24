#!/usr/bin/env bun
// Catty v0 — Spike A: prove the predict pipe end-to-end on a recorded trail.
//   bun src/catty/spike.ts          # StubBrain (no model/creds; proves wiring)
//   envchain mom bun src/catty/spike.ts --pi   # PiBrain (real, once pi is wired)

import { predictNextStep } from "./predict";
import { StubBrain, PiBrain } from "./brain";
import { SAMPLE_TRAIL } from "./sample-trail";
import type { PredictionContext, TrailEvent } from "./types";

/** Find the last app-change in the trail = a prediction trigger (proxy for dream segmentation). */
function lastSwitchContext(trail: TrailEvent[]): PredictionContext {
  let idx = trail.length - 1;
  for (let i = trail.length - 1; i > 0; i--) {
    if (trail[i].app !== trail[i - 1].app) {
      idx = i;
      break;
    }
  }
  return {
    now: trail[idx].ts,
    recent: trail.slice(Math.max(0, idx - 6), idx + 1),
    switchedFrom: idx > 0 ? trail[idx - 1] : undefined,
    switchedTo: trail[idx],
  };
}

const brain = process.argv.includes("--pi") ? new PiBrain() : new StubBrain();
const ctx = lastSwitchContext(SAMPLE_TRAIL);
const hypothesis = await predictNextStep(ctx, brain);

console.log(
  JSON.stringify(
    {
      brain: brain.name,
      contextSwitch: { from: ctx.switchedFrom?.app, to: ctx.switchedTo.app, at: ctx.now },
      hypothesis,
    },
    null,
    2,
  ),
);
