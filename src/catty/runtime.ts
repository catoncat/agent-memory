import { judgeHypothesis } from "./judge";
import { predictNextStep } from "./predict";
import { buildPredictionCase } from "./trail";
import type { Brain, Judge, Judgement, PredictionContext, SelfHypothesis, TrailEvent } from "./types";

export type PredictionBucket = "shadow" | "visible";

export type CattyFeedback = {
  correct: boolean;
  resonance: boolean;
  helpful: boolean;
  nudge: boolean;
  note?: string;
};

export type PredictionRecord = {
  id: string;
  createdAt: string;
  bucket: PredictionBucket;
  wasVisible: boolean;
  context: PredictionContext;
  hypothesis: SelfHypothesis;
  actualTrail?: TrailEvent[];
  judgement?: Judgement;
  feedback?: CattyFeedback;
};

export type MemoryAudit = {
  accepted: number;
  rejected: number;
  trialHeuristics: number;
};

export type MemoryCandidate = {
  claim: string;
  evidence: string[];
  scope: string;
  expiry: string;
  confidence: number;
  failureFixed: string;
};

export type AcceptedMemory = MemoryCandidate & {
  id: string;
  kind: "user-prior";
};

export type MemoryAdmissionResult =
  | { status: "accepted"; memory: AcceptedMemory; reason?: undefined }
  | { status: "rejected"; memory?: undefined; reason: string };

export type DailyReport = {
  date: string;
  predictions: {
    total: number;
    shadow: number;
    visible: number;
    judged: number;
  };
  scores: {
    intentWeightedAverage: number;
  };
  hardestMisses: PredictionRecord[];
  broadPredictionRate: number;
  memoryAudit: MemoryAudit;
  visibleHelpfulness: {
    visible: number;
    helpful: number;
    negativeFeedback: number;
    nudgeReports: number;
  };
};

const EMPTY_MEMORY_AUDIT: MemoryAudit = { accepted: 0, rejected: 0, trialHeuristics: 0 };

export class InMemoryCattyStore {
  private predictions: PredictionRecord[] = [];
  private memoryAudit: MemoryAudit = { ...EMPTY_MEMORY_AUDIT };
  private nextPredictionId = 1;

  addPrediction(input: Omit<PredictionRecord, "id">): PredictionRecord {
    const record = { ...input, id: `pred_${this.nextPredictionId++}` };
    this.predictions.push(record);
    return record;
  }

  getPrediction(id: string): PredictionRecord | undefined {
    return this.predictions.find((record) => record.id === id);
  }

  listPredictions(): PredictionRecord[] {
    return [...this.predictions];
  }

  updatePrediction(id: string, patch: Partial<PredictionRecord>): PredictionRecord {
    const record = this.getPrediction(id);
    if (!record) {
      throw new Error(`Catty prediction not found: ${id}`);
    }
    Object.assign(record, patch);
    return record;
  }

  recordMemoryAudit(audit: MemoryAudit): void {
    this.memoryAudit = { ...audit };
  }

  getMemoryAudit(): MemoryAudit {
    return { ...this.memoryAudit };
  }
}

export async function recordPrediction(input: {
  trail: TrailEvent[];
  brain: Brain;
  store: InMemoryCattyStore;
  bucket: PredictionBucket;
  now?: string;
}): Promise<PredictionRecord> {
  const predictionCase = buildPredictionCase(input.trail);
  const context = {
    ...predictionCase.context,
    now: input.now ?? predictionCase.context.now,
  };
  const hypothesis = await predictNextStep(context, input.brain);
  return input.store.addPrediction({
    createdAt: context.now,
    bucket: input.bucket,
    wasVisible: input.bucket === "visible",
    context,
    hypothesis,
  });
}

export async function judgeRecordedPrediction(input: {
  recordId: string;
  actualTrail: TrailEvent[];
  judge: Judge;
  store: InMemoryCattyStore;
  feedback?: CattyFeedback;
}): Promise<PredictionRecord> {
  const record = input.store.getPrediction(input.recordId);
  if (!record) {
    throw new Error(`Catty prediction not found: ${input.recordId}`);
  }

  const judgement = await judgeHypothesis(
    {
      hypothesis: record.hypothesis,
      predictionContext: record.context,
      actualTrail: input.actualTrail,
      wasVisible: record.wasVisible,
      userFeedback: input.feedback ? formatFeedback(input.feedback) : undefined,
    },
    input.judge,
  );

  return input.store.updatePrediction(input.recordId, {
    actualTrail: input.actualTrail,
    judgement,
    feedback: input.feedback,
  });
}

