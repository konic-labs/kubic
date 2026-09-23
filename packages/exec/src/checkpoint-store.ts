// File-backed checkpoints (issue #14, slice B): same throttle/final/copy
// semantics as MemoryCheckpointStore, durable across process death.
// Whole-file atomic rewrite (tmp + rename) per persisted write; throttle
// state is per-instance so the first record after a restart always lands.

import { join } from 'node:path';
import {
  CHECKPOINT_INTERVAL_MS,
  type CheckpointStore,
  type ProcessSnapshot,
} from './env.js';
import { createNodeFileBridge } from './file-bridge.js';

function encodeSnapshot(snapshot: ProcessSnapshot): string {
  return `${snapshot.exitCode ?? 'run'}|${snapshot.stdout.length}|${snapshot.stdout}|${snapshot.stderr}`;
}

let persistCounter = 0;

export class FileCheckpointStore implements CheckpointStore {
  private readonly snapshots = new Map<string, ProcessSnapshot>();
  private readonly lastWrite = new Map<
    string,
    { at: number; encoded: string }
  >();
  private readonly now: () => number;
  private readonly file: string;
  private readonly bridge: ReturnType<typeof createNodeFileBridge>;

  constructor(dir: string, now: () => number = Date.now) {
    this.now = now;
    this.bridge = createNodeFileBridge(dir);
    this.file = join(dir, 'checkpoints.json');
    // Corrupt-tolerant: a torn write from a killed process must not take
    // down every future opener — start empty and overwrite on next persist.
    if (this.bridge.exists(this.file)) {
      try {
        const raw = JSON.parse(this.bridge.readTextFile(this.file)) as Record<
          string,
          ProcessSnapshot
        >;
        for (const [key, snapshot] of Object.entries(raw)) {
          this.snapshots.set(key, { ...snapshot });
        }
      } catch {
        this.snapshots.clear();
      }
    }
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
    this.persist(key, snapshot);
  }

  recordFinal(key: string, snapshot: ProcessSnapshot): void {
    this.lastWrite.set(key, {
      at: this.now(),
      encoded: encodeSnapshot(snapshot),
    });
    this.persist(key, snapshot);
  }

  latest(key: string): ProcessSnapshot | undefined {
    const hit = this.snapshots.get(key);
    return hit ? { ...hit } : undefined;
  }

  private persist(key: string, snapshot: ProcessSnapshot): void {
    this.snapshots.set(key, { ...snapshot });
    const raw: Record<string, ProcessSnapshot> = {};
    for (const [k, v] of this.snapshots) raw[k] = { ...v };
    // Unique tmp per write (pid + counter): never a predictable shared
    // path, so concurrent processes cannot clobber or hijack each other.
    persistCounter += 1;
    const tmp = `${this.file}.${process.pid}.${persistCounter}.tmp`;
    this.bridge.writeFile(tmp, JSON.stringify(raw));
    try {
      this.bridge.renameFile(tmp, this.file);
    } catch (error) {
      try {
        this.bridge.remove(tmp, false, true);
      } catch {
        // Best-effort tmp cleanup; the rename error below is what matters.
      }
      throw error;
    }
  }
}
