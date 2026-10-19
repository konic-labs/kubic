import type { FileBridge } from '../file-bridge.js';
import type { BlobStore } from './blobs.js';
import { type IndexFile, serializeEntry } from './index-file.js';
import type { JournalEntry, RetentionPolicy } from './types.js';

// A pass that has to prune frees a tenth of the bound (a byte low-water
// mark). The index counts against the bound, so a store sitting at its cap
// would otherwise rewrite the whole index on every append; freeing a chunk
// makes compaction amortized (with the default 100 MiB bound, roughly one
// rewrite per 10 MiB of appended lines) while the store never exceeds
// `maxBytes`.
const RETENTION_DROP_SHARE = 10;

// The unique blobs an entry references: its before pre-image plus either its
// delta or its after-blob (a delta entry has no after-blob).
// Collapsed per entry: a no-op write with before === after references the
// same blob once, and the retention refcounts are per entry.
/** @internal */
export function blobHashesOf(entry: JournalEntry): string[] {
  const hashes: string[] = [];
  if (entry.beforeHash !== null) hashes.push(entry.beforeHash);
  if (entry.deltaHash !== null) hashes.push(entry.deltaHash);
  else if (entry.afterHash !== null) hashes.push(entry.afterHash);
  return [...new Set(hashes)];
}

// The bytes one index line occupies: the entry's JSON plus its
// terminating newline, exactly what an append writes and what a
// retention rewrite re-emits. The size bound counts these — content
// addressing dedupes blobs, so a file toggling between two contents grows the
// journal through its lines alone.
function indexLineBytes(entry: JournalEntry): number {
  return Buffer.byteLength(`${serializeEntry(entry)}\n`, 'utf8');
}

// The minimum timestamp in a kept set — what an age policy's
// fast path compares against `now`. The minimum, not the first entry: a
// journal can carry entries appended out of timestamp order (reconciliation
// writes real clock stamps into a session whose other entries were seeded),
// and only the minimum proves that nothing has aged out.
/** @internal */
export function oldestTimestampOf(entries: JournalEntry[]): number | null {
  let oldest: number | null = null;
  for (const entry of entries) {
    if (oldest === null || entry.timestamp < oldest) oldest = entry.timestamp;
  }
  return oldest;
}

export interface RetentionPlan {
  // The entries the pass keeps, oldest first.
  kept: JournalEntry[];
  // The blobs the kept entries reference.
  referenced: Set<string>;
  // Bytes the kept set is still over `policy.maxBytes` by,
  // when the newest entry alone cannot fit. 0 means the bound holds.
  overBound: number;
}

// Which entries a retention pass keeps, decided from the index and the blob
// sizes alone: `sizeOf` answers from the store's size cache, which the pass
// has already brought up to date, so planning does no I/O.
/** @internal */
export function planRetention(
  all: JournalEntry[],
  policy: RetentionPolicy,
  now: number,
  sizeOf: (hash: string) => number,
): RetentionPlan {
  // `kept` must not alias `all`: the drop loop shifts entries out of
  // `kept` while `all` stays the pre-drop index.
  let kept = [...all];
  if (policy.maxAgeMs !== undefined) {
    const maxAgeMs = policy.maxAgeMs;
    kept = kept.filter((e) => now - e.timestamp <= maxAgeMs);
  }
  // Reference-counted drop arithmetic: count the blobs each
  // kept entry references once, then each dropped entry subtracts only
  // the blobs it uniquely referenced.
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
    for (const hash of refs.keys()) total += sizeOf(hash);
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
            total -= sizeOf(hash);
            refs.delete(hash);
          } else if (count > 1) {
            refs.set(hash, count - 1);
          }
        }
      }
    }
    overBound = Math.max(0, total - maxBytes);
  }
  return { kept, referenced: new Set(refs.keys()), overBound };
}

// What a retention pass did: the entries it dropped, the blob bytes it freed
// (the blobs only dropped entries used, plus the unreferenced blob files its
// sweep removed — a pass that dropped no entry sweeps nothing and frees 0
// bytes), and the bytes the kept set is still over the bound by, when the
// newest entry alone cannot fit (0 means the bound holds).
export interface RetentionResult {
  entries: number;
  bytes: number;
  overBound: number;
}

// A fresh result for a pass that pruned nothing.
export function nothingPruned(): RetentionResult {
  return { entries: 0, bytes: 0, overBound: 0 };
}

// An age bound of 0 ms or less is one nothing fits: every entry is at least
// that old, so a pass would empty the journal. Retention off is an unset
// bound, so such a value is refused by name, never read as "drop everything".
export function checkAgeBound(maxAgeMs: number | undefined): void {
  if (maxAgeMs !== undefined && !(maxAgeMs > 0)) {
    throw new RangeError(
      `journal maxAgeMs must be a positive number of milliseconds (got ${maxAgeMs}); leave it unset for no age bound`,
    );
  }
}

// The retention executor of one store: a pass that applies the plan under
// the store's mutation lock, and the caches its fast path proves the bounds
// from.
export class Retention {
  private readonly index: IndexFile;
  private readonly blobs: BlobStore;
  // The oldest timestamp in the index (the minimum, not the
  // first — entries can carry non-monotonic timestamps). Seeded by every
  // slow pass and updated on every rewrite, it is what lets an age policy
  // take the fast path: `now - oldest <= maxAgeMs` proves from cache that no
  // entry can have aged out, so the index needs no read at all. null means
  // "unknown" (never seeded, or the last rewrite failed) and forces the
  // slow pass.
  private oldestTimestamp: number | null = null;

  constructor(index: IndexFile, blobs: BlobStore) {
    this.index = index;
    this.blobs = blobs;
  }

