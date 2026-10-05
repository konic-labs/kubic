// Shared write path for the mutating ops (write, edit): exact pre-image
// capture and a crash-consistent tmp+rename that preserves the replaced
// file's mode. All I/O goes through the confined ctx.env.fs seam.

import { createHash } from 'node:crypto';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import type { FileSystem } from '../../../exec/src/env.js';
import type { JournalEntryInput } from '../../../exec/src/journal.js';
import { HASH_CHUNK_BYTES } from '../../../exec/src/journal.js';
import type { OpContext } from './types.js';
import { OpError } from './types.js';

export interface PreImage {
  exists: boolean;
  /** Lossless utf-8 text of the file, or null (absent, or binary content). */
  text: string | null;
  /** sha256 of the file's real bytes, null when absent. */
  hash: string | null;
  bytes: number;
  mode: number | undefined;
}

// Above this size the pre-image is never held in memory (issue #139): the
// file is hashed in bounded chunks and recorded hash-only. 8 MiB matches the
// text bound read and edit share (READ_MAX_BYTES / EDIT_MAX_BYTES): a text op
// stays text up to there, and above it the journal keeps the change visible
// at a bounded cost — undo reports the entry non-reversible, exactly as it
// does for a binary pre-image or the sweep's hash-only after-side (#120).
export const PREIMAGE_MAX_BYTES = 8 * 1024 * 1024;

// Chunk size for that streamed hashing: the journal's own streamed-hash chunk
// (issue #107), imported rather than re-declared so there is one source of
// truth for "how much of a file is held at once".
export const PREIMAGE_CHUNK_BYTES = HASH_CHUNK_BYTES;

// Reads the file's bytes when the seam can (readFileRange), so the recorded
// hash is of the real bytes and binary content is detected instead of being
// decoded to U+FFFD and journaled as a mangled "pre-image" that undo would
// then write back. Above PREIMAGE_MAX_BYTES the bytes are streamed through
// the hash instead of being held: same digest (it is over the raw bytes
// either way), no decode, and the pre-image is hash-only.
export function readPreImage(ctx: OpContext, path: string): PreImage {
  const fs = ctx.env.fs;
  let size: number;
  let mode: number | undefined;
  try {
    const info = fs.stat(path);
    if (!info.isFile) throw new Error('not a file');
    size = info.size;
    mode = info.mode;
  } catch {
    return { exists: false, text: null, hash: null, bytes: 0, mode: undefined };
  }
  if (fs.readFileRange !== undefined) {
    const readRange = fs.readFileRange.bind(fs);
    if (size > PREIMAGE_MAX_BYTES) {
      // Issue #139: a whole-file pre-image costs ~3x the file (buffer +
      // decode + re-encode check) and `write` has no size guard, so one
      // overwrite of a multi-GB file OOMs the worker and journals the
      // content verbatim. Hash it chunk by chunk instead: bounded memory,
      // the same digest, and text: null makes the entry hash-only
      // (write.ts records beforeOmitted; undo reports it non-reversible).
      const streamed = hashRawBytes(readRange, path, size);
      return {
        exists: true,
        text: null,
        hash: streamed.hash,
        bytes: streamed.bytes,
        mode,
      };
    }
    const raw = Buffer.from(readRange(path, 0, size));
    const decoded = raw.toString('utf8');
    const lossless = Buffer.from(decoded, 'utf8').equals(raw);
    return {
      exists: true,
      text: lossless ? decoded : null,
      hash: createHash('sha256').update(raw).digest('hex'),
      bytes: raw.length,
      mode,
    };
  }
  const text = fs.readFile(path);
  return {
    exists: true,
    text,
    hash: createHash('sha256').update(text, 'utf8').digest('hex'),
    bytes: Buffer.byteLength(text, 'utf8'),
    mode,
  };
}

