// Catty v0 — Brain implementations behind the model-agnostic seam.
// StubBrain proves the pipe without a model. PiBrain is where the real agent plugs in.

import type { Brain, PredictionContext, SelfHypothesis } from "./types";

/**
 * Wiring-only stub. Proves predict → brain → output end-to-end with NO model / NO creds.
 * It contains zero prediction intelligence (confidence 0, "[STUB]" fields) on purpose —
 * do NOT grow real logic here; replace it with PiBrain.
 */
export class StubBrain implements Brain {
  readonly name = "stub";
  async propose(ctx: PredictionContext): Promise<SelfHypothesis> {
    const to = ctx.switchedTo;
    return {
      intent: `[STUB] 无模型，无法推断意图（刚切到 ${to.app}）`,
      nextStep: "[STUB] —",
      whyNow: "[STUB] —",
      canPrepare: "[STUB] —",
      confidence: 0,
      source: "stub",
    };
  }
}

/**
 * Real brain: drives pi with `streamFn` pointed at the user's cliproxy (model-agnostic).
 * Skeleton — fill in once pi is installed and cliproxy creds are available:
 *
 *   bun add @earendil-works/pi-agent-core @earendil-works/pi-ai
 *   # then: build an Agent / createAgentSession, set streamFn → cliproxy,
 *   #       run one turn on `prompt`, parse the JSON SelfHypothesis from the turn.
 *
 * Run with creds, e.g.:  envchain mom bun src/catty/spike.ts --pi
 */
export class PiBrain implements Brain {
  readonly name = "pi";
  async propose(_ctx: PredictionContext, _prompt: string): Promise<SelfHypothesis> {
    throw new Error(
      "PiBrain 未接线：安装 pi、把 streamFn 指向 cliproxy、跑一轮后从 agent 输出里解析 SelfHypothesis JSON。见 docs/catty-v0-plan.md。",
    );
  }
}
