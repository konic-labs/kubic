import { dirname, join } from 'node:path';
import type { BridgeFileInfo, FileBridge } from '../file-bridge.js';
import { createNodeFileBridge, withFileLocked } from '../file-bridge.js';
import { tightenStateDir } from '../lock-file.js';
import { applyDelta, deltaFor } from './delta.js';
import { sha256Hex } from './hash.js';
import type {
  JournalEntry,
  JournalEntryInput,
  JournalIndexRead,
  JournalRetention,
  JournalSource,
  RetentionPolicy,
} from './types.js';
import { JournalEntryTooLargeError } from './types.js';

// Default size bound: the journal can never grow past this without an
// explicit override. No default age bound — age pruning is opt-in via
// `journal.retentionDays`.
const DEFAULT_JOURNAL_MAX_BYTES = 100 * 1024 * 1024;
// The share of the kept entries a pass that prunes must drop.
// The index counts against the bound now, so a store sitting at its cap would
// otherwise rewrite the whole index on every append; dropping a chunk makes
// compaction amortized (with the default 100 MiB bound, roughly one rewrite
// per 10 MiB of appended lines) while the store never exceeds `maxBytes`.
const RETENTION_DROP_SHARE = 10;

// An index line written before entries carried `source` names its writer by
// the agent id it was recorded under, and the sweep flags its entries
// `unattributed`. The undo writer recorded `kubic-undo`; every other line is
// a tool call. The mapping runs once, on read, so every reader of the index
// sees a source — and undo never replays its own bookkeeping as work.
function withSource(parsed: unknown): JournalEntry {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return parsed as JournalEntry;
  }
  const line = parsed as Record<string, unknown>;
  if (line.source !== undefined) return parsed as JournalEntry;
  const { agentId: legacyAgentId, ...entry } = line;
  const source: JournalSource =
    legacyAgentId === 'kubic-undo'
      ? 'undo'
      : line.unattributed === true
        ? 'sweep'
        : 'tool';
  return { ...entry, source } as unknown as JournalEntry;
}

// Error codes that mean "this filesystem will not flush this", not "the
// write failed": the journal degrades to rename atomicity instead of
// refusing to record work. ENOSPC/EIO are deliberately
// absent — those are real failures and must stay fatal.
const FLUSH_UNSUPPORTED = new Set([
  'EACCES',
  'EBADF',
  'EINVAL',
  'EISDIR',
  'ENOTSUP',
  'EOPNOTSUPP',
  'EPERM',
]);

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
 * about to rename into place. Exported so a destructive command can observe
 * the lock read-only (`liveLockHolder`) and skip instead of racing.
 */
export function journalMutationLockPath(indexPath: string): string {
  return `${indexPath}.lock`;
}

// The index's tail, as `readIndexTail` reports it: `size` is the
// byte length a failed append truncates back to, null when it could not be
// read; `fragment` means the last byte is not a newline, so the next append
// must close the line first.
interface IndexTail {
  size: number | null;
  fragment: boolean;
}

// The unique blobs an entry references: its before pre-image plus either its
// delta or its after-blob (a delta entry has no after-blob).
// Collapsed per entry: a no-op write with before === after references the
// same blob once, and the retention refcounts are per entry.
function blobHashesOf(entry: JournalEntry): string[] {
  const hashes: string[] = [];
  if (entry.beforeHash !== null) hashes.push(entry.beforeHash);
  if (entry.deltaHash !== null) hashes.push(entry.deltaHash);
  else if (entry.afterHash !== null) hashes.push(entry.afterHash);
  return [...new Set(hashes)];
}