// The sha256 of a file's raw bytes, one PREIMAGE_CHUNK_BYTES chunk at a
// time (issue #139): peak memory is the chunk, never the file. The loop
// advances by what a chunk actually delivered (a short read — the file
// shrank after `stat` — must not be counted as hashed, nor skipped over),
// and returns the bytes really read, so `bytesDelta` describes the file as
// it was.
function hashRawBytes(
  readRange: NonNullable<FileSystem['readFileRange']>,
  path: string,
  size: number,
): { hash: string; bytes: number } {
  const hash = createHash('sha256');
  let at = 0;
  while (at < size) {
    const end = Math.min(at + PREIMAGE_CHUNK_BYTES, size);
    const chunk = readRange(path, at, end);
    if (chunk.length === 0) break;
    hash.update(chunk);
    at += chunk.length;
  }
  return { hash: hash.digest('hex'), bytes: at };
}

// Journal-first replace: the entry is durable BEFORE the file changes, so a
// crash can never leave an unrecorded mutation (at worst a recorded one
// that never landed, which undo reads as already-undone). A journal failure
// aborts the op with the file untouched. The tmp takes the replaced file's
// mode before the rename; a new file keeps the umask default.
//
// Issue #140: the tmp+rename follows symlinks. `path` may name a link (to a
// file, or to a directory on the way), and renaming onto the LINK's own
// name replaces the link with a regular file — the link is silently lost
// and its target keeps the old content. The tmp is written beside the
// RESOLVED file and renamed onto it, so the link survives and the real file
// changes. The journal records the RESOLVED path in that case, so the
// end-of-run sweep (§42) keys the file the walk sees and undo restores the
// target instead of replacing the link. A resolution that leaves the
// workspace is refused first (a `symlink_escape` OpError, journal
// untouched): following the link would write outside the guardrail. A
// failed write or rename removes its tmp.
export function replaceFile(
  ctx: OpContext,
  opName: string,
  path: string,
  content: string,
  pre: PreImage,
  entry: Omit<
    JournalEntryInput,
    'sessionId' | 'agentId' | 'toolCallId' | 'timestamp' | 'path'
  >,
): void {
  const write = writeTarget(ctx, opName, path);
  if (ctx.journal !== undefined) {
    try {
      ctx.journal.append({
        path: write.journalPath,
        ...entry,
        sessionId: ctx.sessionId,
        agentId: ctx.agentId,
        toolCallId: ctx.toolCallId ?? null,
        timestamp: Date.now(),
      });
    } catch (error) {
      throw new OpError(
        'journal_failed',
        `${opName} not applied: journal record failed: ${(error as Error).message}`,
      );
    }
  }
  const target = write.target;
  sweepTmpResidue(ctx.env.fs, target);
  const tmp = tmpNameFor(target);
  // A stale tmp can already sit at this exact name (a crashed run, then pid
  // reuse): clear it best-effort first, so the write never inherits its
  // content or mode, and so a planted symlink at the name cannot redirect
  // the tmp write. Absent unlink = nothing to clear.
  removeTmpBestEffort(ctx.env.fs, tmp);
  try {
    ctx.env.fs.writeFile(tmp, content);
    if (pre.mode !== undefined) ctx.env.fs.chmod?.(tmp, pre.mode);
    ctx.env.fs.rename(tmp, target);
  } catch (error) {
    removeTmpBestEffort(ctx.env.fs, tmp);
    throw error;
  }
}

interface WriteTarget {
  /** Where the bytes must land: the caller's path with symlinks resolved. */
  target: string;
  /**
   * What the journal records: the caller's path verbatim, unless a link was
   * followed — then the resolved file, relative to the workspace root.
   */
  journalPath: string;
}

function inside(base: string, path: string): boolean {
  return path === base || path.startsWith(base + sep);
}

// Root-relative, '/'-separated (the walk's key spelling), so a journaled
// path keys exactly like the baseline entry for the same file.
function rootKey(base: string, path: string): string {
  return relative(base, path).split(sep).join('/');
}

