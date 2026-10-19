import { dirname } from 'node:path';
import type { BridgeFileInfo, FileBridge } from '../file-bridge.js';
import { flushDurably } from './flush.js';
import type { JournalEntry, JournalIndexRead, JournalSource } from './types.js';
import { JOURNAL_RECORD_VERSION } from './types.js';

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

/** One index line: the entry, stamped with the record version. */
export function serializeEntry(entry: JournalEntry): string {
  return JSON.stringify({ v: JOURNAL_RECORD_VERSION, ...entry });
}

// The index's tail, as `readTail` reports it: `size` is the
// byte length a failed append truncates back to, null when it could not be
// read; `fragment` means the last byte is not a newline, so the next append
// must close the line first.
interface IndexTail {
  size: number | null;
  fragment: boolean;
}

// What a rewrite did: it replaced the index, or it left it alone because the
// index changed under the pass, or because the rewrite itself failed.
export type IndexRewrite =
  | { outcome: 'written' }
  | { outcome: 'changed' }
  | { outcome: 'failed' };

// `index.jsonl`: one JSON entry per line, appended durably and rewritten
// whole only by a retention pass.
export class IndexFile {
  readonly path: string;
  private readonly durable: boolean;
  // The current index.jsonl size in bytes, tracked
  // incrementally: every append adds the payload it wrote, every rewrite
  // sets it to the bytes it wrote, and a slow pass that dropped nothing
  // re-seeds it from the file itself. null means "unknown" and forces the
  // slow pass — the bound covers the whole store, so an unaccounted index
  // cannot be proven under it.
  bytes: number | null = null;
  // The lines of the last read whose record version this build cannot
  // interpret, verbatim: a rewrite of the same file keeps them.
  private unknownLines: string[] = [];

  constructor(path: string, durable: boolean) {
    this.path = path;
    this.durable = durable;
  }

