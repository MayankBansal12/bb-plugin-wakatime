export interface TurnLifecycleEvent {
  seq: number;
  type: "turn/started" | "turn/completed";
  createdAt: number;
}

export interface CollectorCursor {
  lastSeq: number;
  openTurnId: string | null;
  openTurnStartedAt: number;
}

export type CollectorOperation =
  | { kind: "start"; turnId: string; startedAt: number }
  | { kind: "close"; endedAt: number; reason: "completed" | "superseded" };

export interface BatchPersistence {
  transaction<T>(work: () => T): T;
  apply(operation: CollectorOperation): void;
  persistCursor(lastSeq: number): void;
}

/**
 * Plans a replay-safe event page without side effects. The caller persists the
 * returned operations and next cursor in one transaction, then publishes the
 * next cursor in memory only after commit.
 */
export function planTurnEventBatch(
  initial: CollectorCursor,
  events: readonly TurnLifecycleEvent[],
): { next: CollectorCursor; operations: CollectorOperation[] } {
  const next = { ...initial };
  const operations: CollectorOperation[] = [];
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    if (event.seq <= next.lastSeq) continue;
    if (event.type === "turn/started") {
      if (next.openTurnId) {
        operations.push({
          kind: "close",
          endedAt: Math.max(event.createdAt, next.openTurnStartedAt),
          reason: "superseded",
        });
      }
      next.openTurnId = String(event.seq);
      next.openTurnStartedAt = event.createdAt;
      operations.push({
        kind: "start",
        turnId: next.openTurnId,
        startedAt: event.createdAt,
      });
    } else if (next.openTurnId) {
      operations.push({
        kind: "close",
        endedAt: Math.max(event.createdAt, next.openTurnStartedAt),
        reason: "completed",
      });
      next.openTurnId = null;
      next.openTurnStartedAt = 0;
    }
    next.lastSeq = event.seq;
  }
  return { next, operations };
}

/** The production transaction boundary for interval mutations + cursor. */
export function persistPlannedBatch(
  planned: ReturnType<typeof planTurnEventBatch>,
  persistence: BatchPersistence,
): CollectorCursor {
  return persistence.transaction(() => {
    for (const operation of planned.operations) persistence.apply(operation);
    persistence.persistCursor(planned.next.lastSeq);
    return planned.next;
  });
}
