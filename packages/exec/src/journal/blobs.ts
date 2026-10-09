import { join } from 'node:path';
import { createNodeFileBridge, type FileBridge } from '../file-bridge.js';
import { flushDurably } from './flush.js';
import { sha256Hex } from './hash.js';
import type { JournalEntry } from './types.js';

// The content-addressed blob store under `blobs/`: one file per unique
// content, named by its sha256. It also keeps the byte accounting the
// retention fast path relies on: the size of every blob it has seen, and an
// upper bound on the bytes the current index references.
export class BlobStore {
  readonly dir: string;
  private readonly durable: boolean;
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
  private readonly sizes = new Map<string, number>();
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
  // `put` for content it writes, `trackRef` for hash-only refs), so
  // `trackedBytes <= maxBytes * 0.9` proves no entry can be dropped. null
  // until the first full pass seeds it from truth: a fresh store must run
  // one pass, or a journal left near the bound by a previous session would
  // never be pruned again.
  private trackedBytes: number | null = null;

  constructor(dir: string, durable: boolean) {
    this.dir = dir;
    this.durable = durable;
  }

  // The tracked upper bound, or null while it is unknown.
  get tracked(): number | null {
    return this.trackedBytes;
  }

  // Drop the tracked total: the index changed under a pass, so the next pass
  // must re-derive it from truth rather than prove a bound from it.
  forgetTracking(): void {
    this.trackedBytes = null;
  }

  has(hash: string): boolean {
    return createNodeFileBridge('/').exists(join(this.dir, hash));
  }

  count(): number {
    const bridge = createNodeFileBridge('/');
    if (!bridge.exists(this.dir)) return 0;
    return bridge
      .listDir(this.dir)
      .filter((info) => !info.isDirectory && !info.isSymbolicLink).length;
  }

