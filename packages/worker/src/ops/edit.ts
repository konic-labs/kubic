// Edit operation (issue #13, slice C; §9.1).
// Exact-match replacement with an explicit expected count: the default of 1
// refuses ambiguous matches instead of guessing. Atomic via tmp+rename.
// replay:"never" — edits are effects, never re-executed on replay.

import { readPreImage, replaceFile } from './atomic-file.js';
import { displayDiff } from './display-diff.js';
import { sha256Hex } from './hash.js';
import type { OpContext, Operation, ToolInvocation } from './types.js';
import { OpError } from './types.js';

export interface EditArgs {
  path: string;
  oldText: string;
  newText: string;
  expectCount?: number;
}

export interface EditResult {
  path: string;
  replacements: number;
  beforeHash: string;
  afterHash: string;
  bytesDelta: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateEditArgs(raw: unknown): EditArgs {
  if (!isRecord(raw))
    throw new OpError('invalid_args', 'edit args must be an object');
  for (const key of Object.keys(raw)) {
    if (
      key !== 'path' &&
      key !== 'oldText' &&
      key !== 'newText' &&
      key !== 'expectCount'
    ) {
      throw new OpError(
        'invalid_args',
        `edit: unknown argument "${key}" (strict sampling)`,
      );
    }
  }
  if (typeof raw.path !== 'string' || raw.path.length === 0) {
    throw new OpError('invalid_args', 'edit: path must be a non-empty string');
  }
  if (typeof raw.oldText !== 'string' || raw.oldText.length === 0) {
    throw new OpError(
      'invalid_args',
      'edit: oldText must be a non-empty string',
    );
  }
  if (typeof raw.newText !== 'string') {
    throw new OpError('invalid_args', 'edit: newText must be a string');
  }
  if (
    raw.expectCount !== undefined &&
    (!Number.isInteger(raw.expectCount) || (raw.expectCount as number) < 1)
  ) {
    throw new OpError(
      'invalid_args',
      'edit: expectCount must be a positive integer',
    );
  }
  return {
    path: raw.path,
    oldText: raw.oldText,
    newText: raw.newText,
    expectCount: raw.expectCount as number | undefined,
  };
}

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = text.indexOf(needle, from);
    if (at === -1) return count;
    count += 1;
    from = at + needle.length;
  }
}

// Above this size the edit op refuses before allocating anything (issue
// #122): split/join over a huge file is an unbounded allocation the model
// can trigger with one tool call. 8 MiB matches the read bound.
export const EDIT_MAX_BYTES = 8 * 1024 * 1024;

const BOM = '\uFEFF';

// Line-ending and BOM normalization (issue #195; §9.1, Pi's edit-diff.ts).
// A Windows-authored file must edit where Pi succeeds: matching happens on
// LF-normalized text with any leading BOM stripped, and the file's own
// ending and BOM are restored on write. Without this a CRLF file with an LF
// multi-line oldText is `no_match`, a first-line edit can mix endings, and a
// model whose reader stripped the BOM cannot match the first line at all.

/**
 * The dominant ending of `content`; a tie goes to LF. One `indexOf` pass
 * with O(1) extra memory — `match(/\n/g)` allocates an array element per
 * newline, ~8x a newline-dense 8 MiB file at the bound this op accepts.
 */
function detectLineEnding(content: string): '\r\n' | '\n' {
  let lf = 0;
  let crlf = 0;
  for (
    let at = content.indexOf('\n');
    at !== -1;
    at = content.indexOf('\n', at + 1)
  ) {
    lf += 1;
    if (at > 0 && content.charCodeAt(at - 1) === 13) crlf += 1;
  }
  return crlf > lf - crlf ? '\r\n' : '\n';
}

function normalizeToLF(content: string): string {
  return content.replace(/\r\n/g, '\n');
}

function restoreLineEndings(content: string, ending: '\r\n' | '\n'): string {
  return ending === '\r\n' ? content.replace(/\n/g, '\r\n') : content;
}

function stripBom(content: string): string {
  return content.startsWith(BOM) ? content.slice(1) : content;
}

