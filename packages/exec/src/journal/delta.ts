import type { JournalEntryInput } from './types.js';

// Above this many bytes of new content, the after-side is stored as a
// line delta instead of a full blob. The before-blob is always kept whole:
// undo needs the pre-image, and content addressing dedupes it — editing
// the same large file twice stores the before-content once.
const LARGE_FILE_BYTES = 64 * 1024;

type DeltaOp = { eq: number } | { del: number } | { ins: string[] };

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
    // Defensive depth: hash verification on blob reads should
    // already catch torn deltas, but a hash-valid yet malformed delta must
    // never crash a caller — fail closed to null, callers treat as missing.
    return null;
  }
}

// The delta a large after-side is stored as:
// encoded ONCE per append so the bound measure and the blob write share the
// same string — a >64 KiB write must not pay `encodeDelta` twice. null when
// the after-side is stored whole, or absent.
export function deltaFor(input: JournalEntryInput): string | null {
  if (input.after === null) return null;
  if (Buffer.byteLength(input.after, 'utf8') <= LARGE_FILE_BYTES) return null;
  return encodeDelta(input.before ?? '', input.after);
}
