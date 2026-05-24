import { expect, test } from "bun:test";
import { buildPredictionCase, buildPredictionContext, trailSurface } from "./trail";
import type { TrailEvent } from "./types";

test("buildPredictionContext uses the last app switch as the trigger", () => {
  const trail: TrailEvent[] = [
    { ts: "2026-05-24T08:00:00Z", app: "Cursor", title: "main.ts" },
    { ts: "2026-05-24T08:01:00Z", app: "Cursor", title: "main.ts" },
    { ts: "2026-05-24T08:02:00Z", app: "Chrome", title: "sqlite-vec", url: "https://github.com/asg017/sqlite-vec" },
  ];

  const ctx = buildPredictionContext(trail);

  expect(ctx.now).toBe("2026-05-24T08:02:00Z");
  expect(ctx.switchedFrom?.app).toBe("Cursor");
  expect(ctx.switchedTo.app).toBe("Chrome");
});

test("buildPredictionContext treats browser domain changes as triggers", () => {
  const trail: TrailEvent[] = [
    { ts: "2026-05-24T08:00:00Z", app: "Google Chrome", title: "A", url: "https://example.com/a" },
    { ts: "2026-05-24T08:01:00Z", app: "Google Chrome", title: "B", url: "https://example.com/b" },
    { ts: "2026-05-24T08:02:00Z", app: "Google Chrome", title: "C", url: "https://github.com/org/repo" },
  ];

  const ctx = buildPredictionContext(trail);

  expect(ctx.switchedFrom?.url).toBe("https://example.com/b");
  expect(ctx.switchedTo.url).toBe("https://github.com/org/repo");
  expect(trailSurface(ctx.switchedTo)).toBe("Google Chrome@github.com");
});

test("buildPredictionContext rejects an empty trail", () => {
  expect(() => buildPredictionContext([])).toThrow("at least one trail event");
});

test("buildPredictionCase can reserve later events as actual trail for judging", () => {
  const trail: TrailEvent[] = [
    { ts: "2026-05-24T08:00:00Z", app: "Cursor", title: "dream.ts" },
    { ts: "2026-05-24T08:01:00Z", app: "Google Chrome", title: "sqlite-vec", url: "https://github.com/asg017/sqlite-vec" },
    { ts: "2026-05-24T08:02:00Z", app: "Google Chrome", title: "sqlite-vec source", url: "https://github.com/asg017/sqlite-vec/tree/main/rust" },
    { ts: "2026-05-24T08:03:00Z", app: "Cursor", title: "dream.ts" },
  ];

  const sample = buildPredictionCase(trail, { minActualEvents: 1 });

  expect(sample.context.now).toBe("2026-05-24T08:01:00Z");
  expect(sample.context.switchedTo.app).toBe("Google Chrome");
  expect(sample.actualTrail.map((event) => event.app)).toEqual(["Google Chrome", "Cursor"]);
});
