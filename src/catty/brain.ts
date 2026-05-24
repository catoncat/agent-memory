// Catty v0 — Brain implementations behind the model-agnostic seam.
// StubBrain proves the pipe without a model. PiBrain drives a real model via pi-ai + cliproxy.

import { completeSimple, type Api, type AssistantMessage, type Context, type Model } from "@earendil-works/pi-ai";
import type { Brain, PredictionContext, SelfHypothesis } from "./types";

/**
 * Wiring-only stub. Proves predict → brain → output end-to-end with NO model / NO creds.
 * Zero prediction intelligence on purpose (confidence 0, "[STUB]" fields) — do NOT grow
 * real logic here; the intelligence belongs in PiBrain.
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

function extractText(msg: AssistantMessage): string {
  return msg.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("")
    .trim();
}

/** Tolerant: models sometimes wrap JSON in prose / code fences. Grab the outermost object. */
function parseHypothesisJson(text: string): Record<string, unknown> {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error(`PiBrain: 模型没返回 JSON。原文片段：${text.slice(0, 200)}`);
  }
  return JSON.parse(text.slice(start, end + 1));
}

/**
 * Real brain. Model-agnostic via pi-ai: build a Model pointed at the user's cliproxy
 * (OpenAI-compatible by default) and call completeSimple. Creds come from env only —
 * never hard-coded, never logged.
 *
 * Required env (inject via cliproxy, e.g. `envchain mom bun src/catty/spike.ts --pi`):
 *   AI_BASE_URL  (or OPENAI_API_BASE)   — cliproxy base url
 *   AI_API_KEY   (or OPENAI_API_KEY)    — cliproxy key
 *   CATTY_MODEL  (or AI_MODEL_BALANCED / AI_MODEL)  — model id
 * Optional: CATTY_PI_API (default "openai-completions"), CATTY_PI_PROVIDER (default "cliproxy").
 */
export class PiBrain implements Brain {
  readonly name = "pi";

  async propose(_ctx: PredictionContext, prompt: string): Promise<SelfHypothesis> {
    const baseUrl = process.env.AI_BASE_URL ?? process.env.OPENAI_API_BASE;
    const apiKey = process.env.AI_API_KEY ?? process.env.OPENAI_API_KEY;
    const modelId = process.env.CATTY_MODEL ?? process.env.AI_MODEL_BALANCED ?? process.env.AI_MODEL;
    if (!baseUrl || !apiKey || !modelId) {
      throw new Error(
        "PiBrain 需要 env：AI_BASE_URL + AI_API_KEY + CATTY_MODEL(或 AI_MODEL_BALANCED)。" +
          "用你的 cliproxy 注入，例如：envchain mom bun src/catty/spike.ts --pi",
      );
    }

    const model: Model<Api> = {
      id: modelId,
      name: modelId,
      api: (process.env.CATTY_PI_API ?? "openai-completions") as Api,
      provider: process.env.CATTY_PI_PROVIDER ?? "cliproxy",
      baseUrl,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 8192,
    };

    const context: Context = {
      systemPrompt: "你是用户的「第二自我」。严格按要求只输出一个 JSON 对象，不要任何额外文字。",
      messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
    };

    const msg = await completeSimple(model, context, { apiKey, temperature: 0.3, maxTokens: 800 });
    const j = parseHypothesisJson(extractText(msg));

    return {
      intent: String(j.intent ?? ""),
      nextStep: String(j.nextStep ?? ""),
      whyNow: String(j.whyNow ?? ""),
      canPrepare: String(j.canPrepare ?? ""),
      confidence: Number(j.confidence ?? 0),
      source: `pi:${model.provider}/${model.id}`,
    };
  }
}
