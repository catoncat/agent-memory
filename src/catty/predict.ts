// Catty v0 — the predictor. Assembles the self-hypothesis prompt and asks the brain.
// The prompt IS the product logic (it tells the agent how to form a hypothesis);
// the brain (pi / stub) just executes it. See docs/catty-v0-plan.md.

import type { Brain, PredictionContext, SelfHypothesis } from "./types";

function fmtEvent(e: { ts: string; app: string; title?: string; url?: string }): string {
  const tail = [e.title, e.url].filter(Boolean).join(" · ");
  return `- ${e.ts} ${e.app}${tail ? " · " + tail : ""}`;
}

/** Builds the contract prompt. Enforces "intent = goal/why, not action" + the 4 required fields. */
export function buildPrompt(ctx: PredictionContext): string {
  return [
    "你是用户的「第二自我」。基于下面的活动轨迹，输出一条 self hypothesis——",
    "你对「用户现在真正想推进什么」的理解，而不是猜下一个动作标签。",
    "",
    "规则（docs/catty-v0-plan.md）：",
    "- intent = 用户此刻在推进的*目标 / 为什么*，不是动作本身。",
    "- 必须同时给出 intent / nextStep / whyNow / canPrepare，缺一不可。",
    "- 宁可窄而可证伪，也不要宽到「会继续工作」这种废话。",
    "",
    `现在：${ctx.now}`,
    ctx.switchedFrom ? `刚从：${fmtEvent(ctx.switchedFrom)}` : "",
    `切到：${fmtEvent(ctx.switchedTo)}`,
    "最近轨迹：",
    ctx.recent.map(fmtEvent).join("\n"),
    "",
    "仅输出 JSON：{\"intent\":\"\",\"nextStep\":\"\",\"whyNow\":\"\",\"canPrepare\":\"\",\"confidence\":0.0}",
  ]
    .filter(Boolean)
    .join("\n");
}

export async function predictNextStep(
  ctx: PredictionContext,
  brain: Brain,
): Promise<SelfHypothesis> {
  const prompt = buildPrompt(ctx);
  return brain.propose(ctx, prompt);
}
