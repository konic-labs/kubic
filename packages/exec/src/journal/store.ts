import { dirname, join } from 'node:path';
import type { FileBridge } from '../file-bridge.js';
import { createNodeFileBridge } from '../file-bridge.js';
import { tightenStateDir, withFileLocked } from '../lock-file.js';
import { BlobStore } from './blobs.js';
import { deltaFor, reconstructAfter } from './delta.js';
import { sha256Hex } from './hash.js';
import { IndexFile } from './index-file.js';
import {
  checkAgeBound,
  nothingPruned,
  Retention,
  type RetentionResult,
} from './retention.js';
import type {
  JournalEntry,
  JournalEntryInput,
  JournalIndexRead,
  JournalRetention,
  RetentionPolicy,
} from './types.js';
import { JournalEntryTooLargeError } from './types.js';

// Default size bound: the journal can never grow past this without an
// explicit override. No default age bound — age pruning is opt-in via
// `journal.retentionDays`.
const DEFAULT_JOURNAL_MAX_BYTES = 100 * 1024 * 1024;

// How long a mutation lock may sit before it is stale (a crashed
// holder must never wedge the journal) and how long a writer waits for a live
// holder before failing by name. The holder only ever holds it for one
// mutation, so the wait is generous.
const MUTATION_LOCK_STALE_MS = 10_000;
const MUTATION_LOCK_WAIT_MS = 5_000;

/**
 * The mutation lock beside a store's index (`index.jsonl.lock`).
 * Every journal mutation — append, retention rewrite, blob sweep — runs under
 * it, so two processes cannot interleave: a line appended between a reader's
 * `entries()` and its rename is otherwise silently dropped by the rename, and
 * a blob sweep otherwise deletes the `${hash}.${pid}.tmp` another process is
 * about to rename into place.
 */
/** @internal */
export function journalMutationLockPath(indexPath: string): string {
  return `${indexPath}.lock`;
}

// The change journal store: `index.jsonl` (append-only entries) over
// `blobs/` (content-addressed before/after content). It persists across
// sessions, so undo works after the terminal closes. Retention is enforced on
// every append, so unbounded growth is impossible by construction — there is
// no path that adds an entry without checking the bounds first. README.md in
// this folder states the order in which it writes, flushes and renames.
export class FileJournalStore {
  readonly indexPath: string;
  private readonly index: IndexFile;
  private readonly blobs: BlobStore;
  private readonly retention: Retention;
  private readonly limits: Required<Pick<JournalRetention, 'maxBytes'>> &
    Pick<JournalRetention, 'maxAgeMs'>;
  // True while THIS store holds the mutation lock, so its own
  // nested calls (append → enforceRetention) do not try to take it twice —
  // the file lock is not re-entrant, and the O_EXCL create would deadlock
  // against itself.
  private mutationLockHeld = false;
  // The state directories are prepared (and tightened) once per
  // store, not once per append.
  private stateDirsReady = false;

  constructor(dir: string, retention: JournalRetention = {}) {
    checkAgeBound(retention.maxAgeMs);
    this.indexPath = join(dir, 'index.jsonl');
    // Durable appends default on: the journal's whole promise
    // is "this change can be undone", which is false if the record of the
    // change can be lost to a crash. Opting out is explicit.
    const durable = retention.durable ?? true;
    this.index = new IndexFile(this.indexPath, durable);
    this.blobs = new BlobStore(join(dir, 'blobs'), durable);
    this.retention = new Retention(this.index, this.blobs);
    this.limits = {
      maxBytes: retention.maxBytes ?? DEFAULT_JOURNAL_MAX_BYTES,
      ...(retention.maxAgeMs === undefined
        ? {}
        : { maxAgeMs: retention.maxAgeMs }),
    };
  }

  private bridge() {
    return createNodeFileBridge('/');
  }

  /**
   * The store's own directories are Kubic's private state — the
   * journal directory and `blobs/` are created 0700 (the index and every blob
   * hold file content, including copies of 0600 files), and an existing loose
   * one is tightened on the way in. Called before a mutation writes anything;
   * a read never creates a directory.
   */
  private ensureStateDirs(bridge: FileBridge): void {
    // Once per store instance: the hot path (an append per tool write) must
    // not stat and mkdir on every line. A directory that appears later is
    // covered by the next store's first mutation, and doctor keeps naming a
    // loose one in the meantime.
    if (this.stateDirsReady) return;
    bridge.createDir(dirname(this.indexPath), true, 0o700);
    bridge.createDir(this.blobs.dir, true, 0o700);
    tightenStateDir(dirname(this.indexPath));
    tightenStateDir(this.blobs.dir);
    this.stateDirsReady = true;
  }