  put(bridge: FileBridge, hash: string, content: string): void {
    const path = join(this.dir, hash);
    if (bridge.exists(path)) {
      // A blob under its own name is not proof of integrity. A
      // crash on a delayed-allocation filesystem can land the rename and
      // lose the data, leaving a zero-length or torn file at the address;
      // trusting the name would reuse that file forever, so every later
      // entry would read as corrupt. Size first (one stat — catches the truncated
      // crash shape without reading), then the content hash; a blob that
      // fails either check is rewritten from the bytes in hand.
      if (this.isIntact(bridge, path, hash, content)) {
        this.trackRef(bridge, hash);
        return;
      }
    }
    // tmp+rename: a blob becomes visible under its real name
    // only when complete — a crash can never expose half a blob to
    // `read`, and the tmp lives in the same directory (same filesystem),
    // so the rename is atomic. A failed write/rename cleans the tmp up,
    // best-effort, and fails the append: a silently appended entry whose
    // blob was never written would read as corrupt content.
    //
    // With `durable` on, the tmp's bytes are fsynced before the
    // rename and the directory after it. The index line that references
    // this blob is fsynced (appendDurably) later in `append`, so the order
    // is data-then-record: a durable entry can never point at a blob whose
    // bytes were still in the page cache when the power went.
    const tmp = join(this.dir, `${hash}.${process.pid}.tmp`);
    try {
      // 0600 at creation — a blob is a copy of file content,
      // including 0600 sources like `.env`; the rename keeps the mode.
      bridge.writeFile(tmp, content, { mode: 0o600 });
      flushDurably(this.durable, () => bridge.flushFile?.(tmp));
      bridge.renameFile(tmp, path);
      flushDurably(this.durable, () => bridge.flushDir?.(this.dir));
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
    // read and hashed again — the healing above is for files this store did
    // not write (crash residue, another process), and `read` still fails
    // closed on its own hash check if one is corrupted afterwards.
    this.writtenHere.add(hash);
    // Write-time size: the content is in hand, so no stat is needed —
    // this is what makes retention stat-free for what this store writes.
    const size = Buffer.byteLength(content, 'utf8');
    const previous = this.sizes.get(hash);
    this.sizes.set(hash, size);
    // A re-written blob (freed by an earlier prune, or deleted
    // externally) shifts the tracked total by its new size minus
    // whatever was counted for it before.
    if (this.trackedBytes !== null && this.accounted.has(hash)) {
      this.trackedBytes += size - (previous ?? 0);
      return;
    }
    this.trackRef(bridge, hash);
  }

  // Account a referenced hash not yet in `trackedBytes`. Shared by put's
  // write-time accounting and the hash-only refs of the reconcile shape,
  // so no reference can slip past the total uncounted: the fast path skips a
  // pruning pass exactly when `trackedBytes <= maxBytes * 0.9`, which is only
  // sound while trackedBytes never under-counts. One stat per hash not yet
  // accounted; over-counting a shared ref is acceptable — it only triggers
  // passes.
  trackRef(bridge: FileBridge, hash: string): void {
    if (this.trackedBytes !== null && !this.accounted.has(hash)) {
      this.accounted.add(hash);
      this.trackedBytes += this.sizeOf(bridge, hash);
    }
  }

  // Re-base the tracked total on derived truth. The fast
  // path's single compare is only sound while trackedBytes never
  // under-counts, so every full pass re-derives both numbers together.
  syncTracking(hashes: Iterable<string>, total: number): void {
    this.accounted.clear();
    for (const hash of hashes) this.accounted.add(hash);
    this.trackedBytes = total;
  }

  // Cached blob size. A cache miss stats once and remembers;
  // a missing blob counts zero — read paths handle the absence. `refresh`
  // re-stats even on a cache hit and re-records the result — used only by a
  // slow pass's truth derivation, so an external mutation (see `sizes`) can
  // never corrupt the drop set or the reported freed bytes the way a phantom
  // size would.
  sizeOf(bridge: FileBridge, hash: string, refresh = false): number {
    let size = this.sizes.get(hash);
    if (size === undefined || refresh) {
      try {
        size = bridge.fileInfo(join(this.dir, hash)).size;
      } catch {
        size = 0;
      }
      this.sizes.set(hash, size);
    }
    return size;
  }

  // The unique blob bytes a set of entries references: each entry's
  // before pre-image plus either its delta or its after-blob.
  bytes(bridge: FileBridge, entries: JournalEntry[]): number {
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

  // Content-addressed read: the blob's own name is the
  // contract. Content that does not hash to `hash` (torn write, tampering,
  // bit rot) fails closed to null — a wrong blob must never be served as
  // truth, especially to `undo` restore.
  read(hash: string, onCorrupt?: (detail: string) => void): string | null {
    const bridge = createNodeFileBridge('/');
    const path = join(this.dir, hash);
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

  // Remove the blob files no kept entry references, after a rewrite. Returns
  // the bytes of the orphans removed: files no entry referenced at all
  // (`every` is everything the index referenced before the pass), which the
  // freed-byte figure cannot otherwise see.
  //
  // The sweep only removes blobs that are unambiguously dead.
  // `${hash}.${pid}.tmp` is another process's in-flight write (the mutation
  // lock makes this impossible for a cooperating writer, and this guard is
  // what keeps a non-cooperating one — an older build, a hand copy — from
  // having its blob deleted between its write and its rename). A blob whose
  // mtime is newer than this pass started is the same story; an orphaned
  // blob is a leak, never corruption, so leaving one is always the safe
  // direction.
  sweep(
    bridge: FileBridge,
    referenced: ReadonlySet<string>,
    every: ReadonlySet<string>,
  ): number {
    const sweepStartedAt = Date.now();
    let orphanBytes = 0;
    if (!bridge.exists(this.dir)) return 0;
    for (const info of bridge.listDir(this.dir)) {
      if (info.isDirectory || info.isSymbolicLink) continue;
      if (info.name.endsWith('.tmp')) continue;
      // Whole milliseconds on both sides: `Date.now()` is truncated and
      // `mtimeMs` is not, so a blob written earlier in the pass's own
      // millisecond must not read as newer than the pass.
      if (Math.floor(info.mtimeMs) > sweepStartedAt) continue;
      if (referenced.has(info.name)) continue;
      try {
        bridge.remove(join(this.dir, info.name), false, true);
        if (!every.has(info.name)) orphanBytes += info.size;
      } catch {
        // Best-effort: an orphaned blob is a leak, not corruption.
      }
    }
    return orphanBytes;
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
  private isIntact(
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
}
