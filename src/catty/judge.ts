// Catty v0 - independent judge seam for scoring a self hypothesis against later trail.

import { completeSimple, type Api, type AssistantMessage, type Context, type Model } from "@earendil-works/pi-ai";
import { trailSurface } from "./trail";
import type { Judge, JudgeInput, Judgement, TrailEvent } from "./types";

function fmtEvent(e: TrailEvent): string {
  const tail = [e.title, e.url].filter(Boolean).join(" · ");
  return `- ${e.ts} ${trailSurface(e)}${tail ? " · " + tail : ""}`;
}

export function buildJudgePrompt(input: JudgeInput): string {
  const h = input.hypothesis;
  return [
    "你是 Catty v0 的独立 judge agent。你不是预测者，不能自评自夸；只按实际后续轨迹打分。",
    "",
    "Rubric（所有分项 0..1）：",
    "- intent match: 预测是否抓住用户此刻在推进的目标 / 为什么；这是最高权重。",
    "- action match: nextStep 是否贴近实际后续动作 / 查看对象 / 决策。",
    "- usefulness: 如果展示给用户，它是否能顺手准备有用信息；shadow 样本只能估计准备价值。",
    "- vagueness penalty: 预测是否过宽、不可证伪、像「继续工作」这种废话。",
    "- nudge risk: visible 情况下是否可能把用户带偏、操控或污染后续行为；shadow 通常为 0。",
    "",
    input.wasVisible ? "展示状态：visible" : "展示状态：shadow",
    input.userFeedback ? `用户反馈：${input.userFeedback}` : "",
    "",
    "预判上下文：",
    input.predictionContext.switchedFrom ? `刚从：${fmtEvent(input.predictionContext.switchedFrom)}` : "",
    `切到：${fmtEvent(input.predictionContext.switchedTo)}`,
    "预测前最近轨迹：",
    input.predictionContext.recent.map(fmtEvent).join("\n"),
    "",
    "Self hypothesis：",
    `intent: ${h.intent}`,
    `nextStep: ${h.nextStep}`,
    `whyNow: ${h.whyNow}`,
    `canPrepare: ${h.canPrepare}`,
    `confidence: ${h.confidence}`,
    `source: ${h.source}`,
    "",
    "实际后续轨迹：",
    input.actualTrail.length > 0 ? input.actualTrail.map(fmtEvent).join("\n") : "- (无后续轨迹)",
    "",
    '仅输出 JSON：{"intentMatch":0,"actionMatch":0,"usefulness":0,"vaguenessPenalty":0,"nudgeRisk":0,"rationale":""}',
  ]
    .filter(Boolean)
    .join("\n");
}

function clamp01(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

export function normalizeJudgement(raw: Record<string, unknown>, source = String(raw.source ?? "judge")): Judgement {
  const intentMatch = clamp01(raw.intentMatch);
  const actionMatch = clamp01(raw.actionMatch);
  const usefulness = clamp01(raw.usefulness);
  const vaguenessPenalty = clamp01(raw.vaguenessPenalty);
  const nudgeRisk = clamp01(raw.nudgeRisk);
  const overall = clamp01(
    intentMatch * 0.6 +
      actionMatch * 0.2 +
      usefulness * 0.15 -
      vaguenessPenalty * 0.35 -
      nudgeRisk * 0.2,
  );

  return {
    intentMatch,
    actionMatch,
    usefulness,
    vaguenessPenalty,
    nudgeRisk,
    overall: Number(overall.toFixed(4)),
    rationale: String(raw.rationale ?? ""),
    source,
  };
}

export async function judgeHypothesis(input: JudgeInput, judge: Judge): Promise<Judgement> {
  const prompt = buildJudgePrompt(input);
  return judge.judge(input, prompt);
}

export class StubJudge implements Judge {
  readonly name = "stub-judge";

  async judge(_input: JudgeInput): Promise<Judgement> {
    return normalizeJudgement(
      {
        intentMatch: 0,
        actionMatch: 0,
        usefulness: 0,
        vaguenessPenalty: 1,
        nudgeRisk: 0,
        rationale: "[STUB] 无模型，不能语义判断 hypothesis 是否命中。",
      },
      this.name,
    );
  }
}

function extractText(msg: AssistantMessage): string {
  return msg.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("")
    .trim();
}

function parseJsonObject(text: string): Record<string, unknown> {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error(`PiJudge: 模型没返回 JSON。原文片段：${text.slice(0, 200)}`);
  }
  return JSON.parse(text.slice(start, end + 1));
}

export class PiJudge implements Judge {
  readonly name = "pi-judge";

  async judge(_input: JudgeInput, prompt: string): Promise<Judgement> {
    const baseUrl = process.env.AI_BASE_URL ?? process.env.OPENAI_API_BASE;
    const apiKey = process.env.AI_API_KEY ?? process.env.OPENAI_API_KEY;
    const modelId = process.env.CATTY_JUDGE_MODEL ?? process.env.CATTY_MODEL ?? process.env.AI_MODEL_BALANCED ?? process.env.AI_MODEL;
    if (!baseUrl || !apiKey || !modelId) {
      throw new Error(
        "PiJudge 需要 env：AI_BASE_URL + AI_API_KEY + CATTY_JUDGE_MODEL(或 CATTY_MODEL/AI_MODEL_BALANCED)。" +
          "用你的 cliproxy 注入，例如：envchain mom bun src/catty/spike.ts --real --pi --judge",
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
      systemPrompt: "你是 Catty v0 的独立 judge agent。严格按要求只输出一个 JSON 对象，不要任何额外文字。",
      messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
    };

    const msg = await completeSimple(model, context, { apiKey, temperature: 0.1, maxTokens: 700 });
    return normalizeJudgement(parseJsonObject(extractText(msg)), `pi-judge:${model.provider}/${model.id}`);
  }
}