  /**
   * Run a mutation under the cross-process lock beside the index.
   * A second process waits (up to the lock's wait budget) instead of
   * interleaving; a crashed holder's lock is taken away, so the journal is
   * never wedged by residue, and a live holder's never is.
   */
  private withMutationLock<T>(run: () => T): T {
    if (this.mutationLockHeld) return run();
    return withFileLocked(
      journalMutationLockPath(this.indexPath),
      () => {
        this.mutationLockHeld = true;
        try {
          return run();
        } finally {
          this.mutationLockHeld = false;
        }
      },
      { staleMs: MUTATION_LOCK_STALE_MS, waitMs: MUTATION_LOCK_WAIT_MS },
    );
  }

  append(input: JournalEntryInput): JournalEntry {
    // The whole append — blob writes, the index line and the
    // retention pass it triggers — is one mutation.
    return this.withMutationLock(() => this.appendLocked(input));
  }

  private appendLocked(input: JournalEntryInput): JournalEntry {
    const bridge = this.bridge();
    this.ensureStateDirs(bridge);
    // An entry the store could never keep is refused before a
    // single blob is written, so the caller's file write is aborted with
    // the target untouched rather than landing a change whose record the
    // retention pass below would immediately delete. The delta is encoded
    // once, here, and reused by the blob write.
    const delta = deltaFor(input);
    const ownBytes = entryBlobBytes(input, delta);
    if (ownBytes > this.limits.maxBytes) {
      throw new JournalEntryTooLargeError(ownBytes, this.limits.maxBytes);
    }
    const entry = journalEntryOf(
      input,
      this.storeContent(bridge, input, delta),
    );
    this.index.append(bridge, `${JSON.stringify(entry)}\n`);
    this.retention.noteAppended(entry.timestamp);
    // Bounded by construction: every append enforces the store's limits,
    // so there is no path that grows the journal without checking.
    this.enforceRetention({ ...this.limits });
    return entry;
  }

  // Write the entry's blobs and return the hashes its index line records.
  private storeContent(
    bridge: FileBridge,
    input: JournalEntryInput,
    delta: string | null,
  ): EntryHashes {
    const beforeHash =
      input.before === null
        ? (input.beforeHash ?? null)
        : sha256Hex(input.before);
    const afterHash =
      input.after === null ? (input.afterHash ?? null) : sha256Hex(input.after);
    if (input.before !== null && beforeHash !== null) {
      this.blobs.put(bridge, beforeHash, input.before);
    } else if (beforeHash !== null) {
      // Hash-only pre-image (the reconcile shape): no content is written
      // here, but a blob may already exist at this hash — crash residue
      // from a put whose append never landed, or a leak from the sweep's
      // best-effort remove. The fast path's no-I/O proof requires
      // trackedBytes to never under-count the index's referenced bytes, so
      // account the ref exactly like put's write-time accounting (one
      // stat per hash not yet accounted).
      this.blobs.trackRef(bridge, beforeHash);
    }
    let deltaHash: string | null = null;
    if (input.after !== null && afterHash !== null) {
      if (delta !== null) {
        deltaHash = sha256Hex(delta);
        this.blobs.put(bridge, deltaHash, delta);
      } else {
        this.blobs.put(bridge, afterHash, input.after);
      }
    } else if (afterHash !== null) {
      // Hash-only after ref: the same accounting as the
      // hash-only before ref above — a blob may already exist at this hash
      // (shared content, crash residue), and the fast path's no-I/O proof
      // requires trackedBytes to never under-count the index's referenced
      // bytes (one stat per hash not yet accounted).
      this.blobs.trackRef(bridge, afterHash);
    }
    return { beforeHash, afterHash, deltaHash };
  }

  entries(): JournalEntry[] {
    return this.readIndex().entries;
  }

  // The index as read: the parseable entries plus the count of
  // lines dropped on the way. `entries()` stays the entry-only view every
  // caller uses; `kubic status` needs both, so it reads the index once.
  readIndex(): JournalIndexRead {
    return this.index.read(this.bridge());
  }

  // The entry's own content against the store's bound,
  // for a caller that mutates the workspace and only then records the inverse
  // — `undo`. It must be able to decide BEFORE the mutation whether the
  // record will fit: a restore the store would refuse would leave the
  // workspace changed with no undo/redo entry to show for it.
  entryBound(input: JournalEntryInput): {
    entryBytes: number;
    maxBytes: number;
  } {
    return {
      entryBytes: entryBlobBytes(input, deltaFor(input)),
      maxBytes: this.limits.maxBytes,
    };
  }

