// Ordered settlement queue (issue #46; §44.2).
// Candidates settle strictly FIFO. An unresolvable conflict stops the
// queue: the blocking candidate keeps both diffs with no winner picked,
// and every candidate (settled or pending) stays listed — nothing is
// dropped or reordered. Pure — no I/O, no git.

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

export interface MergeQueue {
  enqueue: (candidate: MergeCandidate) => void;
  dequeue: () => MergeCandidate | undefined;
  list: () => MergeCandidate[];
  markUnresolvable: (
    agentId: string,
    diffs: { oursDiff: string; theirsDiff: string },
  ) => void;
  status: () => QueueStatus;
  blocked: () => BlockedConflict | undefined;
}

export function createMergeQueue(): MergeQueue {
  const order: MergeCandidate[] = [];
  let queueStatus: QueueStatus = 'open';
  let blockedConflict: BlockedConflict | undefined;

  return {
    enqueue(candidate: MergeCandidate): void {
      order.push({ ...candidate });
    },
    dequeue(): MergeCandidate | undefined {
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
      queueStatus = 'stopped';
      blockedConflict = {
        agentId,
        oursDiff: diffs.oursDiff,
        theirsDiff: diffs.theirsDiff,
        winner: undefined,
      };
    },
    status(): QueueStatus {
      return queueStatus;
    },
    blocked(): BlockedConflict | undefined {
      return blockedConflict === undefined ? undefined : { ...blockedConflict };
    },
  };
}
