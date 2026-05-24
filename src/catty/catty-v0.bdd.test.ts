import { describe, expect, test } from "bun:test";
import { normalizeJudgement } from "./judge";
import {
  InMemoryCattyStore,
  admitMemoryCandidate,
  generateDailyReport,
  judgeRecordedPrediction,
  recordPrediction,
} from "./runtime";
import type { Brain, Judge, JudgeInput, Judgement, PredictionContext, SelfHypothesis, TrailEvent } from "./types";

const morningTrail: TrailEvent[] = [
  { ts: "2026-05-24T08:00:00Z", app: "Cursor", title: "src/main.ts", kind: "code" },
  { ts: "2026-05-24T08:01:00Z", app: "Cursor", title: "src/main.ts", kind: "code" },
  { ts: "2026-05-24T08:02:00Z", app: "Google Chrome", title: "sqlite-vec", url: "https://github.com/asg017/sqlite-vec", kind: "browse" },
  { ts: "2026-05-24T08:03:00Z", app: "Google Chrome", title: "sqlite-vec source", url: "https://github.com/asg017/sqlite-vec/tree/main/rust", kind: "browse" },
  { ts: "2026-05-24T08:04:00Z", app: "Cursor", title: "src/main.ts", kind: "code" },
];

class ScenarioBrain implements Brain {
  readonly name = "scenario-brain";

  async propose(ctx: PredictionContext): Promise<SelfHypothesis> {
    return {
      intent: `确认 ${ctx.switchedTo.app} 上的资料是否能帮助收口 dream merge`,
      nextStep: "阅读 sqlite-vec 实现后回到代码里改 merge 判断",
      whyNow: "刚从代码切到 sqlite-vec 资料",
      canPrepare: "打开 dream 分段代码和 sqlite-vec 相关源码",
      confidence: 0.72,
      source: this.name,
    };
  }
}

class ScenarioJudge implements Judge {
  readonly name = "scenario-judge";

  async judge(input: JudgeInput): Promise<Judgement> {
    expect(input.actualTrail.map((event) => event.app)).toEqual(["Google Chrome", "Cursor"]);
    return normalizeJudgement(
      {
        intentMatch: 0.8,
        actionMatch: 0.65,
        usefulness: input.wasVisible ? 0.7 : 0.45,
        vaguenessPenalty: 0.05,
        nudgeRisk: input.wasVisible ? 0.2 : 0,
        rationale: "意图抓到了，动作部分命中；visible 时有轻微带路风险。",
      },
      this.name,
    );
  }
}

describe("Feature: Catty v0 product architecture", () => {
  test("Scenario: a context switch creates a shadow self hypothesis record without nudging the user", async () => {
    const store = new InMemoryCattyStore();

    const record = await recordPrediction({
      trail: morningTrail,
      brain: new ScenarioBrain(),
      store,
      bucket: "shadow",
      now: "2026-05-24T08:02:01Z",
    });

    expect(record.bucket).toBe("shadow");
    expect(record.wasVisible).toBe(false);
    expect(record.context.switchedTo.app).toBe("Google Chrome");
    expect(record.hypothesis.intent).toContain("dream merge");
    expect(store.listPredictions()).toHaveLength(1);
    expect(store.listPredictions()[0]?.judgement).toBeUndefined();
  });

  test("Scenario: an independent judge scores the hypothesis against actual later trail", async () => {
    const store = new InMemoryCattyStore();
    const record = await recordPrediction({
      trail: morningTrail,
      brain: new ScenarioBrain(),
      store,
      bucket: "shadow",
      now: "2026-05-24T08:02:01Z",
    });

    const judged = await judgeRecordedPrediction({
      recordId: record.id,
      actualTrail: morningTrail.slice(3),
      judge: new ScenarioJudge(),
      store,
    });

    expect(judged.judgement?.intentMatch).toBe(0.8);
    expect(judged.judgement?.actionMatch).toBe(0.65);
    expect(judged.judgement?.overall).toBeGreaterThan(0.5);
    expect(store.getPrediction(record.id)?.judgement?.source).toBe("scenario-judge");
  });

  test("Scenario: daily report exposes the v0 anti-drift audit surfaces", async () => {
    const store = new InMemoryCattyStore();
    const shadow = await recordPrediction({
      trail: morningTrail,
      brain: new ScenarioBrain(),
      store,
      bucket: "shadow",
      now: "2026-05-24T08:02:01Z",
    });
    await judgeRecordedPrediction({
      recordId: shadow.id,
      actualTrail: morningTrail.slice(3),
      judge: new ScenarioJudge(),
      store,
    });

    const visible = await recordPrediction({
      trail: morningTrail,
      brain: new ScenarioBrain(),
      store,
      bucket: "visible",
      now: "2026-05-24T08:10:00Z",
    });
    await judgeRecordedPrediction({
      recordId: visible.id,
      actualTrail: morningTrail.slice(3),
      judge: new ScenarioJudge(),
      store,
      feedback: { correct: true, resonance: true, helpful: false, nudge: true, note: "有点带我走" },
    });

    store.recordMemoryAudit({ accepted: 1, rejected: 1, trialHeuristics: 1 });
    const report = generateDailyReport(store, { date: "2026-05-24" });

    expect(report.date).toBe("2026-05-24");
    expect(report.predictions.total).toBe(2);
    expect(report.scores.intentWeightedAverage).toBeGreaterThan(0.5);
    expect(report.hardestMisses).toHaveLength(0);
    expect(report.broadPredictionRate).toBeLessThan(0.1);
    expect(report.memoryAudit).toEqual({ accepted: 1, rejected: 1, trialHeuristics: 1 });
    expect(report.visibleHelpfulness).toEqual({ visible: 1, helpful: 0, negativeFeedback: 1, nudgeReports: 1 });
  });

  test("Scenario: memory admission accepts falsifiable user priors and rejects app shortcut memories", () => {
    const accepted = admitMemoryCandidate({
      claim: "当用户从实现代码切去底层库源码时，通常是在验证当前方案是否可行，而不是换任务。",
      evidence: ["prediction:shadow:1", "episode:dream-merge"],
      scope: "coding/debugging research loops",
      expiry: "2026-06-24",
      confidence: 0.62,
      failureFixed: "之前把读源码误判成离开当前任务。",
    });

    const shortcut = admitMemoryCandidate({
      claim: "Google Chrome 后通常会回到 Cursor。",
      evidence: ["raw_event:chrome", "raw_event:cursor"],
      scope: "app sequence",
      expiry: "2026-06-24",
      confidence: 0.9,
      failureFixed: "提高 app prediction hit rate。",
    });

    expect(accepted.status).toBe("accepted");
    expect(accepted.memory?.kind).toBe("user-prior");
    expect(shortcut.status).toBe("rejected");
    expect(shortcut.reason).toContain("trial heuristic");
  });
});
