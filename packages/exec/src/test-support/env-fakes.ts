// Test doubles for the execution seam: an in-memory checkpoint store, and
// `argvKey`, the exact-argv key the fake shell's scripts match on.

import type { CheckpointStore, ProcessSnapshot } from '../env/index.js';

// Recovery checkpoints, kept at most every CHECKPOINT_INTERVAL_MS and only
// when the encoded snapshot changed. The clock is injectable so the throttle
// is unit-testable.
//
// The store is a seam with no production caller: `kubic run` persists no
// checkpoint and nothing resumes from one. Crash recovery for a tool call is
// the harness's own pending-progress snapshot.
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

// Script key for an exact argv array: JSON serialization distinguishes
// `['commit', '-m', 'work in progress']` (one message element) from
// `['commit', '-m', 'work', 'in', 'progress']` (split), which a joined
// `${cmd} ${args.join(' ')}` key conflates. Tests asserting exact argv build
// their script maps with this; plain joined strings still resolve.
export function argvKey(cmd: string, ...args: string[]): string {
  return JSON.stringify([cmd, ...args]);
}

const CHECKPOINT_INTERVAL_MS = 2000;

function encodeSnapshot(snapshot: ProcessSnapshot): string {
  return `${snapshot.exitCode ?? 'run'}|${snapshot.stdout.length}|${snapshot.stdout}|${snapshot.stderr}`;
}
