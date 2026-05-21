export type JsonRecord = Record<string, unknown>;

export type FullPipelineSnapshot = {
  lastStartedAt?: string;
  lastFinishedAt?: string;
  lastOk?: boolean;
  durationMs?: number;
};

export type FullPipelinePlan = FullPipelineSnapshot & {
  shouldRun: boolean;
  intervalSeconds: number;
  nextDueAt: string;
  skippedReason?: string;
};

export const DEFAULT_OBSERVE_INTERVAL_SECONDS = 60;
export const DEFAULT_FULL_PIPELINE_INTERVAL_SECONDS = 30 * 60;
export const FULL_PIPELINE_THROTTLED_REASON = "full_pipeline_throttled";

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function isoString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return Number.isFinite(Date.parse(value)) ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function timestampSeconds(value: unknown): number {
  const iso = isoString(value);
  if (!iso) return 0;
  const timestamp = Date.parse(iso) / 1000;
  return Number.isFinite(timestamp) ? Math.floor(timestamp) : 0;
}

function boolMetric(value: unknown): number {
  return value === true ? 1 : 0;
}

export function summarizePreviousFullPipeline(status: JsonRecord | null | undefined): FullPipelineSnapshot | null {
  const record = asRecord(status);
  if (!Object.keys(record).length) return null;

  const fullPipeline = asRecord(record.fullPipeline);
  const lastFinishedAt = isoString(fullPipeline.lastFinishedAt);
  if (lastFinishedAt) {
    return {
      lastStartedAt: isoString(fullPipeline.lastStartedAt),
      lastFinishedAt,
      lastOk: typeof fullPipeline.lastOk === "boolean" ? fullPipeline.lastOk : undefined,
      durationMs: optionalNumber(fullPipeline.durationMs),
    };
  }

  const steps = asRecord(record.steps);
  const hasLegacyFullPipeline = ["refresh", "dream", "embed", "doctor"].some(
    (step) => Object.keys(asRecord(steps[step])).length > 0,
  );
  const legacyFinishedAt = isoString(record.finishedAt);
  if (!hasLegacyFullPipeline || !legacyFinishedAt) return null;

  return {
    lastStartedAt: isoString(record.startedAt),
    lastFinishedAt: legacyFinishedAt,
    lastOk: typeof record.ok === "boolean" ? record.ok : undefined,
    durationMs: optionalNumber(record.durationMs),
  };
}

export function planFullPipeline(
  previousStatus: JsonRecord | null | undefined,
  nowMs = Date.now(),
  intervalMs = DEFAULT_FULL_PIPELINE_INTERVAL_SECONDS * 1000,
): FullPipelinePlan {
  const intervalSeconds = Math.round(intervalMs / 1000);
  const previous = summarizePreviousFullPipeline(previousStatus);
  const nextIfRun = new Date(nowMs + intervalMs).toISOString();
  if (!previous?.lastFinishedAt) {
    return {
      shouldRun: true,
      intervalSeconds,
      nextDueAt: nextIfRun,
    };
  }

  const lastFinishedMs = Date.parse(previous.lastFinishedAt);
  if (!Number.isFinite(lastFinishedMs)) {
    return {
      ...previous,
      shouldRun: true,
      intervalSeconds,
      nextDueAt: nextIfRun,
    };
  }

  const dueMs = lastFinishedMs + intervalMs;
  if (nowMs >= dueMs) {
    return {
      ...previous,
      shouldRun: true,
      intervalSeconds,
      nextDueAt: nextIfRun,
    };
  }

  return {
    ...previous,
    shouldRun: false,
    intervalSeconds,
    nextDueAt: new Date(dueMs).toISOString(),
    skippedReason: FULL_PIPELINE_THROTTLED_REASON,
  };
}

