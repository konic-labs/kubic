// Cheap read-only spawn path (issue #55; §81).
// Taxonomy: the spawn fast path is reads + admission checks only
// (read-*, check-*). Two expensive families disqualify it — the WRITE
// family (mutates worktree/fs: write-*, *-write) and the NET family
// (touches the network: net-*, network-*). Names match case- and
// separator-insensitively: lowercase, unify `_`/`.` to `-`, then flag
// any `-`-separated token whose stem is `write` or `net`/`network` —
// so `write_worktree`, `WRITE-worktree`, `net.fetch`,
// `filesystem-write`, and `network-fetch` all disqualify. Pure.

export class SpawnPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpawnPathError';
  }
}

function normalizeStep(step: string): string {
  return step.toLowerCase().replace(/[_.]/g, '-');
}

function isExpensiveStep(step: string): boolean {
  return normalizeStep(step)
    .split('-')
    .some((token) => token.startsWith('write') || token.startsWith('net'));
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
