import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { persistPlannedBatch, planTurnEventBatch, type CollectorCursor } from "./collector.js";

const empty: CollectorCursor = { lastSeq: 0, openTurnId: null, openTurnStartedAt: 0 };

describe("turn event replay", () => {
  it("uses the start sequence as a stable turn id and ignores replayed events", () => {
    const events = [
      { seq: 10, type: "turn/started" as const, createdAt: 1_000 },
      { seq: 11, type: "turn/completed" as const, createdAt: 2_000 },
    ];
    const first = planTurnEventBatch(empty, events);
    expect(first.next).toEqual({ lastSeq: 11, openTurnId: null, openTurnStartedAt: 0 });
    expect(first.operations).toEqual([
      { kind: "start", turnId: "10", startedAt: 1_000 },
      { kind: "close", endedAt: 2_000, reason: "completed" },
    ]);
    expect(planTurnEventBatch(first.next, events).operations).toEqual([]);
  });

  it("closes a missing completion conservatively when the next turn starts", () => {
    const result = planTurnEventBatch(
      { lastSeq: 4, openTurnId: "4", openTurnStartedAt: 900 },
      [{ seq: 7, type: "turn/started", createdAt: 1_500 }],
    );
    expect(result.operations[0]).toEqual({ kind: "close", endedAt: 1_500, reason: "superseded" });
    expect(result.next.openTurnId).toBe("7");
  });
});

describe("transactional interval and cursor persistence", () => {
  it("rolls back both interval data and cursor, then retries exactly once", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE turns (turn_id TEXT PRIMARY KEY, started_at INTEGER NOT NULL);
      CREATE TABLE cursor (id INTEGER PRIMARY KEY CHECK (id = 1), last_seq INTEGER NOT NULL);
      INSERT INTO cursor (id, last_seq) VALUES (1, 0);
    `);
    const insert = db.prepare(`INSERT INTO turns (turn_id, started_at) VALUES (?, ?)
      ON CONFLICT(turn_id) DO NOTHING`);
    const cursor = db.prepare(`UPDATE cursor SET last_seq = MAX(last_seq, ?)`);
    const planned = planTurnEventBatch(empty, [
      { seq: 5, type: "turn/started", createdAt: 1_000 },
    ]);
    const persist = (fail: boolean) => persistPlannedBatch(planned, {
      transaction: (work) => db.transaction(work)(),
      apply(operation) {
        if (operation.kind === "start") insert.run(operation.turnId, operation.startedAt);
      },
      persistCursor(lastSeq) {
        if (fail) throw new Error("injected failure before cursor persistence");
        cursor.run(lastSeq);
      },
    });

    expect(() => persist(true)).toThrow("injected failure");
    expect(db.prepare(`SELECT COUNT(*) AS count FROM turns`).get()).toEqual({ count: 0 });
    expect(db.prepare(`SELECT last_seq FROM cursor`).get()).toEqual({ last_seq: 0 });

    persist(false);
    persist(false);
    expect(db.prepare(`SELECT COUNT(*) AS count FROM turns`).get()).toEqual({ count: 1 });
    expect(db.prepare(`SELECT last_seq FROM cursor`).get()).toEqual({ last_seq: 5 });
    db.close();
  });
});
