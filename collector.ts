export interface TurnLifecycleEvent {
  seq: number;
  type: "turn/started" | "turn/completed" | "system/interaction/lifecycle";
  createdAt: number;
  interaction?: {
    id: string;
    status: string;
  };
}

export interface CollectorCursor {
  lastSeq: number;
  activeTurnId: string | null;
  openTurnId: string | null;
  openTurnStartedAt: number;
  pendingInteractionIds: string[];
}

export type CollectorOperation =
  | { kind: "start"; turnId: string; startedAt: number }
  | {
      kind: "close";
      endedAt: number;
      reason: "completed" | "superseded";
    }
  | { kind: "pause"; endedAt: number };

export interface BatchPersistence {
  transaction<T>(work: () => T): T;
  apply(operation: CollectorOperation): void;
  persistCursor(cursor: CollectorCursor): void;
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
  const next = { ...initial, pendingInteractionIds: [...initial.pendingInteractionIds] };
  const operations: CollectorOperation[] = [];
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    if (event.seq <= next.lastSeq) continue;
    if (event.type === "turn/started") {
      if (next.activeTurnId && next.openTurnId) {
        operations.push({
          kind: "close",
          endedAt: Math.max(event.createdAt, next.openTurnStartedAt),
          reason: "superseded",
        });
      }
      next.activeTurnId = String(event.seq);
      next.pendingInteractionIds = [];
      next.openTurnId = next.activeTurnId;
      next.openTurnStartedAt = event.createdAt;
      operations.push({ kind: "start", turnId: next.openTurnId, startedAt: event.createdAt });
    } else if (event.type === "turn/completed") {
      if (next.openTurnId) {
        operations.push({
          kind: "close",
          endedAt: Math.max(event.createdAt, next.openTurnStartedAt),
          reason: "completed",
        });
      }
      next.activeTurnId = null;
      next.openTurnId = null;
      next.openTurnStartedAt = 0;
      next.pendingInteractionIds = [];
    } else if (event.interaction?.status === "pending") {
      const wasPending = next.pendingInteractionIds.length > 0;
      if (!next.pendingInteractionIds.includes(event.interaction.id)) {
        next.pendingInteractionIds.push(event.interaction.id);
      }
      if (!wasPending) {
        operations.push({ kind: "pause", endedAt: event.createdAt });
      }
      next.openTurnId = null;
      next.openTurnStartedAt = 0;
    } else if (event.interaction?.status === "resolved") {
      next.pendingInteractionIds = next.pendingInteractionIds.filter(
        (id) => id !== event.interaction?.id,
      );
      if (next.activeTurnId && !next.openTurnId && next.pendingInteractionIds.length === 0) {
        next.openTurnId = `${next.activeTurnId}:resume:${event.seq}`;
        next.openTurnStartedAt = event.createdAt;
        operations.push({ kind: "start", turnId: next.openTurnId, startedAt: event.createdAt });
      }
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
    persistence.persistCursor(planned.next);
    return planned.next;
  });
}
