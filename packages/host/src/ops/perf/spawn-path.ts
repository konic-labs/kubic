// Cheap read-only spawn path (issue #55; §81).
// The spawn fast path is reads + admission checks only. Steps are
// classified by prefix: `write-*` mutates, `net-*` touches the network,
// everything else reads. Any mutating or network step disqualifies the
// path — it must go through the full spawn lane instead. Pure.

export class SpawnPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpawnPathError';
  }
}

function isExpensiveStep(step: string): boolean {
  return step.startsWith('write-') || step.startsWith('net-');
}

export function isCheapSpawnPath(steps: readonly string[]): boolean {
  return steps.every((step) => !isExpensiveStep(step));
}

export function assertCheapSpawnPath(steps: readonly string[]): void {
  const offender = steps.find((step) => isExpensiveStep(step));
  if (offender !== undefined) {
    throw new SpawnPathError(
      `spawn fast path must stay read-only (offending step: ${offender})`,
    );
  }
}
