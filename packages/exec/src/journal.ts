// Change journal store (issue #17; §42.4).
// `.kubic/journal/index.jsonl` (append-only entries) + `blobs/` (content-
// addressed before/after content). Persists across sessions: undo works
// after the terminal closes. Retention is enforced on every append, so
// unbounded growth is impossible by construction — there is no path that
// adds an entry without checking the bounds first.

import { createHash } from 'node:crypto';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { createNodeFileBridge, type FileBridge } from './file-bridge.js';
import { type IgnoreRule, isIgnored, parseIgnoreFile } from './ignore.js';

export type JournalOp = 'write' | 'edit' | 'create' | 'delete' | 'rename';

// Above this many bytes of new content, the after-side is stored as a
// line delta instead of a full blob. The before-blob is always kept whole:
// undo needs the pre-image, and content addressing dedupes it — editing
// the same large file twice stores the before-content once.
export const LARGE_FILE_BYTES = 64 * 1024;
// Chunk size for streamed hashing (issue #107): peak memory is one chunk, never
// the file size. A file at or under this is read in a single call.
export const HASH_CHUNK_BYTES = 4 * 1024 * 1024;
// Above this apparent size the walk NAMES the file rather than hashing it in
// silence (issue #107 scope item 2; review follow-up). The posture is
// deliberately "hashed streaming anyway, but reported": skipping the file
// would make a change to it invisible to the journal — the one thing a change
// journal must never do — while a sparse or genuinely huge file costs its
// apparent size in boot I/O (measured: a 4 GiB-apparent sparse file streamed
// ~4 GiB of zeros in 8475ms, memory bounded). Naming it is what turns
// unbounded work into a visible cost instead of a silent one.
export const HASH_NOTICE_BYTES = 256 * 1024 * 1024;
// Sweep after-content bound (issue #120): a changed file above this is
// recorded hash-only — `after: null`, the walk hash intact, rendered as a
// size-only change — instead of being read whole. The sweep runs on the
// run's exit path, where reading a changed build artifact whole costs its
// size in memory at the worst possible moment; hash-only keeps the change
// visible with a bounded cost, and undo stays non-reversible for it exactly
// as for any other unattributed find.
export const MAX_SWEEP_CONTENT_BYTES = 4 * 1024 * 1024;
// Default size bound: the journal can never grow past this without an
// explicit override. No default age bound — age pruning is opt-in via
// retention config / `kubic clean` (issue #18's CLI).
export const DEFAULT_JOURNAL_MAX_BYTES = 100 * 1024 * 1024;

export interface JournalRetention {
  maxBytes?: number;
  maxAgeMs?: number;
  /**
   * Flush the journal's writes before they are trusted (issues #117,
   * #344), default true. A few fsyncs per tool write are the price of
   * "reversible": the blob an entry references is on platter before the
   * entry is, and the index line is on platter before the append returns,
   * so a crash can neither take back a change the journal already promised
   * to undo nor leave a durable entry pointing at bytes that were never
   * written. The retention rewrite is flushed the same way — it replaces
   * the whole history, so a crash right after it must not be able to leave
   * an empty index. Set `false` to trade that durability for throughput (a
   * crash may then truncate the last line, which `entries()` skips); a
   * bridge without `appendDurably`/`flushFile`/`flushDir` degrades to the
   * plain write, keeping atomicity without durability.
   */
  durable?: boolean;
}

export interface JournalEntryInput {
  path: string;
  op: JournalOp;
  before: string | null;
  // Explicit pre-image hash when before-content is unknowable
  // (reconciliation): the entry records what the hash was, with no blob —
  // readBefore returns null and undo reports non-reversible.
  beforeHash?: string | null;
  after: string | null;
  // Explicit after-state hash when after-content is deliberately not
  // captured (issue #120): the sweep records the walk hash for entries above
  // MAX_SWEEP_CONTENT_BYTES or whose utf-8 decode was lossy, so dedupe and
  // undo staleness keep comparing against the digest the baseline walk
  // produced. No blob is written for it.
  afterHash?: string | null;
  // True when the after-side was deliberately not captured (issue #120):
  // above the sweep content bound, or a lossy decode. `diff` renders it as a
  // size-only change; it is never corruption.
  afterOmitted?: boolean;
  // Designed hash-only pre-image: the file existed but its bytes were not
  // lossless utf-8 (binary), so only the hash is kept — never corruption.
  beforeOmitted?: boolean;
  // The observed after-side size in bytes, recorded alongside afterOmitted.
  afterBytes?: number;
  bytesDelta: number;
  sessionId: string;
  agentId: string;
  toolCallId: string | null;
  timestamp: number;
  unattributed?: boolean;
}

export interface JournalIndexRead {
  entries: JournalEntry[];
  /**
   * Index lines whose JSON.parse failed — a torn fragment from a crash or a
   * full disk (issue #343). `entries()` drops them (a corrupt line must
   * never poison the journal read) and `kubic status` reports the count, so
   * the drop is visible instead of silent.
   */
  corruptLines: number;
}

// Issue #348: an entry whose own content cannot fit the store's bound is
// refused before anything is written. The alternative was a record that the
// same append's retention pass then deleted — the file change landed
// unrecorded and undo had nothing to restore. Named so the tool layer can
// surface it as a journal_failed op error with the bound in the message.
export class JournalEntryTooLargeError extends Error {
  readonly entryBytes: number;
  readonly maxBytes: number;

  constructor(entryBytes: number, maxBytes: number) {
    super(
      `journal entry needs ${entryBytes} bytes of content, over the store's ${maxBytes}-byte bound`,
    );
    this.name = 'JournalEntryTooLargeError';
    this.entryBytes = entryBytes;
    this.maxBytes = maxBytes;
  }
}

