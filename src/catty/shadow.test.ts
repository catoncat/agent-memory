import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SqliteCattyStore } from "./sqlite-store";
import { recordCattyShadowPrediction } from "./shadow";
import type { Brain, PredictionContext, SelfHypothesis } from "./types";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempEventsDb(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "catty-shadow-"));
  tempDirs.push(dir);
  const dbPath = path.join(dir, "events.sqlite");
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE raw_events (
      id INTEGER PRIMARY KEY,
      ts TEXT NOT NULL,
      source TEXT NOT NULL,
      action TEXT NOT NULL,
      app TEXT,
      window_title TEXT,
      title TEXT NOT NULL,
      url TEXT
    );
  `);
  const insert = db.query(
    `INSERT INTO raw_events (id, ts, source, action, app, window_title, title, url)
     VALUES (?, ?, 'observer', 'active_focus', ?, ?, ?, ?)`,
  );
  insert.run(1, "2026-05-26T08:00:00Z", "Cursor", "runtime.ts", "runtime.ts", null);
  insert.run(2, "2026-05-26T08:01:00Z", "Google Chrome", "SQLite docs", "SQLite docs", "https://sqlite.org/lang.html");
  insert.run(3, "2026-05-26T08:02:00Z", "Google Chrome", "SQLite docs", "SQLite docs", "https://sqlite.org/lang.html");
  insert.run(4, "2026-05-26T08:03:00Z", "Cursor", "shadow.ts", "shadow.ts", null);
  db.close();
  return dbPath;
}

class ShadowBrain implements Brain {
  readonly name = "shadow-test-brain";

  async propose(ctx: PredictionContext): Promise<SelfHypothesis> {
    return {
      intent: `继续在 ${ctx.switchedTo.app} 里收口 Catty shadow CLI`,
      nextStep: "把当前 shadow prediction 写入 live SQLite",
      whyNow: "刚从 SQLite 文档切回代码",
      canPrepare: "准备 focused test 和 smoke command",
      confidence: 0.68,
      source: this.name,
    };
  }
}

describe("Catty shadow CLI seam", () => {
  test("writes the latest live context-switch shadow prediction only when --write is explicit", async () => {
    const dbPath = tempEventsDb();
    const dryRun = await recordCattyShadowPrediction({
      sourceDbPath: dbPath,
      storeDbPath: dbPath,
      brain: new ShadowBrain(),
      now: "2026-05-26T08:03:01Z",
    });

    expect(dryRun.mode).toBe("dry-run");
    expect(dryRun.predictionId).toBeUndefined();
    const afterDryRun = new Database(dbPath, { readonly: true });
    expect(
      afterDryRun.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'catty_predictions'").get(),
    ).toBeNull();
    afterDryRun.close();

    const written = await recordCattyShadowPrediction({
      sourceDbPath: dbPath,
      storeDbPath: dbPath,
      brain: new ShadowBrain(),
      write: true,
      now: "2026-05-26T08:03:01Z",
    });

    expect(written.mode).toBe("write");
    expect(written.contextSwitch.to).toBe("Cursor");
    expect(written.predictionId).toMatch(/^pred_/);

    const store = new SqliteCattyStore(dbPath);
    const persisted = store.getPrediction(written.predictionId ?? "");
    expect(persisted?.bucket).toBe("shadow");
    expect(persisted?.wasVisible).toBe(false);
    expect(persisted?.context.switchedTo.app).toBe("Cursor");
    expect(persisted?.hypothesis.intent).toContain("shadow CLI");
    store.close();
  });
});
