import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { normalizeJudgement } from "./judge";
import {
  SqliteCattyStore,
  generateDailyReport,
  judgeRecordedPrediction,
  recordPrediction,
  recordShadowPrediction,
} from "./runtime";
import type { Brain, Judge, JudgeInput, Judgement, PredictionContext, SelfHypothesis, TrailEvent } from "./types";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDbPath(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "catty-store-"));
  tempDirs.push(dir);
  return path.join(dir, "catty.sqlite");
}

const trail: TrailEvent[] = [
  { ts: "2026-05-26T08:00:00Z", app: "Cursor", title: "src/catty/runtime.ts", kind: "code" },
  { ts: "2026-05-26T08:01:00Z", app: "Google Chrome", title: "SQLite docs", url: "https://sqlite.org/lang.html", kind: "browse" },
  { ts: "2026-05-26T08:02:00Z", app: "Cursor", title: "src/catty/runtime.ts", kind: "code" },
];

class StoreBrain implements Brain {
  readonly name = "store-brain";

  async propose(ctx: PredictionContext): Promise<SelfHypothesis> {
    return {
      intent: `验证 ${ctx.switchedTo.app} 上的 SQLite 设计能否支撑 Catty shadow 记录`,
      nextStep: "把 shadow prediction 写入本地 SQLite store",
      whyNow: "刚从代码切到 SQLite 文档",
      canPrepare: "准备最小 schema 和 focused tests",
      confidence: 0.71,
      source: this.name,
    };
  }
}

class StoreJudge implements Judge {
  readonly name = "store-judge";

  async judge(input: JudgeInput): Promise<Judgement> {
    expect(input.wasVisible).toBe(false);
    expect(input.actualTrail).toHaveLength(1);
    return normalizeJudgement(
      {
        intentMatch: 0.9,
        actionMatch: 0.8,
        usefulness: 0.5,
        vaguenessPenalty: 0.05,
        nudgeRisk: 0,
        rationale: "shadow 记录抓住了持久化目标。",
      },
      this.name,
    );
  }
}

describe("SqliteCattyStore", () => {
  test("persists shadow prediction, judgement, feedback, and report inputs across instances", async () => {
    const dbPath = tempDbPath();
    const store = new SqliteCattyStore(dbPath);
    const record = await recordPrediction({
      trail,
      brain: new StoreBrain(),
      store,
      bucket: "shadow",
      now: "2026-05-26T08:01:01Z",
    });
    store.recordMemoryAudit({ accepted: 1, rejected: 2, trialHeuristics: 3 });
    store.close();

    const reopened = new SqliteCattyStore(dbPath);
    expect(reopened.listPredictions()).toHaveLength(1);
    expect(reopened.getPrediction(record.id)?.hypothesis.intent).toContain("SQLite");
    expect(reopened.getMemoryAudit()).toEqual({ accepted: 1, rejected: 2, trialHeuristics: 3 });

    await judgeRecordedPrediction({
      recordId: record.id,
      actualTrail: trail.slice(2),
      judge: new StoreJudge(),
      store: reopened,
      feedback: { correct: true, resonance: true, helpful: true, nudge: false },
    });
    reopened.close();

    const verified = new SqliteCattyStore(dbPath);
    const persisted = verified.getPrediction(record.id);
    expect(persisted?.judgement?.source).toBe("store-judge");
    expect(persisted?.feedback?.helpful).toBe(true);

    const report = generateDailyReport(verified, { date: "2026-05-26" });
    expect(report.predictions).toEqual({ total: 1, shadow: 1, visible: 0, judged: 1 });
    expect(report.memoryAudit).toEqual({ accepted: 1, rejected: 2, trialHeuristics: 3 });
    verified.close();
  });

  test("records a shadow prediction through the runtime seam without exposing bucket wiring", async () => {
    const dbPath = tempDbPath();
    const store = new SqliteCattyStore(dbPath);

    const record = await recordShadowPrediction({
      trail,
      brain: new StoreBrain(),
      store,
      now: "2026-05-26T08:01:01Z",
    });

    expect(record.bucket).toBe("shadow");
    expect(record.wasVisible).toBe(false);
    expect(store.getPrediction(record.id)?.context.switchedTo.app).toBe("Google Chrome");
    store.close();
  });
});
