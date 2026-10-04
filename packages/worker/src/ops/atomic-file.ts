// Shared write path for the mutating ops (write, edit): exact pre-image
// capture and a crash-consistent tmp+rename that preserves the replaced
// file's mode. All I/O goes through the confined ctx.env.fs seam.

import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve, sep } from 'node:path';
import type { FileSystem } from '../../../exec/src/env.js';
import type { JournalEntryInput } from '../../../exec/src/journal.js';
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

// Reads the file's bytes when the seam can (readFileRange), so the recorded
// hash is of the real bytes and binary content is detected instead of being
// decoded to U+FFFD and journaled as a mangled "pre-image" that undo would
// then write back.
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
    const raw = Buffer.from(fs.readFileRange(path, 0, size));
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
// changes. A resolution that leaves the workspace is refused first (a
// `symlink_escape` OpError, journal untouched): following the link would
// write outside the guardrail. A failed write or rename removes its tmp.
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
  const target = writeTarget(ctx, opName, path);
  if (ctx.journal !== undefined) {
    try {
      ctx.journal.append({
        path,
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

// Where a write to `path` must land, and whether that is allowed. The
// caller's named path is kept when the seam cannot resolve links (test
// doubles) or when the path is already outside the workspace lexically —
// there the seam's own confinement error is the honest one.
function writeTarget(ctx: OpContext, opName: string, path: string): string {
  const fs = ctx.env.fs;
  const cwd = resolve(ctx.env.cwd);
  const lexical = resolve(cwd, path);
  if (lexical !== cwd && !lexical.startsWith(cwd + sep)) return path;
  const root = resolveThroughLinks(fs, cwd);
  const target = resolveThroughLinks(fs, path);
  if (root === undefined || target === undefined) return path;
  if (target !== root && !target.startsWith(root + sep)) {
    throw new OpError(
      'symlink_escape',
      `${opName} not applied: '${path}' resolves to '${target}', outside the workspace`,
    );
  }
  return target;
}

// The physical spelling of `path`: every existing prefix resolved, the
// components that do not exist yet appended verbatim (a write may create
// them). undefined when the seam cannot resolve links at all or reaches the
// filesystem root without resolving anything.
function resolveThroughLinks(fs: FileSystem, path: string): string | undefined {
  const realpath = fs.realpath;
  if (realpath === undefined) return undefined;
  let head = path;
  const missing: string[] = [];
  for (;;) {
    try {
      const real = realpath.call(fs, head);
      return missing.length === 0 ? real : join(real, ...missing);
    } catch {
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
