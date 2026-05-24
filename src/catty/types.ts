// Catty v0 — core contracts for the predict → judge loop.
// See docs/catty-v0-plan.md. The model stays behind the Brain seam (model-agnostic).

/** One observed trail event (mirrors agent-memory's observe trail shape). */
export interface TrailEvent {
  ts: string; // ISO timestamp
  app: string; // foreground app
  title?: string; // window / tab title
  url?: string; // active url, if any
  kind?: string; // code | browse | chat | read | write | rest
}

/**
 * A prediction is triggered at a meaningful context switch
 * (reuses dream's app/domain segmentation idea — see ADR-0002).
 */
export interface PredictionContext {
  now: string; // ISO time the prediction is made
  recent: TrailEvent[]; // recent trail leading up to the boundary
  switchedFrom?: TrailEvent; // last event before the boundary
  switchedTo: TrailEvent; // event that opened the new segment
}

/**
 * The minimal unit of v0 is a SelfHypothesis, NOT an action label.
 * `intent` = the goal / why (not the action). See docs/catty-v0-plan.md
 * "intent 怎么定义、judge 怎么比意图".
 */
export interface SelfHypothesis {
  intent: string; // what you're really trying to push forward, and why
  nextStep: string; // likely next action / thing you'll look at / decision
  whyNow: string; // why this, now
  canPrepare: string; // what Catty could prepare / propose for you
  confidence: number; // 0..1
  source: string; // which brain produced it (provenance)
}

/** Model-agnostic seam: any brain (pi, or a stub) turns context + prompt into a hypothesis. */
export interface Brain {
  readonly name: string;
  propose(ctx: PredictionContext, prompt: string): Promise<SelfHypothesis>;
}

export interface JudgeInput {
  hypothesis: SelfHypothesis;
  predictionContext: PredictionContext;
  actualTrail: TrailEvent[];
  wasVisible: boolean;
  userFeedback?: string;
}

export interface Judgement {
  intentMatch: number; // 0..1, highest weight: did Catty understand the goal/why?
  actionMatch: number; // 0..1, did the predicted next step match later trail?
  usefulness: number; // 0..1, visible cases only get full signal; shadow can estimate prep value.
  vaguenessPenalty: number; // 0..1, broad / unfalsifiable predictions are penalized.
  nudgeRisk: number; // 0..1, visible predictions that may steer behavior are risky.
  overall: number; // intent-weighted aggregate, after penalties.
  rationale: string;
  source: string;
}

export interface Judge {
  readonly name: string;
  judge(input: JudgeInput, prompt: string): Promise<Judgement>;
}