export const editOperation: Operation<EditArgs, EditResult> = {
  name: 'edit',
  description:
    'Replace exact text in a file atomically (tmp + rename). oldText must match exactly (after line-ending/BOM normalization), whitespace included, and occur exactly expectCount times (default 1) or the edit is refused (no_match / ambiguous_match). Matching is done on LF-normalized text with any leading BOM stripped, and the file keeps its own line ending and BOM on write (a CRLF file stays CRLF). Files over 8 MiB are refused.',
  replay: 'never',
  validateArgs: validateEditArgs,
  execute: async (_inv: ToolInvocation, args: EditArgs, ctx: OpContext) => {
    // Size guard first (issue #122): stat, refuse non-files as not_found
    // (today's behavior), and refuse oversized files with a named
    // `file_too_large` OpError naming the size — BEFORE any content
    // allocation. The journal stays untouched on refusal.
    let size = 0;
    try {
      const info = ctx.env.fs.stat(args.path);
      if (!info.isFile) throw new Error('not a file');
      size = info.size;
    } catch {
      throw new OpError('not_found', `edit: no such file: ${args.path}`);
    }
    if (size > EDIT_MAX_BYTES) {
      throw new OpError(
        'file_too_large',
        `edit: ${args.path} is ${size}B — above the ${EDIT_MAX_BYTES}B edit bound; use targeted shell tooling instead`,
      );
    }
    const pre = readPreImage(ctx, args.path);
    if (!pre.exists) {
      throw new OpError('not_found', `edit: no such file: ${args.path}`);
    }
    if (pre.text === null) {
      // Text replacement over a lossy decode would rewrite every invalid
      // byte as U+FFFD — refuse instead of corrupting a binary file.
      throw new OpError(
        'invalid_args',
        `edit: ${args.path} is not valid utf-8 text (binary content) — refusing to rewrite it`,
      );
    }
    // Issue #195: normalize the file, the needle and the replacement into
    // the same LF/BOM-free space, then restore the file's own ending and BOM
    // on write. Both sides are stripped, so an oldText that carries the BOM
    // still matches and a replacement can never introduce a second one.
    const raw = pre.text;
    const bom = raw.startsWith(BOM);
    const ending = detectLineEnding(stripBom(raw));
    const current = normalizeToLF(stripBom(raw));
    const oldText = normalizeToLF(stripBom(args.oldText));
    const newText = normalizeToLF(stripBom(args.newText));
    if (oldText.length === 0) {
      // `\uFEFF` alone (or a lone BOM plus CRLF) normalizes to nothing: an
      // empty needle would match everywhere, so refuse it like the empty
      // oldText the validator already rejects.
      throw new OpError(
        'invalid_args',
        `edit: oldText is empty after line-ending/BOM normalization`,
      );
    }
    const expected = args.expectCount ?? 1;
    const found = countOccurrences(current, oldText);
    if (found === 0) {
      throw new OpError('no_match', `edit: oldText not found in ${args.path}`);
    }
    if (found !== expected) {
      throw new OpError(
        'ambiguous_match',
        `edit: found ${found} matches in ${args.path}, expected ${expected}`,
      );
    }
    const replaced = current.split(oldText).join(newText);
    const updated = (bom ? BOM : '') + restoreLineEndings(replaced, ending);
    const beforeHash = sha256Hex(raw);
    const result = {
      path: args.path,
      replacements: found,
      beforeHash,
      afterHash: sha256Hex(updated),
      bytesDelta:
        Buffer.byteLength(updated, 'utf8') - Buffer.byteLength(raw, 'utf8'),
    };
    // The journal carries the real pre- and post-images (BOM and endings
    // included), so its hashes describe the file on disk and undo restores
    // the CRLF/BOM file exactly.
    replaceFile(ctx, 'edit', args.path, updated, pre, {
      op: 'edit',
      before: raw,
      after: updated,
      bytesDelta: result.bytesDelta,
    });
    // Issue #456: the inline diff, in the LF space the edit matched in.
    if (ctx.display !== undefined) {
      const diff = displayDiff(current, replaced);
      if (diff !== undefined) ctx.display(diff);
    }
    return result;
  },
};