export interface JournalEntry {
  path: string;
  op: JournalOp;
  beforeHash: string | null;
  afterHash: string | null;
  deltaHash: string | null;
  bytesDelta: number;
  sessionId: string;
  agentId: string;
  toolCallId: string | null;
  timestamp: number;
  unattributed?: boolean;
  /** True when the delta was encoded against '' (reconciliation entries with
   *  no before-blob). Absent on pre-schema entries — see readAfter fallback. */
  deltaBaseEmpty?: boolean;
  /** Hash-only after-side (issue #120): content deliberately not captured —
   *  above MAX_SWEEP_CONTENT_BYTES, or a lossy utf-8 decode. readAfter
   *  returns null; `afterHash` keeps the walk hash, so dedupe and undo
   *  staleness behave exactly as for a content-captured entry. */
  afterOmitted?: boolean;
  beforeOmitted?: boolean;
  /** The observed size in bytes of an afterOmitted entry's file. */
  afterBytes?: number;
}

export interface RetentionPolicy {
  maxBytes?: number;
  maxAgeMs?: number;
  now?: number;
}

export function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function sha256HexOfBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Hash a file exactly as `sha256Hex(bridge.readTextFile(path))` does, without
 * ever holding the whole file (issue #107).
 *
 * The digest must stay byte-identical for files already journaled: the baseline
 * is compared against digests written by older versions, so a changed digest
 * would read as "every file changed" and rewrite journal history. That means
 * hashing the UTF-8 DECODE rather than the raw bytes — `readTextFile` returns a
 * string and `sha256Hex` hashes it as utf8, so invalid sequences collapse to
 * U+FFFD and must collapse identically here. The decoder is therefore carried
 * across chunk boundaries, so a multi-byte character split between two reads
 * decodes once.
 *
 * A bridge without `readFileRange` falls back to the whole-file read: correct,
 * unbounded, and reachable only from a test double (the node bridge implements
 * it, so every production walk is bounded).
 */
export function sha256HexOfFile(
  bridge: FileBridge,
  path: string,
  size: number,
  onUnbounded?: (detail: string) => void,
): string {
  const readRange = bridge.readFileRange?.bind(bridge);
  if (readRange === undefined) {
    // Silence was the option the issue ruled out. Every production bridge
    // supplies the method, so this is a partial double or a future adapter —
    // but an unlogged revert to whole-file reads cannot be detected in the
    // field, so it is reported through the caller's receipt hook.
    onUnbounded?.(
      `bounded hashing unavailable for ${path} (${size} bytes): the file bridge does not implement readFileRange — reading it whole`,
    );
    return sha256Hex(bridge.readTextFile(path));
  }
  if (size <= HASH_CHUNK_BYTES) {
    return sha256Hex(bridge.readTextFile(path));
  }
  // `ignoreBOM: true` is load-bearing, not a stylistic choice. The default
  // decoder STRIPS a leading U+FEFF while `readFileSync(path, 'utf8')` keeps
  // it, so without this flag a BOM-prefixed file above the chunk size hashed
  // differently from the pre-change code — measured: 8MiB with a BOM diverged
  // while the no-BOM control matched. The consequence was the exact failure
  // this bound must not cause: a baseline written by the older build swept by
  // this one appends a spurious unattributed write, and a tool-authored change
  // gets a duplicate entry shadowing it. A BOM-prefixed CSV/JSON export is all
  // it takes, nothing malicious.
  const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
  const hash = createHash('sha256');
  let offset = 0;
  while (offset < size) {
    const end = Math.min(offset + HASH_CHUNK_BYTES, size);
    const chunk = decoder.decode(readRange(path, offset, end), {
      stream: true,
    });
    if (chunk !== '') hash.update(chunk, 'utf8');
    offset = end;
  }
  const tail = decoder.decode();
  if (tail !== '') hash.update(tail, 'utf8');
  return hash.digest('hex');
}

type DeltaOp = { eq: number } | { del: number } | { ins: string[] };

// Error codes that mean "this filesystem will not flush this", not "the
// write failed": the journal degrades to rename atomicity instead of
// refusing to record work (issue #344 review). ENOSPC/EIO are deliberately
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

// The index's tail, as `readIndexTail` reports it (issue #343): `size` is the
// byte length a failed append truncates back to, null when it could not be
// read; `fragment` means the last byte is not a newline, so the next append
// must close the line first.
interface IndexTail {
  size: number | null;
  fragment: boolean;
}

// The unique blobs an entry references: its before pre-image plus either its
// delta or its after-blob (a delta entry has no after-blob — issue #111).
// Collapsed per entry: a no-op write with before === after references the
// same blob once, and the retention refcounts are per entry.
function blobHashesOf(entry: JournalEntry): string[] {
  const hashes: string[] = [];
  if (entry.beforeHash !== null) hashes.push(entry.beforeHash);
  if (entry.deltaHash !== null) hashes.push(entry.deltaHash);
  else if (entry.afterHash !== null) hashes.push(entry.afterHash);
  return [...new Set(hashes)];
}

// Single-hunk prefix/suffix delta: exact reconstruction, tiny encoding
// for the common case (a few lines changed in a large file). Not a
// minimal diff — storage only, never shown to users.
export function encodeDelta(before: string, after: string): string {
  const a = before.split('\n');
  const b = after.split('\n');
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) {
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++;
  }
  const ops: DeltaOp[] = [];
  if (prefix > 0) ops.push({ eq: prefix });
  const del = a.length - prefix - suffix;
  if (del > 0) ops.push({ del });
  const ins = b.slice(prefix, b.length - suffix);
  if (ins.length > 0) ops.push({ ins });
  if (suffix > 0) ops.push({ eq: suffix });
  return JSON.stringify(ops);
}

export function applyDelta(before: string, delta: string): string | null {
  try {
    const lines = before.split('\n');
    const ops = JSON.parse(delta) as DeltaOp[];
    const out: string[] = [];
    let at = 0;
    for (const op of ops) {
      if ('eq' in op) {
        out.push(...lines.slice(at, at + op.eq));
        at += op.eq;
      } else if ('del' in op) {
        at += op.del;
      } else {
        out.push(...op.ins);
      }
    }
    return out.join('\n');
  } catch {
    // Defensive depth (issue #111): hash verification on blob reads should
    // already catch torn deltas, but a hash-valid yet malformed delta must
    // never crash a caller — fail closed to null, callers treat as missing.
    return null;
  }
}

export class FileJournalStore {
  readonly indexPath: string;
  private readonly blobsDir: string;
  private readonly durable: boolean;
  private readonly limits: Required<Pick<JournalRetention, 'maxBytes'>> &
    Pick<JournalRetention, 'maxAgeMs'>;
  // Issue #124: blob sizes are immutable (content-addressed), so a hash's
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
  // Issue #344: the hashes THIS store instance wrote (and flushed). A blob
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

