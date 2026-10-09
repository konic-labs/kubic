import type { CheckpointStore, ProcessSnapshot } from '../env/index.js';
// Durable recovery checkpoints: at most every
// CHECKPOINT_INTERVAL_MS and only when the encoded snapshot changed.
// Clock is injectable so throttle behavior is unit-testable.
//
// Honest limit: this store is the seam, not a wired product
// path — no production caller supplies one to SpawnOptions today, so a
// `kubic run` invocation persists no checkpoint and
// nothing resumes from one. The in-memory store is what the exec/lane
// tests drive; crash recovery for a tool call is the harness's own
// pending-progress snapshot.
export class MemoryCheckpointStore implements CheckpointStore {
  private readonly snapshots = new Map<string, ProcessSnapshot>();
  private readonly lastWrite = new Map<
    string,
    { at: number; encoded: string }
  >();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  record(key: string, snapshot: ProcessSnapshot): void {
    const at = this.now();
    const encoded = encodeSnapshot(snapshot);
    const prev = this.lastWrite.get(key);
    if (
      prev &&
      (at - prev.at < CHECKPOINT_INTERVAL_MS || prev.encoded === encoded)
    )
      return;
    this.lastWrite.set(key, { at, encoded });
    this.snapshots.set(key, { ...snapshot });
  }

  recordFinal(key: string, snapshot: ProcessSnapshot): void {
    this.lastWrite.set(key, {
      at: this.now(),
      encoded: encodeSnapshot(snapshot),
    });
    this.snapshots.set(key, { ...snapshot });
  }

  latest(key: string): ProcessSnapshot | undefined {
    const hit = this.snapshots.get(key);
    return hit ? { ...hit } : undefined;
  }
}

// Script key for an exact argv array: JSON serialization
// distinguishes `['commit', '-m', 'work in progress']` (one message
// element) from `['commit', '-m', 'work', 'in', 'progress']` (split),
// which the legacy `${cmd} ${args.join(' ')}` keys conflate. Tests
// asserting exact argv build their script maps with this; plain joined
// strings keep resolving as a legacy fallback.
export function argvKey(cmd: string, ...args: string[]): string {
  return JSON.stringify([cmd, ...args]);
}

const CHECKPOINT_INTERVAL_MS = 2000;

function encodeSnapshot(snapshot: ProcessSnapshot): string {
  return `${snapshot.exitCode ?? 'run'}|${snapshot.stdout.length}|${snapshot.stdout}|${snapshot.stderr}`;
}