export function buildMetrics(status: JsonRecord): string {
  const stats = asRecord(status.stats);
  const trail = asRecord(stats.trail);
  const steps = asRecord(status.steps);
  const observeStep = asRecord(steps.observe);
  const observe = asRecord(status.observe);
  const fullPipeline = asRecord(status.fullPipeline);
  const lastRunAt = timestampSeconds(status.finishedAt || status.startedAt);
  const observeFinishedAt = observe.lastFinishedAt || observeStep.finishedAt || status.finishedAt;
  const observeOk = typeof observe.lastOk === "boolean" ? observe.lastOk : observeStep.ok;
  const observeDurationMs = optionalNumber(observe.durationMs) ?? optionalNumber(observeStep.durationMs) ?? 0;

  const lines = [
    "# HELP agent_memory_last_run_timestamp_seconds Unix timestamp of the last heartbeat.",
    "# TYPE agent_memory_last_run_timestamp_seconds gauge",
    `agent_memory_last_run_timestamp_seconds ${lastRunAt}`,
    "# HELP agent_memory_last_run_ok Whether the last heartbeat completed successfully.",
    "# TYPE agent_memory_last_run_ok gauge",
    `agent_memory_last_run_ok ${boolMetric(status.ok)}`,
    "# HELP agent_memory_run_duration_ms Last heartbeat duration in milliseconds.",
    "# TYPE agent_memory_run_duration_ms gauge",
    `agent_memory_run_duration_ms ${Number(status.durationMs || 0)}`,
    "# HELP agent_memory_observe_last_ok Whether the last observe step completed successfully.",
    "# TYPE agent_memory_observe_last_ok gauge",
    `agent_memory_observe_last_ok ${boolMetric(observeOk)}`,
    "# HELP agent_memory_observe_last_timestamp_seconds Unix timestamp of the last observe.",
    "# TYPE agent_memory_observe_last_timestamp_seconds gauge",
    `agent_memory_observe_last_timestamp_seconds ${timestampSeconds(observeFinishedAt)}`,
    "# HELP agent_memory_observe_duration_ms Last observe duration in milliseconds.",
    "# TYPE agent_memory_observe_duration_ms gauge",
    `agent_memory_observe_duration_ms ${observeDurationMs}`,
    "# HELP agent_memory_full_pipeline_last_ok Whether the last full pipeline completed successfully.",
    "# TYPE agent_memory_full_pipeline_last_ok gauge",
    `agent_memory_full_pipeline_last_ok ${boolMetric(fullPipeline.lastOk)}`,
    "# HELP agent_memory_full_pipeline_last_timestamp_seconds Unix timestamp of the last full pipeline.",
    "# TYPE agent_memory_full_pipeline_last_timestamp_seconds gauge",
    `agent_memory_full_pipeline_last_timestamp_seconds ${timestampSeconds(fullPipeline.lastFinishedAt)}`,
    "# HELP agent_memory_full_pipeline_next_timestamp_seconds Unix timestamp when the next full pipeline is due.",
    "# TYPE agent_memory_full_pipeline_next_timestamp_seconds gauge",
    `agent_memory_full_pipeline_next_timestamp_seconds ${timestampSeconds(fullPipeline.nextDueAt)}`,
    "# HELP agent_memory_events_total Total memory events.",
    "# TYPE agent_memory_events_total gauge",
    `agent_memory_events_total ${Number(stats.total || 0)}`,
    "# HELP agent_memory_fts_rows FTS index rows.",
    "# TYPE agent_memory_fts_rows gauge",
    `agent_memory_fts_rows ${Number(stats.ftsRows || 0)}`,
    "# HELP agent_memory_semantic_rows Events with current semantic index rows.",
    "# TYPE agent_memory_semantic_rows gauge",
    `agent_memory_semantic_rows ${Number(stats.semanticRows || 0)}`,
    "# HELP agent_memory_jsonl_files JSONL recovery files.",
    "# TYPE agent_memory_jsonl_files gauge",
    `agent_memory_jsonl_files ${Number(stats.jsonlFiles || 0)}`,
    "# HELP agent_memory_size_kb Memory root size in KiB.",
    "# TYPE agent_memory_size_kb gauge",
    `agent_memory_size_kb ${Number(stats.sizeKb || 0)}`,
    "# HELP agent_memory_capability_count Capability manifest count.",
    "# TYPE agent_memory_capability_count gauge",
    `agent_memory_capability_count ${Number(stats.capabilityCount || 0)}`,
    "# HELP agent_memory_raw_events_total Total raw trail events.",
    "# TYPE agent_memory_raw_events_total gauge",
    `agent_memory_raw_events_total ${Number(trail.rawEvents || 0)}`,
    "# HELP agent_memory_signals_total Total trail signal rows.",
    "# TYPE agent_memory_signals_total gauge",
    `agent_memory_signals_total ${Number(trail.signals || 0)}`,
    "",
  ];
  return lines.join("\n");
}
