import { Database } from "bun:sqlite";
import type {
  CattyFeedback,
  CattyStore,
  MemoryAudit,
  PredictionBucket,
  PredictionRecord,
} from "./runtime";
import type { Judgement, PredictionContext, SelfHypothesis, TrailEvent } from "./types";

const EMPTY_MEMORY_AUDIT: MemoryAudit = { accepted: 0, rejected: 0, trialHeuristics: 0 };

type PredictionRow = {
  id: string;
  created_at: string;
  bucket: PredictionBucket;
  was_visible: number;
  context_json: string;
  hypothesis_json: string;
  actual_trail_json: string | null;
  judgement_json: string | null;
  feedback_json: string | null;
};

type MemoryAuditRow = {
  accepted: number;
  rejected: number;
  trial_heuristics: number;
};

export class SqliteCattyStore implements CattyStore {
  private db: Database;
  private ownsDb: boolean;

  constructor(dbOrPath: string | Database) {
    if (typeof dbOrPath === "string") {
      this.db = new Database(dbOrPath);
      this.ownsDb = true;
    } else {
      this.db = dbOrPath;
      this.ownsDb = false;
    }
    this.ensureSchema();
  }

  close(): void {
    if (this.ownsDb) {
      this.db.close();
    }
  }

  addPrediction(input: Omit<PredictionRecord, "id">): PredictionRecord {
    const record: PredictionRecord = { ...input, id: nextPredictionId() };
    this.writeRecord(record);
    return record;
  }

  getPrediction(id: string): PredictionRecord | undefined {
    const row = this.db
      .query(
        `SELECT id, created_at, bucket, was_visible, context_json, hypothesis_json, actual_trail_json, judgement_json, feedback_json
         FROM catty_predictions
         WHERE id = ?`,
      )
      .get(id) as PredictionRow | null;
    return row ? rowToPrediction(row) : undefined;
  }

  listPredictions(): PredictionRecord[] {
    const rows = this.db
      .query(
        `SELECT id, created_at, bucket, was_visible, context_json, hypothesis_json, actual_trail_json, judgement_json, feedback_json
         FROM catty_predictions
         ORDER BY created_at ASC, id ASC`,
      )
      .all() as PredictionRow[];
    return rows.map(rowToPrediction);
  }

  updatePrediction(id: string, patch: Partial<PredictionRecord>): PredictionRecord {
    const current = this.getPrediction(id);
    if (!current) {
      throw new Error(`Catty prediction not found: ${id}`);
    }
    const record = { ...current, ...patch, id };
    this.writeRecord(record);
    return record;
  }

  recordMemoryAudit(audit: MemoryAudit): void {
    this.db
      .query(
        `INSERT INTO catty_memory_audit (singleton_key, accepted, rejected, trial_heuristics, updated_at)
         VALUES ('current', ?, ?, ?, ?)
         ON CONFLICT(singleton_key) DO UPDATE SET
           accepted = excluded.accepted,
           rejected = excluded.rejected,
           trial_heuristics = excluded.trial_heuristics,
           updated_at = excluded.updated_at`,
      )
      .run(audit.accepted, audit.rejected, audit.trialHeuristics, new Date().toISOString());
  }

  getMemoryAudit(): MemoryAudit {
    const row = this.db
      .query("SELECT accepted, rejected, trial_heuristics FROM catty_memory_audit WHERE singleton_key = 'current'")
      .get() as MemoryAuditRow | null;
    if (!row) return { ...EMPTY_MEMORY_AUDIT };
    return {
      accepted: Number(row.accepted),
      rejected: Number(row.rejected),
      trialHeuristics: Number(row.trial_heuristics),
    };
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS catty_predictions (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        bucket TEXT NOT NULL CHECK(bucket IN ('shadow', 'visible')),
        was_visible INTEGER NOT NULL,
        context_json TEXT NOT NULL,
        hypothesis_json TEXT NOT NULL,
        actual_trail_json TEXT,
        judgement_json TEXT,
        feedback_json TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_catty_predictions_created_at ON catty_predictions(created_at);
      CREATE INDEX IF NOT EXISTS idx_catty_predictions_bucket ON catty_predictions(bucket);
      CREATE TABLE IF NOT EXISTS catty_memory_audit (
        singleton_key TEXT PRIMARY KEY CHECK(singleton_key = 'current'),
        accepted INTEGER NOT NULL,
        rejected INTEGER NOT NULL,
        trial_heuristics INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  private writeRecord(record: PredictionRecord): void {
    this.db
      .query(
        `INSERT INTO catty_predictions (
           id, created_at, bucket, was_visible, context_json, hypothesis_json,
           actual_trail_json, judgement_json, feedback_json, updated_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           created_at = excluded.created_at,
           bucket = excluded.bucket,
           was_visible = excluded.was_visible,
           context_json = excluded.context_json,
           hypothesis_json = excluded.hypothesis_json,
           actual_trail_json = excluded.actual_trail_json,
           judgement_json = excluded.judgement_json,
           feedback_json = excluded.feedback_json,
           updated_at = excluded.updated_at`,
      )
      .run(
        record.id,
        record.createdAt,
        record.bucket,
        record.wasVisible ? 1 : 0,
        JSON.stringify(record.context),
        JSON.stringify(record.hypothesis),
        jsonOrNull(record.actualTrail),
        jsonOrNull(record.judgement),
        jsonOrNull(record.feedback),
        new Date().toISOString(),
      );
  }
}

function nextPredictionId(): string {
  return `pred_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function jsonOrNull(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (value === null) return fallback;
  return JSON.parse(value) as T;
}

function rowToPrediction(row: PredictionRow): PredictionRecord {
  return {
    id: row.id,
    createdAt: row.created_at,
    bucket: row.bucket,
    wasVisible: row.was_visible === 1,
    context: JSON.parse(row.context_json) as PredictionContext,
    hypothesis: JSON.parse(row.hypothesis_json) as SelfHypothesis,
    actualTrail: parseJson<TrailEvent[] | undefined>(row.actual_trail_json, undefined),
    judgement: parseJson<Judgement | undefined>(row.judgement_json, undefined),
    feedback: parseJson<CattyFeedback | undefined>(row.feedback_json, undefined),
  };
}