  // An append landed. Entries can be appended out of timestamp order (a
  // backwards clock step), so the cached minimum is folded with this entry
  // too — otherwise the age fast path could prove "nothing aged out" from a
  // cache that is higher than the truth and an expired entry would linger.
  // A null cache stays null: only a pass may seed it.
  noteAppended(timestamp: number): void {
    if (this.oldestTimestamp !== null) {
      this.oldestTimestamp = Math.min(this.oldestTimestamp, timestamp);
    }
  }

  // One pass over the store. The caller holds the mutation lock; `readEntries`
  // reads the index and `prepareDirs` readies the state directories before a
  // rewrite.
  run(
    bridge: FileBridge,
    policy: RetentionPolicy,
    readEntries: () => JournalEntry[],
    prepareDirs: () => void,
  ): RetentionResult {
    checkAgeBound(policy.maxAgeMs);
    const now = policy.now ?? Date.now();
    if (this.withinBoundsFromCache(policy, now)) return nothingPruned();
    // The size of the index this pass is about to read, sampled
    // BEFORE the read: the rewrite is only safe while the file is still that
    // file (see IndexFile.rewrite). Sampled first so an append that lands
    // during or after the read always moves the size: sampling after the read
    // would swallow an append that landed inside it, and the rename would
    // then drop a line the pass never saw. A false abandon (the line was read
    // and is kept) only costs the next pass a retry.
    const sizeAtRead = this.index.fileSize(bridge);
    const all = readEntries();
    // Truth derivation: a slow pass re-stats
    // every referenced blob exactly once — O(M) per pass — so the drop
    // decisions and the freed-byte report match live truth (a missing blob
    // counts zero, a replaced blob counts its real size). Everything after it
    // is cache-pure. The seeding pass (no tracked total yet) skips the
    // re-stat: its cached sizes were recorded at write time earlier in this
    // session (fresh under the single-writer assumption documented on
    // BlobStore) and any other hash is stat'd live on cache miss — there is
    // nothing yet to heal.
    const refresh = this.blobs.tracked !== null;
    const every = new Set<string>();
    for (const e of all) {
      for (const hash of blobHashesOf(e)) every.add(hash);
    }
    for (const hash of every) this.blobs.sizeOf(bridge, hash, refresh);
    const plan = planRetention(all, policy, now, (hash) =>
      this.blobs.sizeOf(bridge, hash),
    );
    if (plan.kept.length === all.length) {
      // Re-base the tracked total on derived truth at the end of every slow
      // pass — age-only ones included — so the fast path resumes proving
      // "nothing can drop" from live truth. The index was not rewritten, so the
      // kept set IS what is on disk: the oldest timestamp can be re-seeded from
      // it and the index's own size is the file's real size — corrupt residue
      // included, so the bound never under-counts it.
      this.blobs.syncTracking(
        plan.referenced,
        this.blobs.bytes(bridge, plan.kept),
      );
      this.oldestTimestamp = oldestTimestampOf(plan.kept);
      this.index.bytes = this.index.fileSize(bridge);
      return { entries: 0, bytes: 0, overBound: plan.overBound };
    }
    return this.apply(bridge, all, plan, every, sizeAtRead, prepareDirs);
  }

  // Fast path: the pass can be skipped outright —
  // index reads included — when both bounds are provable from cache. The
  // tracked byte total (index + blobs) is an upper bound on
  // what the store occupies, so being at or under the size bound proves
  // nothing can drop; the oldest entry in the index must be inside the age
  // window too (`oldestTimestamp` is the minimum, so
  // `now - oldest <= maxAgeMs` proves nothing can have aged out). A session
  // under either bound pays zero retention I/O per append, whether or not
  // an age policy is configured.
  private withinBoundsFromCache(policy: RetentionPolicy, now: number): boolean {
    const ageProven =
      policy.maxAgeMs === undefined ||
      (this.oldestTimestamp !== null &&
        now - this.oldestTimestamp <= policy.maxAgeMs);
    const tracked = this.blobs.tracked;
    return (
      ageProven &&
      policy.maxBytes !== undefined &&
      tracked !== null &&
      this.index.bytes !== null &&
      tracked + this.index.bytes <= policy.maxBytes
    );
  }

  // Rewrite the index onto the planned kept set, then sweep the blobs only
  // dropped entries used.
  private apply(
    bridge: FileBridge,
    all: JournalEntry[],
    plan: RetentionPlan,
    every: Set<string>,
    sizeAtRead: number | null,
    prepareDirs: () => void,
  ): RetentionResult {
    const before = this.blobs.bytes(bridge, all);
    prepareDirs();
    const rewrite = this.index.rewrite(bridge, plan.kept, sizeAtRead);
    if (rewrite.outcome === 'changed') {
      // The caches describe the index this pass read, not the one that just
      // changed under it: dropping them makes the next pass re-derive truth
      // instead of proving a bound from a stale under-count.
      this.blobs.forgetTracking();
      this.oldestTimestamp = null;
      return nothingPruned();
    }
    if (rewrite.outcome === 'failed') return nothingPruned();
    const orphanBytes = this.blobs.sweep(bridge, plan.referenced, every);
    const after = this.blobs.bytes(bridge, plan.kept);
    // The rewrite moved the index onto the kept set: re-base the tracked total
    // on its truth so the fast path resumes proving "nothing can drop", and
    // re-seed the oldest timestamp from the entries that survived. Not done
    // when the rewrite failed: there the index still holds the dropped
    // entries, and a stale-older value only costs the next pass its fast
    // path, never correctness.
    this.blobs.syncTracking(plan.referenced, after);
    this.oldestTimestamp = oldestTimestampOf(plan.kept);
    return {
      entries: all.length - plan.kept.length,
      bytes: before - after + orphanBytes,
      overBound: plan.overBound,
    };
  }
}