// Where a write to `path` must land, and whether that is allowed. The
// caller's named path is kept when the seam cannot resolve links (test
// doubles, an unresolvable component) — there the seam's own confinement
// and the OS decide, exactly as before #140.
function writeTarget(
  ctx: OpContext,
  opName: string,
  path: string,
): WriteTarget {
  const fs = ctx.env.fs;
  const cwd = resolve(ctx.env.cwd);
  const lexical = resolve(cwd, path);
  const root = resolveThroughLinks(fs, cwd);
  const target = resolveThroughLinks(fs, path);
  if (root === undefined || target === undefined)
    return { target: path, journalPath: path };
  if (!inside(root, target)) {
    // Refuse a target that resolves outside the workspace — but only when
    // the caller's path was inside it: lexically, or spelled through the
    // workspace root's own realpath (macOS /tmp and /var resolve to
    // /private/…, and the seam accepts that spelling). A path outside the
    // workspace entirely is the seam's confinement to refuse, with its own
    // honest error.
    if (inside(cwd, lexical) || inside(root, lexical)) {
      throw new OpError(
        'symlink_escape',
        `${opName} not applied: '${path}' resolves to '${target}', outside the workspace`,
      );
    }
    return { target: path, journalPath: path };
  }
  // A link was followed exactly when the resolved file is not the one the
  // caller's path names. Then the journal names the file whose content
  // actually changed: the sweep keys it like the walk does, `diff` shows the
  // real path, and undo restores the target instead of replacing the link.
  const resolvedKey = target === root ? undefined : rootKey(root, target);
  const lexicalKey = inside(cwd, lexical) ? rootKey(cwd, lexical) : undefined;
  const journalPath =
    resolvedKey !== undefined && resolvedKey !== lexicalKey
      ? resolvedKey
      : path;
  return { target, journalPath };
}

// The physical spelling of `path`: every existing prefix resolved, the
// components that do not exist yet appended verbatim (a write may create
// them). undefined when the seam cannot resolve links at all, or when a
// component fails for a reason other than "does not exist" — EACCES, ELOOP
// — because guessing the verbatim path there could hide a link the OS would
// follow. The caller then falls back to the named path, whose confinement
// the seam enforces as before.
function resolveThroughLinks(fs: FileSystem, path: string): string | undefined {
  const realpath = fs.realpath;
  if (realpath === undefined) return undefined;
  let head = path;
  const missing: string[] = [];
  for (;;) {
    try {
      const real = realpath.call(fs, head);
      return missing.length === 0 ? real : join(real, ...missing);
    } catch (error) {
      const code = (error as { code?: string } | null)?.code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return undefined;
      const parent = dirname(head);
      if (parent === head) return undefined;
      missing.unshift(basename(head));
      head = parent;
    }
  }
}

// A tmp name no other writer can collide with: beside the target (same
// directory, so the rename is atomic) and unique per process and per call.
let tmpSeq = 0;

function tmpNameFor(target: string): string {
  tmpSeq += 1;
  return `${target}.kubic-tmp-${process.pid}-${tmpSeq}`;
}

function removeTmpBestEffort(fs: FileSystem, tmp: string): void {
  try {
    fs.unlink?.(tmp);
  } catch {
    // Best-effort: the write/rename failure is the error the caller must
    // see, and a tmp that cannot be removed is not a second failure to
    // report. Seams without unlink leave it for the operator.
  }
}

// Crash residue from an earlier run — a tmp whose write or rename never
// finished — is never overwritten (the name is pid- and call-unique), so it
// would sit in the workspace forever and the next sweep would journal it as
// an unattributed create: the failure mode this issue removes for
// exceptions, reached through the crash path instead. Collect the siblings
// this writer can name before writing, exactly as the journal's restore path
// collects its own `.kubic-restore-*` residue. Best-effort and confined to
// `<basename(target)>.kubic-tmp-*` in the target's own directory.
function sweepTmpResidue(fs: FileSystem, target: string): void {
  if (fs.listDir === undefined || fs.unlink === undefined) return;
  const dir = dirname(target);
  const prefix = `${basename(target)}.kubic-tmp-`;
  let names: string[];
  try {
    names = fs.listDir(dir);
  } catch {
    return; // An unreadable or absent directory has nothing to sweep.
  }
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    removeTmpBestEffort(fs, join(dir, name));
  }
}
