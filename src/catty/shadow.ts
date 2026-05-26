#!/usr/bin/env bun

import { InMemoryCattyStore, recordCurrentShadowPrediction } from "./runtime";
import { SqliteCattyStore } from "./sqlite-store";
import { PiBrain, StubBrain } from "./brain";
import { DEFAULT_EVENTS_DB, loadTrailFromEventsDb, trailSurface } from "./trail";
import type { Brain, SelfHypothesis } from "./types";

export type ShadowPredictionResult = {
  ok: true;
  mode: "dry-run" | "write";
  brain: string;
  sourceDbPath: string;
  storeDbPath?: string;
  trailEvents: number;
  predictionId?: string;
  contextSwitch: {
    from?: string;
    to: string;
    at: string;
  };
  hypothesis: SelfHypothesis;
};

export type ShadowPredictionOptions = {
  sourceDbPath?: string;
  storeDbPath?: string;
  limit?: number;
  write?: boolean;
  now?: string;
  brain?: Brain;
};

function usage(exitCode = 0): never {
  const text = `Usage:
  bun src/catty/shadow.ts [--write] [--pi] [--db PATH] [--store-db PATH] [--limit 80] [--json]

Defaults:
  without --write, runs a dry-run and does not create catty_predictions
  without --pi, uses StubBrain and does not call a model
  --db defaults to ${DEFAULT_EVENTS_DB}
  --store-db defaults to --db
`;
  (exitCode === 0 ? console.log : console.error)(text);
  process.exit(exitCode);
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function argValue(args: string[], name: string, fallback = ""): string {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] || fallback : fallback;
}

function positiveInt(raw: string, fallback: number): number {
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export async function recordCattyShadowPrediction(options: ShadowPredictionOptions = {}): Promise<ShadowPredictionResult> {
  const sourceDbPath = options.sourceDbPath ?? DEFAULT_EVENTS_DB;
  const storeDbPath = options.storeDbPath ?? sourceDbPath;
  const limit = Math.max(1, Math.floor(options.limit ?? 80));
  const brain = options.brain ?? new StubBrain();
  const trail = loadTrailFromEventsDb({ dbPath: sourceDbPath, limit });
  const shouldWrite = Boolean(options.write);
  const store = shouldWrite ? new SqliteCattyStore(storeDbPath) : new InMemoryCattyStore();

  try {
    const record = await recordCurrentShadowPrediction({
      trail,
      brain,
      store,
      now: options.now,
    });

    return {
      ok: true,
      mode: shouldWrite ? "write" : "dry-run",
      brain: brain.name,
      sourceDbPath,
      storeDbPath: shouldWrite ? storeDbPath : undefined,
      trailEvents: trail.length,
      predictionId: shouldWrite ? record.id : undefined,
      contextSwitch: {
        from: record.context.switchedFrom ? trailSurface(record.context.switchedFrom) : undefined,
        to: trailSurface(record.context.switchedTo),
        at: record.context.now,
      },
      hypothesis: record.hypothesis,
    };
  } finally {
    if (store instanceof SqliteCattyStore) {
      store.close();
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (hasFlag(args, "-h") || hasFlag(args, "--help")) usage(0);
  if (hasFlag(args, "--write") && hasFlag(args, "--dry-run")) {
    console.error("--write and --dry-run are mutually exclusive");
    process.exit(2);
  }

  const brain = hasFlag(args, "--pi") ? new PiBrain() : new StubBrain();
  const sourceDbPath = argValue(args, "--db", DEFAULT_EVENTS_DB);
  const storeDbPath = argValue(args, "--store-db", sourceDbPath);
  const limit = positiveInt(argValue(args, "--limit", "80"), 80);
  const result = await recordCattyShadowPrediction({
    sourceDbPath,
    storeDbPath,
    limit,
    write: hasFlag(args, "--write"),
    brain,
  });
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  });
}