  constructor(dir: string, retention: JournalRetention = {}) {
    this.indexPath = join(dir, 'index.jsonl');
    this.blobsDir = join(dir, 'blobs');
    // Durable appends default on (issue #117): the journal's whole promise
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

  append(input: JournalEntryInput): JournalEntry {
    const bridge = this.bridge();
    // Issue #348: an entry the store could never keep is refused before a
    // single blob is written, so the caller's file write is aborted with
    // the target untouched rather than landing a change whose record the
    // retention pass below would immediately delete.
    const ownBytes = this.entryBlobBytes(input);
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
      if (Buffer.byteLength(input.after, 'utf8') > LARGE_FILE_BYTES) {
        const delta = encodeDelta(input.before ?? '', input.after);
        deltaHash = sha256Hex(delta);
        this.putBlob(bridge, deltaHash, delta);
      } else {
        this.putBlob(bridge, afterHash, input.after);
      }
    } else if (afterHash !== null) {
      // Hash-only after ref (issue #120): the same accounting as the
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
      agentId: input.agentId,
      toolCallId: input.toolCallId,
      timestamp: input.timestamp,
      ...(input.unattributed === true ? { unattributed: true } : {}),
      // Issue #111: record the base the delta was actually encoded against
      // (append computed it as `input.before ?? ''`), so readAfter never has
      // to guess. Exactly the reconcile/create shape: no before-content.
      ...(deltaHash !== null && input.before === null
        ? { deltaBaseEmpty: true }
        : {}),
      // Issue #120: the hash-only after-side shape, carried on the entry so
      // `diff` can say why there is no content to show.
      ...(input.afterOmitted === true ? { afterOmitted: true } : {}),
      ...(input.beforeOmitted === true ? { beforeOmitted: true } : {}),
      ...(input.afterBytes === undefined
        ? {}
        : { afterBytes: input.afterBytes }),
    };
    // Durable append (issue #117): the crash-safety seam. Production takes
    // `appendDurably` (fsync before this returns); a bridge double without
    // it keeps the plain append, and `durable: false` opts out explicitly.
    this.appendIndexLine(bridge, `${JSON.stringify(entry)}\n`);
    // Bounded by construction: every append enforces the store's limits,
    // so there is no path that grows the journal without checking.
    this.enforceRetention({ ...this.limits });
    return entry;
  }

  entries(): JournalEntry[] {
    return this.readIndex().entries;
  }