  hasBlob(hash: string): boolean {
    return this.blobs.has(hash);
  }

  blobCount(): number {
    return this.blobs.count();
  }

  readBefore(
    entry: JournalEntry,
    onCorrupt?: (detail: string) => void,
  ): string | null {
    if (entry.beforeHash === null) return null;
    return this.blobs.read(entry.beforeHash, onCorrupt);
  }

  // After-content: direct blob, or before-blob plus delta for large files.
  // Null for deletes (no after-content exists).
  readAfter(
    entry: JournalEntry,
    onCorrupt?: (detail: string) => void,
  ): string | null {
    if (entry.afterHash === null) return null;
    if (entry.deltaHash === null) {
      return this.blobs.read(entry.afterHash, onCorrupt);
    }
    const delta = this.blobs.read(entry.deltaHash, onCorrupt);
    if (delta === null) return null;
    return reconstructAfter(
      entry,
      delta,
      (hash) => this.blobs.read(hash, onCorrupt),
      onCorrupt,
    );
  }

  enforceRetention(policy: RetentionPolicy): RetentionResult {
    // A store with no index has nothing to prune, and reading one
    // must not create it — so the pass is skipped (lock included) before any
    // write. A fresh store's first append creates the directory through the
    // lock's own mkdir.
    if (!this.bridge().exists(this.indexPath)) return nothingPruned();
    // The pass reads the index, rewrites it and sweeps blobs —
    // one mutation, serialized against every other process's.
    return this.withMutationLock(() => {
      const bridge = this.bridge();
      return this.retention.run(
        bridge,
        policy,
        () => this.entries(),
        () => this.ensureStateDirs(bridge),
      );
    });
  }
}

interface EntryHashes {
  beforeHash: string | null;
  afterHash: string | null;
  deltaHash: string | null;
}

// The index line an append records.
function journalEntryOf(
  input: JournalEntryInput,
  hashes: EntryHashes,
): JournalEntry {
  return {
    path: input.path,
    op: input.op,
    beforeHash: hashes.beforeHash,
    afterHash: hashes.afterHash,
    deltaHash: hashes.deltaHash,
    bytesDelta: input.bytesDelta,
    sessionId: input.sessionId,
    source: input.source ?? 'tool',
    toolCallId: input.toolCallId,
    timestamp: input.timestamp,
    ...(input.unattributed === true ? { unattributed: true } : {}),
    ...(input.turn === undefined ? {} : { turn: input.turn }),
    // The intercepting tool's name — carried like `turn` so
    // pre-schema index lines (no such key) keep reading as before.
    ...(input.toolName === undefined ? {} : { toolName: input.toolName }),
    // The marker's from→to — data only, no blobs.
    ...(input.headFrom === undefined ? {} : { headFrom: input.headFrom }),
    ...(input.headTo === undefined ? {} : { headTo: input.headTo }),
    // Record the base the delta was actually encoded against
    // (append computed it as `input.before ?? ''`), so readAfter never has
    // to guess. Exactly the reconcile/create shape: no before-content.
    ...(hashes.deltaHash !== null && input.before === null
      ? { deltaBaseEmpty: true }
      : {}),
    // The hash-only after-side shape, carried on the entry so
    // `diff` can say why there is no content to show.
    ...(input.afterOmitted === true ? { afterOmitted: true } : {}),
    ...(input.beforeOmitted === true ? { beforeOmitted: true } : {}),
    ...(input.afterBytes === undefined ? {} : { afterBytes: input.afterBytes }),
  };
}

// The bytes this entry's own blobs occupy — the before pre-image
// plus either the after content or, for a large after-side, the delta stored
// instead of it (`delta`, from `deltaFor`). Each blob counts once: a no-op
// write (before === after) references a single blob, so it is measured once
// rather than twice. The check is on the entry's own content, not on what
// dedupe would add — an entry that could never fit the store is refused
// whether or not its bytes happen to be there already.
function entryBlobBytes(
  input: JournalEntryInput,
  delta: string | null,
): number {
  const before = input.before;
  const beforeBytes = before === null ? 0 : Buffer.byteLength(before, 'utf8');
  const after = input.after;
  if (after === null) return beforeBytes;
  if (delta !== null) return beforeBytes + Buffer.byteLength(delta, 'utf8');
  if (before !== null && before === after) return beforeBytes;
  return beforeBytes + Buffer.byteLength(after, 'utf8');
}
