// Ordered settlement queue (issue #46; §44.2).
// Candidates settle strictly FIFO. An unresolvable conflict stops the
// queue: enqueue and dequeue both refuse once stopped (fail-closed),
// the blocking candidates keep both diffs with no winner picked, and
// every candidate (settled or pending) stays listed — nothing is
// dropped or reordered. Blocked records are kept per agentId, first
// record wins: a second mark for the same agent never overwrites the
// first. Pure — no I/O, no git.

export interface MergeCandidate {
  agentId: string;
  branch: string;
}

export interface BlockedConflict {
  agentId: string;
  oursDiff: string;
  theirsDiff: string;
  winner?: undefined;
}

export type QueueStatus = 'open' | 'stopped';

export class QueueStoppedError extends Error {
  constructor(agentId: string) {
    super(
      `merge queue stopped by the unresolvable conflict on '${agentId}': dequeue refused, candidates preserved`,
    );
    this.name = 'QueueStoppedError';
  }
}

export interface MergeQueue {
  enqueue: (candidate: MergeCandidate) => void;
  dequeue: () => MergeCandidate | undefined;
  list: () => MergeCandidate[];
  markUnresolvable: (
    agentId: string,
    diffs: { oursDiff: string; theirsDiff: string },
  ) => void;
  status: () => QueueStatus;
  blocked: (agentId?: string) => BlockedConflict | undefined;
  blockedFor: (agentId: string) => BlockedConflict | undefined;
  blockedAll: () => BlockedConflict[];
}

export function createMergeQueue(): MergeQueue {
  const order: MergeCandidate[] = [];
  const stoppedBy: string[] = [];
  let queueStatus: QueueStatus = 'open';
  const blockedConflicts = new Map<string, BlockedConflict>();

  function copyBlocked(conflict: BlockedConflict): BlockedConflict {
    return { ...conflict };
  }

  return {
    enqueue(candidate: MergeCandidate): void {
      if (queueStatus === 'stopped') {
        throw new QueueStoppedError(stoppedBy[0] ?? candidate.agentId);
      }
      order.push({ ...candidate });
    },
    dequeue(): MergeCandidate | undefined {
      if (queueStatus === 'stopped') {
        throw new QueueStoppedError(stoppedBy[0] ?? 'unknown');
      }
      const next = order.shift();
      return next === undefined ? undefined : { ...next };
    },
    list(): MergeCandidate[] {
      return order.map((candidate) => ({ ...candidate }));
    },
    markUnresolvable(
      agentId: string,
      diffs: { oursDiff: string; theirsDiff: string },
    ): void {
      if (blockedConflicts.has(agentId)) {
        return;
      }
      queueStatus = 'stopped';
      stoppedBy.push(agentId);
      blockedConflicts.set(agentId, {
        agentId,
        oursDiff: diffs.oursDiff,
        theirsDiff: diffs.theirsDiff,
        winner: undefined,
      });
    },
    status(): QueueStatus {
      return queueStatus;
    },
    blocked(agentId?: string): BlockedConflict | undefined {
      if (agentId !== undefined) {
        const found = blockedConflicts.get(agentId);
        return found === undefined ? undefined : copyBlocked(found);
      }
      const first = blockedConflicts.keys().next();
      if (first.done) return undefined;
      const found = blockedConflicts.get(first.value);
      return found === undefined ? undefined : copyBlocked(found);
    },
    blockedFor(agentId: string): BlockedConflict | undefined {
      const found = blockedConflicts.get(agentId);
      return found === undefined ? undefined : copyBlocked(found);
    },
    blockedAll(): BlockedConflict[] {
      return [...blockedConflicts.values()].map(copyBlocked);
    },
  };
}
