import { describe, expect, test } from "bun:test";

import {
  DEFAULT_FULL_PIPELINE_INTERVAL_SECONDS,
  DEFAULT_OBSERVE_INTERVAL_SECONDS,
  buildMetrics,
  planFullPipeline,
} from "./ops-runtime";

describe("ops runtime cadence", () => {
  test("uses 60s observe cadence and 30m full pipeline cadence", () => {
    expect(DEFAULT_OBSERVE_INTERVAL_SECONDS).toBe(60);
    expect(DEFAULT_FULL_PIPELINE_INTERVAL_SECONDS).toBe(30 * 60);
  });

  test("skips the full pipeline until the 30 minute window expires", () => {
    const lastFinishedAt = "2026-05-21T02:00:00.000Z";
    const plan = planFullPipeline(
      {
        fullPipeline: {
          lastFinishedAt,
          lastOk: true,
        },
      },
      Date.parse("2026-05-21T02:05:00.000Z"),
    );

    expect(plan.shouldRun).toBe(false);
    expect(plan.lastFinishedAt).toBe(lastFinishedAt);
    expect(plan.nextDueAt).toBe("2026-05-21T02:30:00.000Z");
    expect(plan.skippedReason).toBe("full_pipeline_throttled");
  });

  test("runs the full pipeline when no previous full run exists", () => {
    const plan = planFullPipeline(null, Date.parse("2026-05-21T02:05:00.000Z"));

    expect(plan.shouldRun).toBe(true);
    expect(plan.skippedReason).toBeUndefined();
  });

  test("runs the full pipeline after the 30 minute window expires", () => {
    const plan = planFullPipeline(
      {
        fullPipeline: {
          lastFinishedAt: "2026-05-21T02:00:00.000Z",
          lastOk: true,
        },
      },
      Date.parse("2026-05-21T02:30:01.000Z"),
    );

    expect(plan.shouldRun).toBe(true);
    expect(plan.nextDueAt).toBe("2026-05-21T03:00:01.000Z");
  });

  test("metrics expose last observe and last full pipeline state", () => {
    const metrics = buildMetrics({
      ok: true,
      startedAt: "2026-05-21T02:05:00.000Z",
      finishedAt: "2026-05-21T02:05:01.000Z",
      durationMs: 1000,
      observe: {
        lastOk: true,
        durationMs: 123,
        lastFinishedAt: "2026-05-21T02:05:01.000Z",
      },
      fullPipeline: {
        lastOk: false,
        lastFinishedAt: "2026-05-21T02:00:00.000Z",
      },
      stats: {
        total: 10,
        trail: {
          rawEvents: 2,
          signals: 3,
        },
      },
    });

    expect(metrics).toContain("agent_memory_observe_last_ok 1");
    expect(metrics).toContain("agent_memory_observe_duration_ms 123");
    expect(metrics).toContain("agent_memory_full_pipeline_last_ok 0");
    const fullPipelineTimestamp = Math.floor(Date.parse("2026-05-21T02:00:00.000Z") / 1000);
    expect(metrics).toContain(`agent_memory_full_pipeline_last_timestamp_seconds ${fullPipelineTimestamp}`);
  });
});
