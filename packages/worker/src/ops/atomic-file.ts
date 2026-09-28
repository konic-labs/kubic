// Shared write path for the mutating ops (write, edit): exact pre-image
// capture and a crash-consistent tmp+rename that preserves the replaced
// file's mode. All I/O goes through the confined ctx.env.fs seam.

import { createHash } from 'node:crypto';
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
  const tmp = `${path}.kubic-tmp`;
  ctx.env.fs.writeFile(tmp, content);
  if (pre.mode !== undefined) ctx.env.fs.chmod?.(tmp, pre.mode);
  ctx.env.fs.rename(tmp, path);
}