  // The index as read (issue #343): the parseable entries plus the count of
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
      try {
        out.push(JSON.parse(line) as JournalEntry);
      } catch {
        // Corrupt lines never poison the journal; they are skipped, counted
        // for `status` (issue #343), and dropped by the next retention
        // rewrite.
        corruptLines++;
      }
    }
    return { entries: out, corruptLines };
  }

  // Append one index line (issue #343). The line is written as ONE append
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
  private appendIndexLine(bridge: FileBridge, line: string): void {
    // One stat per append: the pre-append length is both the truncate
    // target and the position the tail probe reads (issue #343).
    const tail = this.readIndexTail(bridge);
    const payload = (tail.fragment ? '\n' : '') + line;
    try {
      if (this.durable && bridge.appendDurably !== undefined) {
        bridge.appendDurably(this.indexPath, payload);
      } else {
        bridge.appendFile(this.indexPath, payload);
      }
    } catch (error) {
      if (tail.size !== null) this.truncateIndexTo(bridge, tail.size);
      throw error;
    }
  }

  // The index's tail as an append needs it (issue #343): its byte length —
  // the truncate target for a failed append — and whether it ends in a
  // fragment. One stat plus one pread of the last byte. Anything unreadable
  // reports `size: null, fragment: true`: never guess a length to truncate
  // to (losing the index is worse than a partial line the next append
  // repairs), and repair the tail (a needless newline costs a blank line
  // readIndex skips and the next rewrite drops, while a missing one loses
  // the entry this append is writing).
  private readIndexTail(bridge: FileBridge): IndexTail {
    let size: number;
    try {
      size = bridge.exists(this.indexPath)
        ? bridge.fileInfo(this.indexPath).size
        : 0;
    } catch {
      return { size: null, fragment: true };
    }
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
      // Branch order is the correctness contract (issue #111 review): the
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

  // Defense in depth (issue #111): a delta reconstruction must hash to the
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
    bytes: number;
    // Issue #348: bytes the kept set is still over `policy.maxBytes` by,
    // when the newest entry alone cannot fit. 0 means the bound holds.
    overBound: number;
  } {
    const bridge = this.bridge();
    // Fast path (issue #124): with no age policy and the tracked byte
    // total comfortably under the bound, no entry can be dropped — skip the
    // whole pass, index reads included. A session far from the bound pays
    // zero retention I/O per append.
    if (
      policy.maxAgeMs === undefined &&
      policy.maxBytes !== undefined &&
      this.trackedBytes !== null &&
      this.trackedBytes <= policy.maxBytes * 0.9
    ) {
      return { entries: 0, bytes: 0, overBound: 0 };
    }
    const now = policy.now ?? Date.now();
    const all = this.entries();
    // `kept` must not alias `all`: the drop loop shifts entries out of
    // `kept` while `all` stays the pre-drop index for `removed`/`before`.
    let kept = [...all];
    if (policy.maxAgeMs !== undefined) {
      const maxAgeMs = policy.maxAgeMs;
      kept = kept.filter((e) => now - e.timestamp <= maxAgeMs);
    }
    // Truth derivation (issue #124 review fix 2): a slow pass re-stats
    // every referenced blob exactly once — O(M) per pass — so the drop
    // decisions and the freed-byte report match live truth exactly the way
    // the pre-#124 loop did (a missing blob counts zero, a replaced blob
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
    // Reference-counted drop arithmetic (issue #124): count the blobs each
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
      let total = 0;
      for (const hash of refs.keys()) total += this.sizeOf(bridge, hash);
      const maxBytes = policy.maxBytes;
      // Issue #348: stop at the newest entry. `kept` is oldest-first, so
      // `kept.length > 1` guarantees the last one survives even when it
      // alone is over the bound — losing the record of the change just made
      // is the one thing a change journal may not do. Whatever excess is
      // left is reported to the caller instead of being deleted.
      while (kept.length > 1 && total > maxBytes) {
        const dropped = kept.shift();
        if (dropped === undefined) break;
        for (const hash of blobHashesOf(dropped)) {
          const count = refs.get(hash) ?? 0;
          if (count === 1) {
            total -= this.sizeOf(bridge, hash);
            refs.delete(hash);
          } else if (count > 1) {
            refs.set(hash, count - 1);
          }
        }
      }
      overBound = Math.max(0, total - maxBytes);
    }
    const removed = all.length - kept.length;
    if (removed === 0) {
      // Re-base the tracked total on derived truth at the end of every
      // slow pass — age-only ones included — so the fast path resumes
      // proving "nothing can drop" from live truth (issue #124 review
      // fix 2).
      this.syncTracking(refs.keys(), this.blobBytes(bridge, kept));
      return { entries: 0, bytes: 0, overBound };
    }
    const before = this.blobBytes(bridge, all);
    const referenced = new Set(refs.keys());
    const tmp = `${this.indexPath}.${process.pid}.tmp`;
    bridge.writeFile(
      tmp,
      kept.map((e) => JSON.stringify(e)).join('\n') +
        (kept.length > 0 ? '\n' : ''),
    );
    try {
      // Issue #344: the rewrite replaces the journal's whole history, so
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
    if (bridge.exists(this.blobsDir)) {
      for (const info of bridge.listDir(this.blobsDir)) {
        if (
          !info.isDirectory &&
          !info.isSymbolicLink &&
          !referenced.has(info.name)
        ) {
          try {
            bridge.remove(join(this.blobsDir, info.name), false, true);
          } catch {
            // Best-effort: an orphaned blob is a leak, not corruption.
          }
        }
      }
    }
    const after = this.blobBytes(bridge, kept);
    // The rewrite moved the index onto `kept`: re-base the tracked total on
    // its truth so the fast path resumes proving "nothing can drop".
    this.syncTracking(referenced, after);
    return { entries: removed, bytes: before - after, overBound };
  }

  // Issue #348: the bytes this entry's own blobs occupy — the before
  // pre-image plus either the after content or, for a large after-side, the
  // delta that is stored instead of it. Each blob counts once: a no-op
  // write (before === after) references a single blob, so it is measured
  // once rather than twice. The check is on the entry's own content, not on
  // what dedupe would add — an entry that could never fit the store is
  // refused whether or not its bytes happen to be there already.
  private entryBlobBytes(input: JournalEntryInput): number {
    const before = input.before;
    const beforeBytes = before === null ? 0 : Buffer.byteLength(before, 'utf8');
    const after = input.after;
    if (after === null) return beforeBytes;
    if (Buffer.byteLength(after, 'utf8') > LARGE_FILE_BYTES) {
      return (
        beforeBytes +
        Buffer.byteLength(encodeDelta(before ?? '', after), 'utf8')
      );
    }
    if (before !== null && before === after) return beforeBytes;
    return beforeBytes + Buffer.byteLength(after, 'utf8');
  }

  private putBlob(
    bridge: ReturnType<typeof createNodeFileBridge>,
    hash: string,
    content: string,
  ): void {
    const path = join(this.blobsDir, hash);
    if (bridge.exists(path)) {
      // Issue #344: a blob under its own name is not proof of integrity. A
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
    // tmp+rename (issue #117): a blob becomes visible under its real name
    // only when complete — a crash can never expose half a blob to
    // `readBlob`, and the tmp lives in the same directory (same filesystem),
    // so the rename is atomic. A failed write/rename cleans the tmp up,
    // best-effort, and fails the append: a silently appended entry whose
    // blob was never written would read as corrupt content.
    //
    // Issue #344: with `durable` on, the tmp's bytes are fsynced before the
    // rename and the directory after it. The index line that references
    // this blob is fsynced (appendDurably) later in `append`, so the order
    // is data-then-record: a durable entry can never point at a blob whose
    // bytes were still in the page cache when the power went.
    const tmp = join(this.blobsDir, `${hash}.${process.pid}.tmp`);
    try {
      bridge.writeFile(tmp, content);
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
    // content is trusted by size alone (issue #344 review) instead of being
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

  // Account a referenced hash not yet in `trackedBytes` (issue #124 review
  // fix 1). Shared by putBlob's write-time accounting and the hash-only
  // before refs of the reconcile shape, so no reference can slip past the
  // total uncounted: the fast path skips a pruning pass exactly when
  // `trackedBytes <= maxBytes * 0.9`, which is only sound while
  // trackedBytes never under-counts. One stat per hash not yet accounted;
  // over-counting a shared ref is acceptable — it only triggers passes.
  private trackRef(
    bridge: ReturnType<typeof createNodeFileBridge>,
    hash: string,
  ): void {
    if (this.trackedBytes !== null && !this.accounted.has(hash)) {
      this.accounted.add(hash);
      this.trackedBytes += this.sizeOf(bridge, hash);
    }
  }

  // Re-base the tracked total on derived truth (issue #124). The fast
  // path's single compare is only sound while trackedBytes never
  // under-counts, so every full pass re-derives both numbers together.
  private syncTracking(hashes: Iterable<string>, total: number): void {
    this.accounted.clear();
    for (const hash of hashes) this.accounted.add(hash);
    this.trackedBytes = total;
  }

  // Cached blob size (issue #124). A cache miss stats once and remembers;
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

  // Issue #344: is the blob already at `path` the content it claims to be?
  // The size gate is one stat and catches the truncated crash shape without
  // reading; a file this store wrote itself is then trusted (it was flushed
  // on the way in, and a full read+hash per reuse would cost the previous
  // content of every large re-edit — the #124 property this store keeps),
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

  // Issue #344 review: flushing is a durability upgrade, never a reason to
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

  // Content-addressed read (issue #111): the blob's own name is the
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

// --- Baseline + reconciliation (issue #17, slice C; §42.5) ----------------

export type Baseline = Record<string, string>;

export interface BaselineOptions {
  outOfScope?: string[];
  /**
   * Read seam (issue #107). Production always uses the node bridge; tests
   * inject one to observe read sizes. The hashing bound depends on the
   * bridge implementing `readFileRange`, so the seam is explicit rather than
   * a module-level monkeypatch.
   */
  bridge?: FileBridge;
  /**
   * Report a walk condition the operator should know about (issue #107 review
   * follow-up). Used for the one case that used to be silent: a bridge without
   * `readFileRange` reverts to whole-file reads, so a file larger than
   * `HASH_CHUNK_BYTES` costs its size at boot. Production bridges always
   * implement it; the hook exists so the fallback can never be invisible.
   */
  onNotice?: (detail: string) => void;
}

// §35 out-of-scope paths (issue #115): an entry excludes the path itself and
// everything under it. Operators declare directories (`dist`), so the match is
// path-boundary aware — `dist` excludes `dist` and `dist/a.js`, never `dist-x`
// — and it is one shared rule for both §42.5 walks and the sweep's
// after-content loop, so a path can never be in scope in one and out in the
// other.
export function isOutOfScope(
  relPath: string,
  entries: readonly string[],
): boolean {
  return entries.some(
    (entry) => relPath === entry || relPath.startsWith(`${entry}/`),
  );
}

// Metadata walk, not a content copy: hashes only, no blobs. Always skips
// .git/ and .kubic/ (journal state is never journaled), honors every
// `.gitignore` on the way down — the root's rules plus each nested file's,
// child rules appended after the parent's (last-match-wins, so a nested
// negation overrides a parent ignore — the ordering git uses) — and excludes
// caller-declared out-of-scope paths (§35: an entry excludes the path itself
// and everything under it).
export function captureBaseline(
  root: string,
  options: BaselineOptions = {},
): Baseline {
  const bridge = options.bridge ?? createNodeFileBridge('/');
  const outOfScope = options.outOfScope ?? [];
  const baseline: Baseline = {};
  const walk = (dir: string, rel: string, rules: IgnoreRule[]): void => {
    let infos: ReturnType<typeof bridge.listDir> = [];
    try {
      infos = bridge.listDir(dir);
    } catch {
      return;
    }
    // One `exists` per directory entered (issue #116 perf contract): the same
    // order as the `listDir` already paid, and no read at all for a directory
    // without an ignore file.
    let localRules = rules;
    const nested = join(dir, '.gitignore');
    if (bridge.exists(nested)) {
      try {
        // Child rules are appended AFTER the parent's: `isIgnored` is
        // last-match-wins, so a nested negation overrides the parent ignore —
        // the ordering git uses. The array is path-depth-bounded (one copy per
        // directory that has an ignore file) and dropped on recursion exit, so
        // siblings never see each other's rules.
        localRules = [
          ...rules,
          ...parseIgnoreFile(bridge.readTextFile(nested)),
        ];
      } catch {
        // Unreadable nested ignore (chmod 000, a permission-denied mount):
        // keep the parent rules and keep walking — the documented widening,
        // never a throw.
      }
    }
    for (const info of [...infos].sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (info.isSymbolicLink) continue;
      const relPath = rel === '' ? info.name : `${rel}/${info.name}`;
      if (relPath === '.git' || relPath.startsWith('.git/')) continue;
      if (relPath === '.kubic' || relPath.startsWith('.kubic/')) continue;
      if (isOutOfScope(relPath, outOfScope)) continue;
      if (isIgnored(localRules, relPath, info.isDirectory)) continue;
      if (info.isDirectory) {
        walk(join(dir, info.name), relPath, localRules);
      } else if (info.isFile === false) {
        // Not a regular file: a FIFO/socket/device must never be read. A
        // synchronous read of a named pipe blocks until a writer opens it,
        // which would wedge baseline capture at boot with no way to time out
        // (issue #87 follow-up: `kubic run` hung forever in such a workspace).
        // `undefined` means the bridge did not classify it: assume regular.
        // Skipped deliberately (biome's noUselessContinue fix deletes a bare
        // trailing `continue` together with this rationale — do not re-add it).
      } else {
        try {
          const abs = join(dir, info.name);
          if (info.size > HASH_NOTICE_BYTES) {
            // Hashed anyway (a skipped file would hide real changes) but named,
            // so an operator can see why boot took as long as it did.
            options.onNotice?.(
              `hashing a very large file: ${relPath} (${info.size} bytes) — boot reads its full apparent size`,
            );
          }
          baseline[relPath] = sha256HexOfFile(
            bridge,
            abs,
            info.size,
            options.onNotice,
          );
        } catch {
          // Vanished mid-walk: reconcile treats it as a delete.
        }
      }
    }
  };
  walk(root, '', []);
  return baseline;
}

export function saveBaseline(
  dir: string,
  runId: string,
  baseline: Baseline,
): void {
  createNodeFileBridge('/').writeFile(
    join(dir, `baseline-${runId}.json`),
    JSON.stringify(baseline),
  );
}

export function loadBaseline(dir: string, runId: string): Baseline | null {
  const bridge = createNodeFileBridge('/');
  const path = join(dir, `baseline-${runId}.json`);
  if (!bridge.exists(path)) return null;
  try {
    return JSON.parse(bridge.readTextFile(path)) as Baseline;
  } catch {
    return null;
  }
}

export interface ReconcileContext {
  sessionId: string;
  agentId: string;
  timestamp: number;
  /**
   * Issue #341: where this run's part of the journal begins (captured with
   * the boot baseline). Only entries appended after it define a path's
   * expected state; absent ⇒ the whole store is treated as this run.
   */
  runStart?: JournalRunStart;
}

/**
 * The journal position at the moment a run's baseline was captured: the
 * entry count and the last entry then. The last entry is the marker — a
 * retention pass that drops head entries mid-run shifts indexes, so the
 * marker is re-found by content rather than trusted by position.
 */
export interface JournalRunStart {
  count: number;
  last: JournalEntry | null;
}

export function journalRunStart(store: FileJournalStore): JournalRunStart {
  const all = store.entries();
  return { count: all.length, last: all.at(-1) ?? null };
}

// The entries appended since `start` (issue #341). The fast path trusts the
// recorded index when the marker is still there; otherwise the marker's
// last occurrence is searched, and a marker retention already dropped
// means everything left is newer than it.
export function entriesSinceRunStart(
  all: JournalEntry[],
  start: JournalRunStart | undefined,
): JournalEntry[] {
  if (start === undefined || start.last === null) return all;
  const marker = JSON.stringify(start.last);
  const at = start.count - 1;
  if (at < all.length && JSON.stringify(all[at]) === marker) {
    return all.slice(start.count);
  }
  for (let i = Math.min(at, all.length - 1); i >= 0; i--) {
    if (JSON.stringify(all[i]) === marker) return all.slice(i + 1);
  }
  return all;
}

export type RestoreResult =
  | { restored: true }
  | { restored: false; reason: string };

// True when any existing component of target's parent chain (up to but
// excluding root) is a symlink. Missing components cannot be symlinks.
function hasSymlinkParent(target: string, root: string): boolean {
  const bridge = createNodeFileBridge('/');
  let dir = dirname(target);
  const stop = resolve(root);
  while (dir.startsWith(stop + sep) || dir === stop) {
    if (dir === stop) return false;
    try {
      if (bridge.fileInfo(dir).isSymbolicLink) return true;
    } catch {
      return false;
    }
    dir = dirname(dir);
  }
  return false;
}

// Undo primitive for the next issue's CLI: writes the recorded
// before-content back. Entries without before-content (unattributed
// reconciliation finds) are reported non-reversible — never guessed.
// Entry paths are contained to the workspace root: a path escaping via
// ../ (or an absolute path) is refused, never written.
//
// Issue #108: before any write, the file's CURRENT state must match the
// entry's recorded after-state — restoring over a file that changed after
// the entry was journaled (manual edit, another run, another tool) would
// silently destroy those changes. `allowStale` is the operator's explicit
// --force override, per-invocation only, never persisted.
export interface RestoreOptions {
  /** Skip the staleness check (explicit operator override). */
  allowStale?: boolean;
}

// Staleness probe shared by the undo planner/dry-run and restoreEntry
// (issue #108), so every path compares the same state. Pure read.
//
//   { missing: true,  hash: null }     file absent
//   { missing: false, hash: <sha256> } readable current content
//   { missing: false, hash: null }     exists but unreadable — cannot
//                                       verify, so callers refuse
export interface FileCurrentState {
  missing: boolean;
  hash: string | null;
}

export function probeFileState(root: string, path: string): FileCurrentState {
  const bridge = createNodeFileBridge('/');
  const target = resolve(root, path);
  try {
    const info = bridge.fileInfo(target);
    try {
      return {
        missing: false,
        hash: sha256HexOfFile(bridge, target, info.size),
      };
    } catch {
      return { missing: false, hash: null };
    }
  } catch {
    return { missing: true, hash: null };
  }
}

// Best-effort sweep of stale restore residue (issue #117 review): a crash
// mid-restore can leave a `<target>.kubic-restore-<pid>.tmp` sibling behind
// when the best-effort cleanup itself never ran. A successful restore of
// that target removes any such siblings — they are this tool's own
// predictable residue, never user files. Errors are ignored (a leftover is
// litter, not corruption) and only the exact `<target>.kubic-restore-*.tmp`
// name shape matches, so nothing else in the directory is ever touched.
function sweepStaleRestoreTmps(
  bridge: ReturnType<typeof createNodeFileBridge>,
  target: string,
): void {
  const dir = dirname(target);
  const prefix = `${basename(target)}.kubic-restore-`;
  try {
    for (const info of bridge.listDir(dir)) {
      if (info.isDirectory || info.isSymbolicLink) continue;
      if (!info.name.startsWith(prefix) || !info.name.endsWith('.tmp'))
        continue;
      try {
        bridge.remove(join(dir, info.name), false, true);
      } catch {
        // Best-effort: residue that cannot be removed is litter.
      }
    }
  } catch {
    // Unreadable directory: nothing to sweep.
  }
}

// Containment guard shared by every undo primitive: the resolved target
// must sit strictly inside the root, and no existing parent component may
// be a symlink. Returns the absolute target, or the refusal.
function guardTarget(
  entry: JournalEntry,
  root: string,
): string | { restored: false; reason: string } {
  const target = resolve(root, entry.path);
  const rel = relative(root, target);
  if (rel === '' || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) {
    return {
      restored: false,
      reason: `entry path escapes the workspace root: ${entry.path}`,
    };
  }
  // Lexical containment is not enough: a symlinked directory inside the
  // root would redirect the write outside. Refuse symlink parents.
  // (Check-then-write races against a local attacker swapping links
  // mid-restore are out of scope: the journal is a local recovery tool.)
  if (hasSymlinkParent(target, root)) {
    return {
      restored: false,
      reason: `entry path crosses a symlink: ${entry.path}`,
    };
  }
  return target;
}

// An agent-authored create: the pre-state is "absent", which the journal
// knows exactly even though no before-blob exists — so undo reverts it by
// removing the file (§42.2 "kubic undo reverts the run"). Unattributed
// reconciliation creates stay non-reversible: the sweep saw the file
// appear but cannot vouch that nothing else depends on it.
export function isUndoableCreate(entry: JournalEntry): boolean {
  return (
    entry.op === 'create' &&
    entry.beforeHash === null &&
    entry.afterHash !== null &&
    entry.unattributed !== true
  );
}

// Undo primitive for an agent-authored create: removes the file. Carries
// the same containment guards as restoreEntry; the staleness verdict is
// the caller's (the undo walk), exactly as restoreEntry's allowStale path.
export function removeCreatedEntry(
  entry: JournalEntry,
  root: string,
): RestoreResult {
  if (!isUndoableCreate(entry)) {
    return {
      restored: false,
      reason: `not an agent-created file entry: ${entry.path}`,
    };
  }
  const guarded = guardTarget(entry, root);
  if (typeof guarded !== 'string') return guarded;
  const bridge = createNodeFileBridge('/');
  try {
    bridge.remove(guarded, false, true);
  } catch (error) {
    return {
      restored: false,
      reason: `remove failed: ${(error as Error).message}`,
    };
  }
  sweepStaleRestoreTmps(bridge, guarded);
  return { restored: true };
}

export function restoreEntry(
  store: FileJournalStore,
  entry: JournalEntry,
  root: string,
  options?: RestoreOptions,
): RestoreResult {
  const before = store.readBefore(entry);
  if (before === null) {
    return {
      restored: false,
      reason:
        'no before-content: no retrievable pre-image for this entry — nothing to restore',
    };
  }
  const guarded = guardTarget(entry, root);
  if (typeof guarded !== 'string') return guarded;
  const target = guarded;
  if (options?.allowStale !== true) {
    // Direct-caller safety net (issue #108): the walk-aware undo planner
    // performs the same check with full plan context and then calls
    // restoreEntry with allowStale; a bare caller still gets the matrix.
    //
    //   current file   entry.afterHash   action
    //   exists, ==afterHash   set        safe: restore
    //   exists, !=afterHash   set        STALE: refuse (clobber)
    //   missing               set        restore (recreates; no data lost)
    //   exists                null       STALE: refuse (recreated after delete)
    //   missing               null       restore (pre-delete content back)
    const state = probeFileState(root, entry.path);
    if (!state.missing && state.hash !== entry.afterHash) {
      return {
        restored: false,
        reason:
          state.hash === null
            ? `stale: '${entry.path}' exists but its current content could not be read to verify state — use --force`
            : `stale: '${entry.path}' changed after this entry was journaled (current sha256 ${state.hash.slice(0, 12)}… ≠ recorded after ${entry.afterHash?.slice(0, 12) ?? 'none'}…) — restoring would discard those changes; use --force`,
      };
    }
  }
  // Issue #117: the restore writes through a tmp+rename sibling — the same
  // care the write/edit ops have always taken. A crash mid-undo can
  // therefore never leave a half-written file (the worst failure mode for a
  // recovery tool): the target either keeps its old content or receives the
  // restored content wholesale. The tmp lives beside the target in the same
  // directory (same filesystem), so the rename is atomic; a failed
  // write/rename cleans the tmp up best-effort and reports the failure
  // without touching the target.
  //
  // Review fix: the rename replaces the target's inode, so the tmp must
  // carry the target's own mode — a plain writeFile would hand a 0600 secret
  // the umask default (0644) and strip a script's exec bit. The tmp is
  // created 0600 first, so crash residue is never world-readable, then the
  // existing target's mode is copied onto it before the rename; a missing
  // target (the recreate path) keeps the restrictive default.
  const bridge = createNodeFileBridge('/');
  const tmp = `${target}.kubic-restore-${process.pid}.tmp`;
  let targetMode: number | undefined;
  try {
    const info = bridge.fileInfo(target);
    // A symlink's lstat mode is 0777 on every platform, and the rename would
    // replace the link itself: copying those bits onto the replacement would
    // hand the workspace a world-writable file. The mode is preserved for a
    // regular file only (an unclassified double counts as regular).
    if (info.isSymbolicLink === false && info.isFile !== false) {
      targetMode = info.mode;
    }
  } catch {
    // Target absent (recreate path): no mode to preserve.
  }
  try {
    // `writeFileSync` applies the creation mode only to a fresh file, and a
    // same-pid stale tmp (pid reuse) could otherwise keep its old mode:
    // clearing it first makes the 0600 creation unconditional. Best-effort —
    // the write below reports real failures.
    if (bridge.exists(tmp)) bridge.remove(tmp, false, true);
  } catch {
    // Best-effort; the restore write is what must succeed.
  }
  try {
    bridge.writeFile(tmp, before, { mode: 0o600 });
    if (targetMode !== undefined) bridge.chmod?.(tmp, targetMode);
    bridge.renameFile(tmp, target);
  } catch (error) {
    try {
      bridge.remove(tmp, false, true);
    } catch {
      // Best-effort tmp cleanup; the untouched target is what matters.
    }
    return {
      restored: false,
      reason: `restore write failed: ${(error as Error).message}`,
    };
  }
  sweepStaleRestoreTmps(bridge, target);
  return { restored: true };
}

// The sweep's lossless-decode check (issue #120), in hash space: the decoded
// string is trustworthy exactly when the bytes it came from are its utf-8
// re-encoding — i.e. when hashing the bytes and hashing the string agree.
//
// The walk hash cannot make this call: for a file at or under
// HASH_CHUNK_BYTES it IS `sha256Hex(readTextFile)` — a hash of the utf-8
// decode — so comparing it against a hash of that same decode is vacuous by
// construction (measured equal for binary fixtures too, chunked decode
// included; the walk hash must also stay digest-identical for files already
// journaled, so it cannot be redefined to hash bytes). The raw bytes are
// what diverge: a binary file's decode collapses invalid sequences to
// U+FFFD, its re-encoding no longer matches the file, and the caller records
// hash-only instead of a mangled blob. Returns null when the decode was
// lossy.
function decodeLossless(bytes: Uint8Array): string | null {
  const raw = Buffer.from(bytes).toString('utf8');
  return sha256Hex(raw) === sha256HexOfBytes(bytes) ? raw : null;
}

// A journaled path as the walk keys it ('/'-separated, relative to root), or
// null when it resolves to the root itself or outside it.
function rootRelativeKey(root: string, path: string): string | null {
  const rel = relative(root, resolve(root, path));
  if (
    rel === '' ||
    rel === '..' ||
    rel.startsWith(`..${sep}`) ||
    isAbsolute(rel)
  )
    return null;
  return rel.split(sep).join('/');
}

// Whether the sweep-relative path is still present on disk AS A REGULAR FILE
// (lstat: never through a link). A directory, a symlink or a FIFO/socket in
// its place means the file the tool wrote is gone — a real delete the walk
// cannot report, since it skips links and never journals a directory. A probe
// that cannot answer (EACCES) reads as "present": the sweep never records a
// delete it cannot prove. ENOENT and ENOTDIR (a parent component is a regular
// file) prove absence.
function regularFileStillThere(
  bridge: FileBridge,
  root: string,
  relPath: string,
): boolean {
  const abs = join(root, relPath);
  const cannotTell = (error: unknown): boolean => {
    const code = (error as { code?: string } | null)?.code;
    return code !== 'ENOENT' && code !== 'ENOTDIR';
  };
  try {
    if (!bridge.exists(abs)) return false;
  } catch (error) {
    return cannotTell(error);
  }
  try {
    const info = bridge.fileInfo(abs);
    // `isFile` undefined = the bridge did not classify it: a regular file.
    return !info.isDirectory && !info.isSymbolicLink && info.isFile !== false;
  } catch (error) {
    return cannotTell(error);
  }
}

// End-of-run sweep: whatever moved without interception gets an
// unattributed entry — sed -i, npm install fallout, formatters, builds.
// Before-content is unknowable for these (the baseline holds hashes, not
// copies), so beforeHash is recorded but no before-blob exists: undo of
// unattributed entries is reported non-reversible by the next issue's CLI.
export function reconcile(
  store: FileJournalStore,
  baseline: Baseline,
  root: string,
  ctx: ReconcileContext,
  options: BaselineOptions = {},
): number {
  // Same read seam as captureBaseline (review finding): the hash honoured
  // `options.bridge` but this after-content read used the module-level node
  // bridge, so an injected double observed only half the walk — and a test
  // proved a bound production did not fully have. One bridge for the whole
  // reconcile now.
  const bridge = options.bridge ?? createNodeFileBridge('/');
  const outOfScope = options.outOfScope ?? [];
  const current = captureBaseline(root, options);
  // Issue #341: each path's EXPECTED state is the last entry journaled
  // during THIS run, else the boot baseline — never "matches the baseline
  // OR any historical after-hash", which hid same-run reverts, a resumed
  // session's change back to an older hash, and repeat deletes.
  // `null` = expected absent.
  const sinceStart = new Map<string, string | null>();
  for (const e of entriesSinceRunStart(store.entries(), ctx.runStart)) {
    // Tools journal `args.path` verbatim (absolute or './'-prefixed), while
    // the walk keys are root-relative: normalize before keying, and drop a
    // path outside the root — it is never a sweep candidate.
    const key = rootRelativeKey(root, e.path);
    if (key !== null) sinceStart.set(key, e.afterHash);
  }
  const expectedHash = (relPath: string): string | null => {
    if (sinceStart.has(relPath)) return sinceStart.get(relPath) ?? null;
    return baseline[relPath] ?? null;
  };
  let added = 0;
  const record = (input: {
    path: string;
    op: JournalEntryInput['op'];
    beforeHash: string | null;
    after: string | null;
    afterHash?: string;
    afterOmitted?: boolean;
    afterBytes?: number;
  }): void => {
    store.append({
      path: input.path,
      op: input.op,
      before: null,
      beforeHash: input.beforeHash,
      after: input.after,
      ...(input.afterHash === undefined ? {} : { afterHash: input.afterHash }),
      ...(input.afterOmitted === true ? { afterOmitted: true } : {}),
      ...(input.afterBytes === undefined
        ? {}
        : { afterBytes: input.afterBytes }),
      bytesDelta: 0,
      sessionId: ctx.sessionId,
      agentId: ctx.agentId,
      toolCallId: null,
      timestamp: ctx.timestamp,
      unattributed: true,
    });
    added++;
  };
  for (const [relPath, hash] of Object.entries(current)) {
    // Declared out of scope (§35, issue #115): never read, never journaled.
    // The walk above already prunes an excluded directory, so this states the
    // rule for a path that reaches the sweep any other way.
    if (isOutOfScope(relPath, outOfScope)) continue;
    const expected = expectedHash(relPath);
    if (expected === hash) continue;
    const abs = join(root, relPath);
    let size: number | null = null;
    try {
      size = bridge.fileInfo(abs).size;
    } catch {
      // Vanished since the walk: no size to bound a read by, so the entry
      // records no after-side — exactly the pre-#120 shape for this race.
    }
    let after: string | null = null;
    let omitted = false;
    if (size !== null && size > MAX_SWEEP_CONTENT_BYTES) {
      // Above the bound (issue #120): never read whole. Hash-only, with the
      // walk hash intact, rendered as a size-only change.
      omitted = true;
    } else if (size !== null) {
      try {
        // At or under the bound: one read, bytes first — the lossless check
        // needs the bytes the decode came from, and the range read is
        // bounded by the size just observed.
        const bytes =
          bridge.readFileRange === undefined
            ? bridge.readBinaryFile(abs)
            : bridge.readFileRange(abs, 0, size);
        after = decodeLossless(bytes);
        // decodeLossless returns null only for a lossy decode (binary
        // content): record hash-only instead of a mangled blob.
        omitted = after === null;
      } catch {
        after = null;
      }
    }
    record({
      path: relPath,
      op: expected === null ? 'create' : 'write',
      beforeHash: expected,
      after,
      // The hash-only shape: the walk hash keeps dedupe and undo staleness
      // comparing the same digest the baseline walk produced, and the
      // observed size is what `diff` renders (`[content not captured — N
      // bytes changed]`). `omitted` is only ever set when size is known.
      ...(omitted && size !== null
        ? { afterHash: hash, afterOmitted: true, afterBytes: size }
        : {}),
    });
  }
  const candidates = new Set([...Object.keys(baseline), ...sinceStart.keys()]);
  for (const relPath of candidates) {
    // The same rule in the delete direction (issue #115): a baseline captured
    // before the entry was declared — or supplied by a caller — can name
    // out-of-scope paths, and their disappearance is not a journal event
    // either.
    if (isOutOfScope(relPath, outOfScope)) continue;
    if (current[relPath] !== undefined) continue;
    const expected = expectedHash(relPath);
    if (expected === null) continue;
    // A path only a tool journaled (not in the boot baseline) is absent from
    // `current` whenever the walk skips it — gitignored, `.git/`, `.kubic/` —
    // while the regular file is still on disk: no delete happened, so none is
    // recorded (issue #341 regression). Replaced by a directory or a link it
    // IS a delete. Baseline keys keep the old rule.
    if (
      baseline[relPath] === undefined &&
      regularFileStillThere(bridge, root, relPath)
    )
      continue;
    record({
      path: relPath,
      op: 'delete',
      beforeHash: expected,
      after: null,
    });
  }
  return added;
}