// The bytes one index line occupies: the entry's JSON plus its
// terminating newline, exactly what `appendIndexLine` writes and what a
// retention rewrite re-emits. The size bound counts these — content
// addressing dedupes blobs, so a file toggling between two contents grows the
// journal through its lines alone.
function indexLineBytes(entry: JournalEntry): number {
  return Buffer.byteLength(`${JSON.stringify(entry)}\n`, 'utf8');
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

// The minimum timestamp in a kept set — what an age policy's
// fast path compares against `now`. The minimum, not the first entry: a
// journal can carry entries appended out of timestamp order (reconciliation
// writes real clock stamps into a session whose other entries were seeded),
// and only the minimum proves that nothing has aged out.
function oldestTimestampOf(entries: JournalEntry[]): number | null {
  let oldest: number | null = null;
  for (const entry of entries) {
    if (oldest === null || entry.timestamp < oldest) oldest = entry.timestamp;
  }
  return oldest;
}

export class FileJournalStore {
  readonly indexPath: string;
  private readonly blobsDir: string;
  private readonly durable: boolean;
  private readonly limits: Required<Pick<JournalRetention, 'maxBytes'>> &
    Pick<JournalRetention, 'maxAgeMs'>;
  // Blob sizes are immutable (content-addressed), so a hash's
  // size is cached for the store's lifetime — recorded at write time from
  // the content in hand, or stat'd exactly once on a cache miss. Before
  // this, every append stat'd every referenced blob just to conclude
  // "under the bound".
  //
  // Single-writer assumption: the store is the only writer of `blobs/` and
  // nothing mutates or deletes blob files externally. The fast path's
  // no-I/O proof assumes it: an external mutation between passes leaves
  // trackedBytes stale until something re-stats, and is healed at the next
  // slow pass (which re-derives truth from live stats) or at the next
  // session's seeding pass (a fresh cache stats everything it needs).
  private readonly blobSizes = new Map<string, number>();
  // The hashes THIS store instance wrote (and flushed). A blob
  // in here is trusted by size on reuse; a blob that is not (crash residue
  // from an earlier session, a file another process wrote) is read and
  // hashed before it is reused.
  private readonly writtenHere = new Set<string>();
  // The hashes included in `trackedBytes`. Reset to the live referenced set
  // by every full retention pass, so a blob freed by a prune is re-accounted
  // if it is ever written again.
  private readonly accounted = new Set<string>();
  // Upper bound on the unique blob bytes the current index references —
  // never under-counts (every append accounts each blob it references:
  // putBlob for content it writes, trackRef for hash-only refs), so
  // `trackedBytes <= maxBytes * 0.9` proves no entry can be dropped. null
  // until the first full pass seeds it from truth: a fresh store must run
  // one pass, or a journal left near the bound by a previous session would
  // never be pruned again.
  private trackedBytes: number | null = null;
  // The current index.jsonl size in bytes, tracked
  // incrementally: every append adds the payload it wrote, every rewrite
  // sets it to the bytes it wrote, and a slow pass that dropped nothing
  // re-seeds it from the file itself. null means "unknown" and forces the
  // slow pass — the bound covers the whole store, so an unaccounted index
  // cannot be proven under it.
  private indexBytes: number | null = null;
  // The oldest timestamp in the index (the minimum, not the
  // first — entries can carry non-monotonic timestamps). Seeded by every
  // slow pass and updated on every rewrite, it is what lets an age policy
  // take the fast path: `now - oldest <= maxAgeMs` proves from cache that no
  // entry can have aged out, so the index needs no read at all. null means
  // "unknown" (never seeded, or the last rewrite failed) and forces the
  // slow pass.
  private oldestTimestamp: number | null = null;

  constructor(dir: string, retention: JournalRetention = {}) {
    this.indexPath = join(dir, 'index.jsonl');
    this.blobsDir = join(dir, 'blobs');
    // Durable appends default on: the journal's whole promise
    // is "this change can be undone", which is false if the record of the
    // change can be lost to a crash. Opting out is explicit.
    this.durable = retention.durable ?? true;
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

  // True while THIS store holds the mutation lock, so its own
  // nested calls (append → enforceRetention) do not try to take it twice —
  // the file lock is not re-entrant, and the O_EXCL create would deadlock
  // against itself.
  private mutationLockHeld = false;
  // The state directories are prepared (and tightened) once per
  // store, not once per append.
  private stateDirsReady = false;

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
    bridge.createDir(this.blobsDir, true, 0o700);
    tightenStateDir(dirname(this.indexPath));
    tightenStateDir(this.blobsDir);
    this.stateDirsReady = true;
  }

  /**
   * Run a mutation under the cross-process lock beside the index.
   * A second process waits (up to the lock's wait budget) instead of
   * interleaving; a crashed holder is stolen after the stale window, so the
   * journal is never wedged by residue.
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
    // once, here, and reused by the blob write below.
    const delta = deltaFor(input);
    const ownBytes = entryBlobBytes(input, delta);
    if (ownBytes > this.limits.maxBytes) {
      throw new JournalEntryTooLargeError(ownBytes, this.limits.maxBytes);
    }
    const beforeHash =
      input.before === null
        ? (input.beforeHash ?? null)
        : sha256Hex(input.before);
    const afterHash =
      input.after === null ? (input.afterHash ?? null) : sha256Hex(input.after);
    if (input.before !== null && beforeHash !== null) {
      this.putBlob(bridge, beforeHash, input.before);
    } else if (beforeHash !== null) {
      // Hash-only pre-image (the reconcile shape): no content is written
      // here, but a blob may already exist at this hash — crash residue
      // from a putBlob whose appendFile never landed, or a leak from the
      // sweep's best-effort remove. The fast path's no-I/O proof requires
      // trackedBytes to never under-count the index's referenced bytes, so
      // account the ref exactly like putBlob's write-time accounting (one
      // stat per hash not yet accounted).
      this.trackRef(bridge, beforeHash);
    }
    let deltaHash: string | null = null;
    if (input.after !== null && afterHash !== null) {
      if (delta !== null) {
        deltaHash = sha256Hex(delta);
        this.putBlob(bridge, deltaHash, delta);
      } else {
        this.putBlob(bridge, afterHash, input.after);
      }
    } else if (afterHash !== null) {
      // Hash-only after ref: the same accounting as the
      // hash-only before ref above — a blob may already exist at this hash
      // (shared content, crash residue), and the fast path's no-I/O proof
      // requires trackedBytes to never under-count the index's referenced
      // bytes (one stat per hash not yet accounted).
      this.trackRef(bridge, afterHash);
    }
    const entry: JournalEntry = {
      path: input.path,
      op: input.op,
      beforeHash,
      afterHash,
      deltaHash,
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
      ...(deltaHash !== null && input.before === null
        ? { deltaBaseEmpty: true }
        : {}),
      // The hash-only after-side shape, carried on the entry so
      // `diff` can say why there is no content to show.
      ...(input.afterOmitted === true ? { afterOmitted: true } : {}),
      ...(input.beforeOmitted === true ? { beforeOmitted: true } : {}),
      ...(input.afterBytes === undefined
        ? {}
        : { afterBytes: input.afterBytes }),
    };
    // Durable append: the crash-safety seam. Production takes
    // `appendDurably` (fsync before this returns); a bridge double without
    // it keeps the plain append, and `durable: false` opts out explicitly.
    const written = this.appendIndexLine(bridge, `${JSON.stringify(entry)}\n`);
    // The index's own growth is part of the bound, so the
    // tracked size moves with the append (the repair byte included — it is
    // bytes in the file like any other).
    if (this.indexBytes !== null) this.indexBytes += written;
    // Entries can be appended out of timestamp order (a
    // backwards clock step), so the cached minimum is folded with this entry
    // too — otherwise the age fast path could prove "nothing aged out" from a
    // cache that is higher than the truth and an expired entry would linger.
    // A null cache stays null: only a pass may seed it.
    if (this.oldestTimestamp !== null) {
      this.oldestTimestamp = Math.min(this.oldestTimestamp, entry.timestamp);
    }
    // Bounded by construction: every append enforces the store's limits,
    // so there is no path that grows the journal without checking.
    this.enforceRetention({ ...this.limits });
    return entry;
  }

  entries(): JournalEntry[] {
    return this.readIndex().entries;
  }

  // The index as read: the parseable entries plus the count of
  // lines dropped on the way. `entries()` stays the entry-only view every
  // caller uses; `kubic status` needs both, so it reads the index once.
  readIndex(): JournalIndexRead {
    const bridge = this.bridge();
    const out: JournalEntry[] = [];
    if (!bridge.exists(this.indexPath)) {
      return { entries: out, corruptLines: 0 };
    }
    let corruptLines = 0;
    for (const line of bridge.readTextFile(this.indexPath).split('\n')) {
      if (line.trim() === '') continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        // Corrupt lines never poison the journal; they are skipped, counted
        // for `status`, and dropped by the next retention
        // rewrite.
        corruptLines++;
        continue;
      }
      out.push(withSource(parsed));
    }
    return { entries: out, corruptLines };
  }

  // Append one index line. The line is written as ONE append
  // with a repair prefix, so a crash can never interleave the repair and
  // the entry:
  //
  //   - a torn tail (crash mid-append, ENOSPC, EIO) leaves the index
  //     without its terminating newline. Appending blind would glue the new
  //     entry onto that fragment, JSON.parse would fail on the merged line,
  //     and entries() would drop both — the write happened but the record
  //     is unreadable. One pread of the last byte decides whether the tail
  //     needs the newline.
  //   - a failed append truncates the partial write back to the pre-append
  //     length, so the index is exactly as it was: no half-line to repair,
  //     no unreadable entry, and the repair byte goes with it.
  private appendIndexLine(bridge: FileBridge, line: string): number {
    // One stat per append: the pre-append length is both the truncate
    // target and the position the tail probe reads.
    const tail = this.readIndexTail(bridge);
    const payload = (tail.fragment ? '\n' : '') + line;
    try {
      if (this.durable && bridge.appendDurably !== undefined) {
        // 0600 at creation; an existing index keeps its mode.
        bridge.appendDurably(this.indexPath, payload, { mode: 0o600 });
      } else {
        bridge.appendFile(this.indexPath, payload, { mode: 0o600 });
      }
    } catch (error) {
      if (tail.size !== null) this.truncateIndexTo(bridge, tail.size);
      throw error;
    }
    return Buffer.byteLength(payload, 'utf8');
  }

  // The index's tail as an append needs it: its byte length —
  // the truncate target for a failed append — and whether it ends in a
  // fragment. One stat plus one pread of the last byte. Anything unreadable
  // reports `size: null, fragment: true`: never guess a length to truncate
  // to (losing the index is worse than a partial line the next append
  // repairs), and repair the tail (a needless newline costs a blank line
  // readIndex skips and the next rewrite drops, while a missing one loses
  // the entry this append is writing).
  private readIndexTail(bridge: FileBridge): IndexTail {
    let info: BridgeFileInfo;
    try {
      // One lstat per append. `exists()` + `fileInfo()` asked the
      // same question twice (both are lstats).
      info = bridge.fileInfo(this.indexPath);
    } catch (error) {
      // A fresh index (ENOENT) has nothing to truncate and its first line
      // must not be preceded by a newline; anything else (EACCES, EIO) is
      // unreadable, so no length is guessed.
      return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
        ? { size: 0, fragment: false }
        : { size: null, fragment: true };
    }
    // `fileInfo` is an lstat, so for a symlinked index `size` is
    // the length of the link's target STRING, while `truncateFile` follows
    // the link — a failed append would truncate the link's target to that
    // garbage length. Only a regular file yields a truncate target: a known
    // link or non-regular file leaves the length unknown, which is the
    // conservative repair path (`isFile === undefined` still counts as
    // regular, per the bridge's own convention).
    if (info.isSymbolicLink === true || info.isFile === false) {
      return { size: null, fragment: true };
    }
    const size = info.size;
    if (size === 0) return { size, fragment: false };
    try {
      const last = bridge.readFileRange?.(this.indexPath, size - 1, size);
      return { size, fragment: last?.[0] !== 0x0a };
    } catch {
      return { size, fragment: true };
    }
  }

  // Best-effort: `truncateFile` is optional on the bridge and can fail on
  // its own (the failed append's error is the one the caller must see). A
  // bridge without it degrades to the tail repair on the next append.
  private truncateIndexTo(bridge: FileBridge, size: number): void {
    try {
      bridge.truncateFile?.(this.indexPath, size);
    } catch {
      // Left as-is.
    }
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
    return this.bridge().exists(join(this.blobsDir, hash));
  }

  blobCount(): number {
    const bridge = this.bridge();
    if (!bridge.exists(this.blobsDir)) return 0;
    return bridge
      .listDir(this.blobsDir)
      .filter((info) => !info.isDirectory && !info.isSymbolicLink).length;
  }

  readBefore(
    entry: JournalEntry,
    onCorrupt?: (detail: string) => void,
  ): string | null {
    if (entry.beforeHash === null) return null;
    return this.readBlob(entry.beforeHash, onCorrupt);
  }

  // After-content: direct blob, or before-blob plus delta for large files.
  // Null for deletes (no after-content exists).
  readAfter(
    entry: JournalEntry,
    onCorrupt?: (detail: string) => void,
  ): string | null {
    if (entry.afterHash === null) return null;
    if (entry.deltaHash !== null) {
      const delta = this.readBlob(entry.deltaHash, onCorrupt);
      if (delta === null) return null;
      // Branch order is the correctness contract: the
      // recorded base wins, then the legacy heuristic for pre-flag
      // unattributed entries (reconcile always encoded those against ''),
      // and only then the before-blob. The unattributed check must outrank
      // the before-blob: unattributed entries carry a hash-only beforeHash,
      // and when it resolves to a SHARED blob in the content-addressed
      // store, applying the base-'' delta against that foreign content
      // silently serves wrong after-content. The ''-base paths read no
      // before-blob at all — reconstruction needs none, and reading one
      // would waste I/O and could fire onCorrupt for a torn shared blob
      // even though reconstruction succeeds.
      if (entry.deltaBaseEmpty === true) {
        return this.verifyReconstruction(
          entry,
          applyDelta('', delta),
          onCorrupt,
        );
      }
      // Legacy heuristic: pre-flag unattributed entries encoded their delta
      // against '' (reconcile is the only writer of that shape).
      if (entry.deltaBaseEmpty === undefined && entry.unattributed === true) {
        return this.verifyReconstruction(
          entry,
          applyDelta('', delta),
          onCorrupt,
        );
      }
      const before = this.readBefore(entry, onCorrupt);
      if (before !== null) {
        return this.verifyReconstruction(
          entry,
          applyDelta(before, delta),
          onCorrupt,
        );
      }
      // Before-blob missing on a tool-authored entry: refuse to guess —
      // reconstructing from '' fabricates after-content that never existed.
      return null;
    }
    return this.readBlob(entry.afterHash, onCorrupt);
  }

  // Defense in depth: a delta reconstruction must hash to the
  // entry's recorded after-content — the same contract readBlob enforces on
  // direct blobs. A mismatch means the base was mis-guessed or the entry is
  // inconsistent: fail closed to null and report through onCorrupt, never
  // serve after-content the journal cannot vouch for.
  private verifyReconstruction(
    entry: JournalEntry,
    reconstructed: string | null,
    onCorrupt?: (detail: string) => void,
  ): string | null {
    if (reconstructed === null) return null;
    if (sha256Hex(reconstructed) !== entry.afterHash) {
      onCorrupt?.(
        `delta reconstruction for ${entry.path} does not match its recorded after-hash ${entry.afterHash ?? 'none'} — treating as corrupt`,
      );
      return null;
    }
    return reconstructed;
  }

  enforceRetention(policy: RetentionPolicy): {
    entries: number;
    // The blob bytes the pass freed: the blobs only dropped entries used, plus
    // the unreferenced blob files its sweep removed. A pass that dropped no
    // entry sweeps nothing and frees 0 bytes.
    bytes: number;
    // Bytes the kept set is still over `policy.maxBytes` by,
    // when the newest entry alone cannot fit. 0 means the bound holds.
    overBound: number;
  } {
    // A store with no index has nothing to prune, and reading one
    // must not create it — so the pass is skipped (lock included) before any
    // write. A fresh store's first append creates the directory through the
    // lock's own mkdir.
    if (!this.bridge().exists(this.indexPath)) {
      return { entries: 0, bytes: 0, overBound: 0 };
    }
    // The pass reads the index, rewrites it and sweeps blobs —
    // one mutation, serialized against every other process's.
    return this.withMutationLock(() => this.enforceRetentionLocked(policy));
  }

  private enforceRetentionLocked(policy: RetentionPolicy): {
    entries: number;
    bytes: number;
    overBound: number;
  } {
    const bridge = this.bridge();
    const now = policy.now ?? Date.now();
    // Fast path: the pass can be skipped outright —
    // index reads included — when both bounds are provable from cache. The
    // tracked byte total (index + blobs) is an upper bound on
    // what the store occupies, so being at or under the size bound proves
    // nothing can drop; the oldest entry in the index must be inside the age
    // window too (`oldestTimestamp` is the minimum, so
    // `now - oldest <= maxAgeMs` proves nothing can have aged out). A session
    // under either bound pays zero retention I/O per append, whether or not
    // an age policy is configured.
    const ageProven =
      policy.maxAgeMs === undefined ||
      (this.oldestTimestamp !== null &&
        now - this.oldestTimestamp <= policy.maxAgeMs);
    if (
      ageProven &&
      policy.maxBytes !== undefined &&
      this.trackedBytes !== null &&
      this.indexBytes !== null &&
      this.trackedBytes + this.indexBytes <= policy.maxBytes
    ) {
      return { entries: 0, bytes: 0, overBound: 0 };
    }
    // The size of the index this pass is about to read, sampled
    // BEFORE the read. The rewrite below is only safe while the file is still
    // that file — a writer that does not hold the mutation lock (an older
    // build, a hand edit) can append at any point, and the rename would drop
    // that line silently. Sampled first so an append that lands during or
    // after the read always moves the size: sampling after the read would
    // swallow an append that landed inside it, and the rename would then drop
    // a line the pass never saw. A false abandon (the line was read and is in
    // `kept`) only costs the next pass a retry.
    const sizeAtRead = this.indexFileSize(bridge);
    const all = this.entries();
    // `kept` must not alias `all`: the drop loop shifts entries out of
    // `kept` while `all` stays the pre-drop index for `removed`/`before`.
    let kept = [...all];
    if (policy.maxAgeMs !== undefined) {
      const maxAgeMs = policy.maxAgeMs;
      kept = kept.filter((e) => now - e.timestamp <= maxAgeMs);
    }
    // Truth derivation: a slow pass re-stats
    // every referenced blob exactly once — O(M) per pass — so the drop
    // decisions and the freed-byte report match live truth exactly the way
    // the pre loop did (a missing blob counts zero, a replaced blob
    // counts its real size). Everything below is cache-pure. The seeding
    // pass (trackedBytes === null) skips the re-stat: its cached sizes were
    // recorded at write time earlier in this session (fresh under the
    // single-writer assumption documented on `blobSizes`) and any other
    // hash is stat'd live on cache miss — there is nothing yet to heal.
    const refresh = this.trackedBytes !== null;
    const every = new Set<string>();
    for (const e of all) {
      for (const hash of blobHashesOf(e)) every.add(hash);
    }
    for (const hash of every) this.sizeOf(bridge, hash, refresh);
    // Reference-counted drop arithmetic: count the blobs each
    // kept entry references once, then each dropped entry subtracts only
    // the blobs it uniquely referenced. The old loop re-scanned (and
    // re-stat'd) every unique blob once per dropped entry.
    const refs = new Map<string, number>();
    for (const e of kept) {
      for (const hash of blobHashesOf(e)) {
        refs.set(hash, (refs.get(hash) ?? 0) + 1);
      }
    }
    let overBound = 0;
    if (policy.maxBytes !== undefined) {
      // The bound is the WHOLE store — the index's own bytes
      // count too, because content addressing dedupes blobs and a file
      // toggling between two contents grows only the lines. Each kept entry
      // is measured once, by the same serialization the rewrite writes, and
      // a dropped entry subtracts its own line with its blobs.
      const lineBytes = new Map<JournalEntry, number>();
      let total = 0;
      for (const e of kept) {
        const bytes = indexLineBytes(e);
        lineBytes.set(e, bytes);
        total += bytes;
      }
      for (const hash of refs.keys()) total += this.sizeOf(bridge, hash);
      const maxBytes = policy.maxBytes;
      // Stop at the newest entry. `kept` is oldest-first, so
      // `kept.length > 1` guarantees the last one survives even when it
      // alone is over the bound — losing the record of the change just made
      // is the one thing a change journal may not do. Whatever excess is
      // left is reported to the caller instead of being deleted.
      //
      // A pass that has to prune frees a tenth of the BOUND (a byte low-water
      // mark), so a store at its cap is not rewriting its whole index on every
      // append — the next chunk of appends fits under the bound without another
      // pass. A tenth of the kept ENTRIES would buy the same headroom only when
      // entries are uniform: a store whose oldest entries hold most of the
      // blobs would collapse to a fraction of the cap in one pass and lose far
      // more history than the bound required. The mark is a tenth of the cap,
      // so the history a pass destroys stays proportional to what it has to
      // free.
      if (total > maxBytes) {
        const lowWater = maxBytes - maxBytes / RETENTION_DROP_SHARE;
        while (kept.length > 1 && total > lowWater) {
          const gone = kept.shift();
          if (gone === undefined) break;
          total -= lineBytes.get(gone) ?? 0;
          for (const hash of blobHashesOf(gone)) {
            const count = refs.get(hash) ?? 0;
            if (count === 1) {
              total -= this.sizeOf(bridge, hash);
              refs.delete(hash);
            } else if (count > 1) {
              refs.set(hash, count - 1);
            }
          }
        }
      }
      overBound = Math.max(0, total - maxBytes);
    }
    const removed = all.length - kept.length;
    if (removed === 0) {
      // Re-base the tracked total on derived truth at the end of every slow
      // pass — age-only ones included — so the fast path resumes proving
      // "nothing can drop" from live truth. The index was not rewritten, so the
      // kept set IS what is on disk: the oldest timestamp can be re-seeded from
      // it and the index's own size is the file's real size — corrupt residue
      // included, so the bound never under-counts it.
      this.syncTracking(refs.keys(), this.blobBytes(bridge, kept));
      this.oldestTimestamp = oldestTimestampOf(kept);
      this.indexBytes = this.indexFileSize(bridge);
      return { entries: 0, bytes: 0, overBound };
    }
    const before = this.blobBytes(bridge, all);
    const referenced = new Set(refs.keys());
    this.ensureStateDirs(bridge);
    const tmp = `${this.indexPath}.${process.pid}.tmp`;
    // The same serialization is measured and written, so the
    // tracked index size after the rewrite is exact.
    const serialized =
      kept.map((e) => JSON.stringify(e)).join('\n') +
      (kept.length > 0 ? '\n' : '');
    bridge.writeFile(tmp, serialized, { mode: 0o600 });
    try {
      // Abandon the rewrite when the index changed under it. The
      // pass keeps nothing it cannot prove is still current: the next pass
      // sees the new state, and the line that landed is never lost. (The
      // mutation lock makes this window impossible for a cooperating writer;
      // this is the guard for one that is not.)
      const sizeNow = this.indexFileSize(bridge);
      if (sizeAtRead !== null && sizeNow !== sizeAtRead) {
        bridge.remove(tmp, false, true);
        // The caches describe the index this pass read, not the one that just
        // changed under it: dropping them makes the next pass re-derive truth
        // instead of proving a bound from a stale under-count.
        this.trackedBytes = null;
        this.indexBytes = null;
        this.oldestTimestamp = null;
        return { entries: 0, bytes: 0, overBound: 0 };
      }
      // The rewrite replaces the journal's whole history, so
      // with `durable` on its bytes are fsynced before the rename and the
      // directory after it. Without that, a crash right after the rename
      // can leave an empty or truncated index where the old one was —
      // losing everything the compaction was supposed to keep.
      this.flushDurably(() => bridge.flushFile?.(tmp));
      bridge.renameFile(tmp, this.indexPath);
      this.flushDurably(() => bridge.flushDir?.(dirname(this.indexPath)));
    } catch {
      try {
        bridge.remove(tmp, false, true);
      } catch {
        // Best-effort tmp cleanup; the index rewrite is what matters.
      }
      return { entries: 0, bytes: 0, overBound: 0 };
    }
    // The sweep only removes blobs that are unambiguously dead.
    // `${hash}.${pid}.tmp` is another process's in-flight write (the mutation
    // lock makes this impossible for a cooperating writer, and this guard is
    // what keeps a non-cooperating one — an older build, a hand copy — from
    // having its blob deleted between its write and its rename). A blob whose
    // mtime is newer than this pass started is the same story; an orphaned
    // blob is a leak, never corruption, so leaving one is always the safe
    // direction.
    const sweepStartedAt = Date.now();
    // Bytes of the orphans the sweep removes: blob files no entry references
    // at all. `before - after` counts only the blobs a dropped entry used, so
    // the orphans are added to the freed figure here.
    let orphanBytes = 0;
    if (bridge.exists(this.blobsDir)) {
      for (const info of bridge.listDir(this.blobsDir)) {
        if (info.isDirectory || info.isSymbolicLink) continue;
        if (info.name.endsWith('.tmp')) continue;
        // Whole milliseconds on both sides: `Date.now()` is truncated and
        // `mtimeMs` is not, so a blob written earlier in the pass's own
        // millisecond must not read as newer than the pass.
        if (Math.floor(info.mtimeMs) > sweepStartedAt) continue;
        if (referenced.has(info.name)) continue;
        try {
          bridge.remove(join(this.blobsDir, info.name), false, true);
          if (!every.has(info.name)) orphanBytes += info.size;
        } catch {
          // Best-effort: an orphaned blob is a leak, not corruption.
        }
      }
    }
    const after = this.blobBytes(bridge, kept);
    // The rewrite moved the index onto `kept`: re-base the tracked total on its
    // truth so the fast path resumes proving "nothing can drop", and re-seed
    // the oldest timestamp from the entries that survived. Not done on the
    // failure path above: there the index still holds the dropped entries, and
    // a stale-older value only costs the next pass its fast path, never
    // correctness.
    this.syncTracking(referenced, after);
    this.oldestTimestamp = oldestTimestampOf(kept);
    this.indexBytes = Buffer.byteLength(serialized, 'utf8');
    return { entries: removed, bytes: before - after + orphanBytes, overBound };
  }

  // The index file's real size, 0 when it does not exist yet and
  // null when it cannot be read (which forces the slow pass rather than
  // guessing a size the bound would then trust).
  private indexFileSize(bridge: FileBridge): number | null {
    try {
      return bridge.exists(this.indexPath)
        ? bridge.fileInfo(this.indexPath).size
        : 0;
    } catch {
      return null;
    }
  }

  private putBlob(
    bridge: ReturnType<typeof createNodeFileBridge>,
    hash: string,
    content: string,
  ): void {
    const path = join(this.blobsDir, hash);
    if (bridge.exists(path)) {
      // A blob under its own name is not proof of integrity. A
      // crash on a delayed-allocation filesystem can land the rename and
      // lose the data, leaving a zero-length or torn file at the address;
      // the old short-circuit then reused that file forever, so every later
      // entry read as corrupt. Size first (one stat — catches the truncated
      // crash shape without reading), then the content hash; a blob that
      // fails either check is rewritten from the bytes in hand.
      if (this.blobIsIntact(bridge, path, hash, content)) {
        this.trackRef(bridge, hash);
        return;
      }
    }
    // tmp+rename: a blob becomes visible under its real name
    // only when complete — a crash can never expose half a blob to
    // `readBlob`, and the tmp lives in the same directory (same filesystem),
    // so the rename is atomic. A failed write/rename cleans the tmp up,
    // best-effort, and fails the append: a silently appended entry whose
    // blob was never written would read as corrupt content.
    //
    // With `durable` on, the tmp's bytes are fsynced before the
    // rename and the directory after it. The index line that references
    // this blob is fsynced (appendDurably) later in `append`, so the order
    // is data-then-record: a durable entry can never point at a blob whose
    // bytes were still in the page cache when the power went.
    const tmp = join(this.blobsDir, `${hash}.${process.pid}.tmp`);
    try {
      // 0600 at creation — a blob is a copy of file content,
      // including 0600 sources like `.env`; the rename keeps the mode.
      bridge.writeFile(tmp, content, { mode: 0o600 });
      this.flushDurably(() => bridge.flushFile?.(tmp));
      bridge.renameFile(tmp, path);
      this.flushDurably(() => bridge.flushDir?.(this.blobsDir));
    } catch (error) {
      try {
        bridge.remove(tmp, false, true);
      } catch {
        // Best-effort tmp cleanup; the failed write is what matters.
      }
      throw error;
    }
    // This store wrote and flushed the blob: a later reuse of the same
    // content is trusted by size alone instead of being
    // read and hashed again — the healing below is for files this store did
    // not write (crash residue, another process), and `readBlob` still fails
    // closed on its own hash check if one is corrupted afterwards.
    this.writtenHere.add(hash);
    // Write-time size: the content is in hand, so no stat is needed —
    // this is what makes retention stat-free for what this store writes.
    const size = Buffer.byteLength(content, 'utf8');
    const previous = this.blobSizes.get(hash);
    this.blobSizes.set(hash, size);
    // A re-written blob (freed by an earlier prune, or deleted
    // externally) shifts the tracked total by its new size minus
    // whatever was counted for it before.
    if (this.trackedBytes !== null && this.accounted.has(hash)) {
      this.trackedBytes += size - (previous ?? 0);
      return;
    }
    this.trackRef(bridge, hash);
  }

  // Account a referenced hash not yet in `trackedBytes`. Shared by putBlob's
  // write-time accounting and the hash-only before refs of the reconcile shape,
  // so no reference can slip past the total uncounted: the fast path skips a
  // pruning pass exactly when `trackedBytes <= maxBytes * 0.9`, which is only
  // sound while trackedBytes never under-counts. One stat per hash not yet
  // accounted; over-counting a shared ref is acceptable — it only triggers
  // passes.
  private trackRef(
    bridge: ReturnType<typeof createNodeFileBridge>,
    hash: string,
  ): void {
    if (this.trackedBytes !== null && !this.accounted.has(hash)) {
      this.accounted.add(hash);
      this.trackedBytes += this.sizeOf(bridge, hash);
    }
  }

  // Re-base the tracked total on derived truth. The fast
  // path's single compare is only sound while trackedBytes never
  // under-counts, so every full pass re-derives both numbers together.
  private syncTracking(hashes: Iterable<string>, total: number): void {
    this.accounted.clear();
    for (const hash of hashes) this.accounted.add(hash);
    this.trackedBytes = total;
  }

  // Cached blob size. A cache miss stats once and remembers;
  // a missing blob counts zero, exactly as the old per-call scan did — read
  // paths handle the absence. `refresh` re-stats even on a cache hit and
  // re-records the result — used only by a slow pass's truth derivation,
  // so an external mutation (see `blobSizes`) can never corrupt the drop
  // set or the reported freed bytes the way a phantom size would.
  private sizeOf(
    bridge: ReturnType<typeof createNodeFileBridge>,
    hash: string,
    refresh = false,
  ): number {
    let size = this.blobSizes.get(hash);
    if (size === undefined || refresh) {
      try {
        size = bridge.fileInfo(join(this.blobsDir, hash)).size;
      } catch {
        size = 0;
      }
      this.blobSizes.set(hash, size);
    }
    return size;
  }

  // Is the blob already at `path` the content it claims to be?
  // The size gate is one stat and catches the truncated crash shape without
  // reading; a file this store wrote itself is then trusted (it was flushed
  // on the way in, and a full read+hash per reuse would cost the previous
  // content of every large re-edit — the property this store keeps),
  // while anything else is read and hashed before it is reused. A blob that
  // fails either check is treated as corrupt, so the caller rewrites it from
  // the bytes in hand and heals it instead of poisoning every later entry
  // that reuses it.
  private blobIsIntact(
    bridge: FileBridge,
    path: string,
    hash: string,
    content: string,
  ): boolean {
    try {
      if (bridge.fileInfo(path).size !== Buffer.byteLength(content, 'utf8')) {
        return false;
      }
      if (this.writtenHere.has(hash)) return true;
      return sha256Hex(bridge.readTextFile(path)) === hash;
    } catch {
      return false;
    }
  }

  // Flushing is a durability upgrade, never a reason to
  // lose a write. A platform or filesystem that refuses to flush a directory
  // (Windows' directory handles; FUSE and overlay mounts returning EINVAL)
  // degrades to rename atomicity instead of blocking every tool write — the
  // same shape as a bridge without `appendDurably`. A genuine I/O failure
  // (ENOSPC, EIO) still propagates: a durable entry may not silently
  // reference bytes that were never flushed. Both callers share this rule;
  // only a failed append is fatal — a failed compaction means no prune.
  private flushDurably(run: () => void): void {
    if (!this.durable) return;
    try {
      run();
    } catch (error) {
      const code = (error as { code?: string } | null)?.code ?? '';
      if (!FLUSH_UNSUPPORTED.has(code)) throw error;
    }
  }

  // Content-addressed read: the blob's own name is the
  // contract. Content that does not hash to `hash` (torn write, tampering,
  // bit rot) fails closed to null — a wrong blob must never be served as
  // truth, especially to `undo` restore.
  private readBlob(
    hash: string,
    onCorrupt?: (detail: string) => void,
  ): string | null {
    const bridge = this.bridge();
    const path = join(this.blobsDir, hash);
    if (!bridge.exists(path)) return null;
    try {
      const content = bridge.readTextFile(path);
      if (sha256Hex(content) !== hash) {
        onCorrupt?.(`blob ${hash} fails its own hash — treating as missing`);
        return null;
      }
      return content;
    } catch {
      return null;
    }
  }

  private blobBytes(
    bridge: ReturnType<typeof createNodeFileBridge>,
    entries: JournalEntry[],
  ): number {
    const seen = new Set<string>();
    let total = 0;
    const add = (hash: string | null): void => {
      if (hash === null || seen.has(hash)) return;
      seen.add(hash);
      total += this.sizeOf(bridge, hash);
    };
    for (const e of entries) {
      add(e.beforeHash);
      if (e.deltaHash !== null) add(e.deltaHash);
      else add(e.afterHash);
    }
    return total;
  }
}