export function generateDailyReport(store: InMemoryCattyStore, input: { date: string }): DailyReport {
  const records = store.listPredictions().filter((record) => record.createdAt.startsWith(input.date));
  const judged = records.filter((record) => record.judgement);
  const visible = records.filter((record) => record.wasVisible);
  const broadCount = judged.filter((record) => (record.judgement?.vaguenessPenalty ?? 0) >= 0.5).length;
  const hardestMisses = judged
    .filter((record) => (record.judgement?.overall ?? 0) < 0.35)
    .sort((a, b) => (a.judgement?.overall ?? 0) - (b.judgement?.overall ?? 0));

  return {
    date: input.date,
    predictions: {
      total: records.length,
      shadow: records.filter((record) => record.bucket === "shadow").length,
      visible: visible.length,
      judged: judged.length,
    },
    scores: {
      intentWeightedAverage: average(judged.map((record) => record.judgement?.overall ?? 0)),
    },
    hardestMisses,
    broadPredictionRate: judged.length === 0 ? 0 : broadCount / judged.length,
    memoryAudit: store.getMemoryAudit(),
    visibleHelpfulness: {
      visible: visible.length,
      helpful: visible.filter((record) => record.feedback?.helpful).length,
      negativeFeedback: visible.filter((record) => isNegativeFeedback(record.feedback)).length,
      nudgeReports: visible.filter((record) => record.feedback?.nudge).length,
    },
  };
}

export function admitMemoryCandidate(candidate: MemoryCandidate): MemoryAdmissionResult {
  if (looksLikeTrialHeuristic(candidate)) {
    return {
      status: "rejected",
      reason: "app/domain shortcut remains a trial heuristic until it is proven as a user prior",
    };
  }

  if (!candidate.claim.trim() || candidate.evidence.length === 0 || !candidate.scope.trim()) {
    return { status: "rejected", reason: "memory candidate needs claim, evidence, and scope" };
  }
  if (!candidate.expiry.trim() || !candidate.failureFixed.trim()) {
    return { status: "rejected", reason: "memory candidate needs expiry and failure fixed" };
  }
  if (!Number.isFinite(candidate.confidence) || candidate.confidence <= 0 || candidate.confidence > 1) {
    return { status: "rejected", reason: "memory candidate confidence must be in 0..1" };
  }

  return {
    status: "accepted",
    memory: {
      ...candidate,
      id: stableMemoryId(candidate),
      kind: "user-prior",
    },
  };
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(4));
}

function formatFeedback(feedback: CattyFeedback): string {
  return [
    `correct=${feedback.correct}`,
    `resonance=${feedback.resonance}`,
    `helpful=${feedback.helpful}`,
    `nudge=${feedback.nudge}`,
    feedback.note ? `note=${feedback.note}` : "",
  ]
    .filter(Boolean)
    .join("; ");
}

function isNegativeFeedback(feedback: CattyFeedback | undefined): boolean {
  if (!feedback) return false;
  return !feedback.correct || !feedback.resonance || !feedback.helpful || feedback.nudge;
}

function looksLikeTrialHeuristic(candidate: MemoryCandidate): boolean {
  const text = `${candidate.claim} ${candidate.scope} ${candidate.failureFixed}`.toLowerCase();
  if (text.includes("app sequence") || text.includes("app prediction") || text.includes("hit rate")) {
    return true;
  }
  return /\b(chrome|cursor|safari|terminal|finder|slack|wechat)\b.*(后|回到|->|then|next)/i.test(text);
}

function stableMemoryId(candidate: MemoryCandidate): string {
  let hash = 0;
  for (const ch of `${candidate.claim}|${candidate.scope}|${candidate.expiry}`) {
    hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  }
  return `mem_${hash.toString(16)}`;
}