  // The index as read: the parseable entries plus the count of
  // lines dropped on the way.
  read(bridge: FileBridge): JournalIndexRead {
    const out: JournalEntry[] = [];
    this.unknownLines = [];
    if (!bridge.exists(this.path)) {
      return { entries: out, corruptLines: 0, unknownVersionLines: 0 };
    }
    let corruptLines = 0;
    for (const line of bridge.readTextFile(this.path).split('\n')) {
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
      if (typeof parsed === 'object' && parsed !== null) {
        const { v, ...entry } = parsed as Record<string, unknown>;
        if (v !== undefined && v !== JOURNAL_RECORD_VERSION) {
          this.unknownLines.push(line);
          continue;
        }
        parsed = entry;
      }
      out.push(withSource(parsed));
    }
    return {
      entries: out,
      corruptLines,
      unknownVersionLines: this.unknownLines.length,
    };
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
  //
  // The index's own growth is part of the bound, so the tracked size moves
  // with the append (the repair byte included — it is bytes in the file like
  // any other).
  append(bridge: FileBridge, line: string): void {
    // One stat per append: the pre-append length is both the truncate
    // target and the position the tail probe reads.
    const tail = this.readTail(bridge);
    const payload = (tail.fragment ? '\n' : '') + line;
    try {
      // Durable append: the crash-safety seam. Production takes
      // `appendDurably` (fsync before this returns); a bridge double without
      // it keeps the plain append, and `durable: false` opts out explicitly.
      if (this.durable && bridge.appendDurably !== undefined) {
        // 0600 at creation; an existing index keeps its mode.
        bridge.appendDurably(this.path, payload, { mode: 0o600 });
      } else {
        bridge.appendFile(this.path, payload, { mode: 0o600 });
      }
    } catch (error) {
      if (tail.size !== null) this.truncateTo(bridge, tail.size);
      throw error;
    }
    if (this.bytes !== null) this.bytes += Buffer.byteLength(payload, 'utf8');
  }

  // The index file's real size, 0 when it does not exist yet and
  // null when it cannot be read (which forces the slow pass rather than
  // guessing a size the bound would then trust).
  fileSize(bridge: FileBridge): number | null {
    try {
      return bridge.exists(this.path) ? bridge.fileInfo(this.path).size : 0;
    } catch {
      return null;
    }
  }

  // Replace the index with `kept` — what a retention pass decided to keep.
  // `sizeAtRead` is the index size sampled before the pass read it: the
  // rewrite is only safe while the file is still that file. A writer that
  // does not hold the mutation lock (an older build, a hand edit) can append
  // at any point, and the rename would drop that line silently, so the
  // rewrite is abandoned when the index changed under it — the pass keeps
  // nothing it cannot prove is still current: the next pass sees the new
  // state, and the line that landed is never lost. (The mutation lock makes
  // this window impossible for a cooperating writer; this is the guard for
  // one that is not.)
  rewrite(
    bridge: FileBridge,
    kept: JournalEntry[],
    sizeAtRead: number | null,
  ): IndexRewrite {
    const tmp = `${this.path}.${process.pid}.tmp`;
    // The same serialization is measured and written, so the
    // tracked index size after the rewrite is exact.
    // A line of another record version is kept as it was: this build
    // cannot judge its age or size, and must not destroy it. The rewrite only
    // runs while the file is still the one read, so these are its lines.
    const lines = [...kept.map(serializeEntry), ...this.unknownLines];
    const serialized = lines.join('\n') + (lines.length > 0 ? '\n' : '');
    bridge.writeFile(tmp, serialized, { mode: 0o600 });
    try {
      const sizeNow = this.fileSize(bridge);
      if (sizeAtRead !== null && sizeNow !== sizeAtRead) {
        bridge.remove(tmp, false, true);
        this.bytes = null;
        return { outcome: 'changed' };
      }
      // The rewrite replaces the journal's whole history, so
      // with `durable` on its bytes are fsynced before the rename and the
      // directory after it. Without that, a crash right after the rename
      // can leave an empty or truncated index where the old one was —
      // losing everything the compaction was supposed to keep.
      flushDurably(this.durable, () => bridge.flushFile?.(tmp));
      bridge.renameFile(tmp, this.path);
      flushDurably(this.durable, () => bridge.flushDir?.(dirname(this.path)));
    } catch {
      try {
        bridge.remove(tmp, false, true);
      } catch {
        // Best-effort tmp cleanup; the index rewrite is what matters.
      }
      return { outcome: 'failed' };
    }
    this.bytes = Buffer.byteLength(serialized, 'utf8');
    return { outcome: 'written' };
  }

  // The index's tail as an append needs it: its byte length —
  // the truncate target for a failed append — and whether it ends in a
  // fragment. One stat plus one pread of the last byte. Anything unreadable
  // reports `size: null, fragment: true`: never guess a length to truncate
  // to (losing the index is worse than a partial line the next append
  // repairs), and repair the tail (a needless newline costs a blank line
  // `read` skips and the next rewrite drops, while a missing one loses
  // the entry this append is writing).
  private readTail(bridge: FileBridge): IndexTail {
    let info: BridgeFileInfo;
    try {
      // One lstat per append. `exists()` + `fileInfo()` asked the
      // same question twice (both are lstats).
      info = bridge.fileInfo(this.path);
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
      const last = bridge.readFileRange?.(this.path, size - 1, size);
      return { size, fragment: last?.[0] !== 0x0a };
    } catch {
      return { size, fragment: true };
    }
  }

  // Best-effort: `truncateFile` is optional on the bridge and can fail on
  // its own (the failed append's error is the one the caller must see). A
  // bridge without it degrades to the tail repair on the next append.
  private truncateTo(bridge: FileBridge, size: number): void {
    try {
      bridge.truncateFile?.(this.path, size);
    } catch {
      // Left as-is.
    }
  }
}
