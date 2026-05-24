import { expect, test } from "bun:test";
import { buildJudgePrompt, normalizeJudgement } from "./judge";
import { buildPredictionCase } from "./trail";
import type { JudgeInput, SelfHypothesis, TrailEvent } from "./types";

const trail: TrailEvent[] = [
  { ts: "2026-05-24T08:00:00Z", app: "Cursor", title: "dream.ts" },
  { ts: "2026-05-24T08:01:00Z", app: "Google Chrome", title: "sqlite-vec", url: "https://github.com/asg017/sqlite-vec" },
  { ts: "2026-05-24T08:02:00Z", app: "Google Chrome", title: "sqlite-vec source", url: "https://github.com/asg017/sqlite-vec/tree/main/rust" },
  { ts: "2026-05-24T08:03:00Z", app: "Cursor", title: "dream.ts" },
];

const hypothesis: SelfHypothesis = {
  intent: "验证 dream merge 的 embedding 合并方案是否走得通",
  nextStep: "阅读 sqlite-vec 的实现，然后回到 dream.ts 收口合并逻辑",
  whyNow: "刚从代码切到 sqlite-vec 文档",
  canPrepare: "打开相关源码和当前 dream 分段逻辑",
  confidence: 0.74,
  source: "pi:test",
};

test("buildJudgePrompt anchors rubric to hypothesis and actual subsequent trail", () => {
  const sample = buildPredictionCase(trail, { minActualEvents: 1 });
  const input: JudgeInput = {
    hypothesis,
    predictionContext: sample.context,
    actualTrail: sample.actualTrail,
    wasVisible: false,
  };

  const prompt = buildJudgePrompt(input);

  expect(prompt).toContain("独立 judge agent");
  expect(prompt).toContain("intent match");
  expect(prompt).toContain("action match");
  expect(prompt).toContain("usefulness");
  expect(prompt).toContain("vagueness penalty");
  expect(prompt).toContain("nudge risk");
  expect(prompt).toContain(hypothesis.intent);
  expect(prompt).toContain("实际后续轨迹");
  expect(prompt).toContain("Cursor · dream.ts");
});

test("normalizeJudgement clamps rubric fields and computes intent-weighted overall", () => {
  const judgement = normalizeJudgement({
    intentMatch: 1.2,
    actionMatch: 0.4,
    usefulness: 0.5,
    vaguenessPenalty: 0.2,
    nudgeRisk: -0.4,
    rationale: "意图抓对，动作只部分命中。",
    source: "test",
  });

  expect(judgement.intentMatch).toBe(1);
  expect(judgement.nudgeRisk).toBe(0);
  expect(judgement.overall).toBeCloseTo(0.685, 3);
  expect(judgement.source).toBe("test");
});
