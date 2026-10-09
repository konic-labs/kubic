import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { FileBridge } from '../file-bridge.js';
import { createNodeFileBridge } from '../file-bridge.js';
import type { Baseline, BaselineOptions, JournalRunStart } from './baseline.js';
import {
  captureBaseline,
  entriesSinceRunStart,
  isOutOfScope,
  UNREADABLE_HASH,
} from './baseline.js';
import { captureHeadState, readGitBlob, sameHeadState } from './git.js';
import { sha256Hex, sha256HexOfBytes } from './hash.js';
import type { FileJournalStore } from './store.js';
import type { JournalEntryInput } from './types.js';
import { MAX_SWEEP_CONTENT_BYTES } from './types.js';

export interface ReconcileContext {
  sessionId: string;
  timestamp: number;
  /**
   * Where this run's part of the journal begins (captured with
   * the boot baseline). Only entries appended after it define a path's
   * expected state; absent ⇒ the whole store is treated as this run.
   */
  runStart?: JournalRunStart;
  /** The interactive turn the sweep's entries belong to. */
  turn?: number;
}

// The sweep's lossless-decode check, in hash space: the decoded
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
// U+FFFD, its re-encoding does not match the file, and the caller records
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

// The pre-image for a sweep find from the git object store.
// The OID was recorded at boot for a file clean against the index, and the
// object store is content-addressed, so the bytes are exactly the boot
// content — but only a pre-image matching the boot baseline hash may be
// journaled as one. A mismatch (a racy index update between the OID capture
// and the walk, clean/smudge filters, CRLF checkout) keeps today's hash-only
// shape rather than restoring the wrong content. Binary content (a lossy
// utf-8 decode) and pre-images above the sweep content bound are likewise
// hash-only — the same bound the after-side obeys on the run's exit path.
function gitBeforeContent(
  root: string,
  relPath: string,
  expected: string,
  options: BaselineOptions,
): string | null {
  const oid = options.gitBaseline?.[relPath];
  if (oid === undefined) return null;
  const bytes = readGitBlob(root, oid, MAX_SWEEP_CONTENT_BYTES, options.gitRun);
  if (bytes === null) return null;
  const text = decodeLossless(bytes);
  if (text === null) return null;
  return sha256Hex(text) === expected ? text : null;
}

// End-of-run sweep: whatever moved without interception gets an
// unattributed entry — sed -i, npm install fallout, formatters, builds.
// Before-content comes from the git object store when the path was clean
// against the index at boot; otherwise the baseline holds
// hashes, not copies, so beforeHash is recorded but no before-blob exists:
// undo of those unattributed entries is reported non-reversible.
export function reconcile(
  store: FileJournalStore,
  baseline: Baseline,
  root: string,
  ctx: ReconcileContext,
  options: BaselineOptions = {},
): number {
  // Same read seam as captureBaseline: the hash honours `options.bridge`,
  // and so must the after-content read, or an injected double observes
  // only half the walk. One bridge serves the whole reconcile.
  const bridge = options.bridge ?? createNodeFileBridge('/');
  const outOfScope = options.outOfScope ?? [];
  const current = captureBaseline(root, { ...options, previous: baseline });
  const sweep: Sweep = {
    store,
    baseline,
    root,
    ctx,
    options,
    bridge,
    outOfScope,
    sinceStart: journaledSinceRunStart(store, root, ctx),
    added: 0,
  };
  recordChanges(sweep, current);
  recordDeletes(sweep, current);
  recordHeadMove(sweep);
  return sweep.added;
}

// One reconcile pass: its inputs, and the count of entries it appended.
interface Sweep {
  store: FileJournalStore;
  baseline: Baseline;
  root: string;
  ctx: ReconcileContext;
  options: BaselineOptions;
  bridge: FileBridge;
  outOfScope: readonly string[];
  sinceStart: Map<string, string | null>;
  added: number;
}

// Each path's EXPECTED state is the last entry journaled
// during THIS run, else the boot baseline — never "matches the baseline
// OR any historical after-hash", which hid same-run reverts, a resumed
// session's change back to an older hash, and repeat deletes.
// This is the first half: the after-hash of each path's last entry this run
// (`null` = expected absent).
function journaledSinceRunStart(
  store: FileJournalStore,
  root: string,
  ctx: ReconcileContext,
): Map<string, string | null> {
  const sinceStart = new Map<string, string | null>();
  for (const e of entriesSinceRunStart(store.entries(), ctx.runStart)) {
    // Markers are not file state — they never define a path's
    // expected content (their empty path must not become a lookup key).
    if (e.op === 'marker') continue;
    // Tools journal `args.path` verbatim (absolute or './'-prefixed), while
    // the walk keys are root-relative: normalize before keying, and drop a
    // path outside the root — it is never a sweep candidate.
    const key = rootRelativeKey(root, e.path);
    if (key !== null) sinceStart.set(key, e.afterHash);
  }
  return sinceStart;
}

function expectedHash(sweep: Sweep, relPath: string): string | null {
  if (sweep.sinceStart.has(relPath)) {
    return sweep.sinceStart.get(relPath) ?? null;
  }
  const boot = sweep.baseline[relPath];
  // An unreadable-at-boot path has no known pre-state. Treated
  // as absent, so a path that is readable later is an honest create with no
  // invented before-hash — never the sentinel in the journal, never a
  // delete of a file that was only unreadable.
  return boot === undefined || boot === UNREADABLE_HASH ? null : boot;
}

interface SweepFind {
  path: string;
  op: JournalEntryInput['op'];
  before: string | null;
  beforeHash: string | null;
  after: string | null;
  afterHash?: string;
  afterOmitted?: boolean;
  afterBytes?: number;
}

function record(sweep: Sweep, input: SweepFind): void {
  // The sweep's byte delta, computed when both sides are
  // known — a create grows from absent (0), a delete shrinks to it, and a
  // write is the difference. Unknown stays 0, exactly today's shape.
  const beforeLen =
    input.before === null
      ? input.op === 'create'
        ? 0
        : null
      : Buffer.byteLength(input.before, 'utf8');
  const afterLen =
    input.after === null
      ? (input.afterBytes ?? (input.op === 'delete' ? 0 : null))
      : Buffer.byteLength(input.after, 'utf8');
  const { ctx } = sweep;
  sweep.store.append({
    path: input.path,
    op: input.op,
    before: input.before,
    beforeHash: input.beforeHash,
    after: input.after,
    ...(input.afterHash === undefined ? {} : { afterHash: input.afterHash }),
    ...(input.afterOmitted === true ? { afterOmitted: true } : {}),
    ...(input.afterBytes === undefined ? {} : { afterBytes: input.afterBytes }),
    bytesDelta:
      beforeLen !== null && afterLen !== null ? afterLen - beforeLen : 0,
    sessionId: ctx.sessionId,
    source: 'sweep',
    toolCallId: null,
    timestamp: ctx.timestamp,
    unattributed: true,
    ...(ctx.turn === undefined ? {} : { turn: ctx.turn }),
  });
  sweep.added++;
}

// Present now but not as expected: a write, or a create when nothing was
// expected.
function recordChanges(sweep: Sweep, current: Baseline): void {
  for (const [relPath, hash] of Object.entries(current)) {
    // Declared out of scope: never read, never journaled.
    // The walk already prunes an excluded directory, so this states the
    // rule for a path that reaches the sweep any other way.
    if (isOutOfScope(relPath, sweep.outOfScope)) continue;
    // A path the walk could see but not read has no observed
    // state — never a change (nothing was read), and never a delete either
    // (recordDeletes skips it: it IS present in `current`).
    if (hash === UNREADABLE_HASH) continue;
    const expected = expectedHash(sweep, relPath);
    if (expected === hash) continue;
    const { size, after, omitted } = afterSide(
      sweep.bridge,
      join(sweep.root, relPath),
    );
    // A path a tool journaled this run keeps the tool chain —
    // its before-side is the tool's after-content, never the
    // boot blob — and a create has no pre-image by definition.
    const before =
      expected === null || sweep.sinceStart.has(relPath)
        ? null
        : gitBeforeContent(sweep.root, relPath, expected, sweep.options);
    record(sweep, {
      path: relPath,
      op: expected === null ? 'create' : 'write',
      before,
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
}

// A changed file's after-side as the sweep records it: its size, and its
// content when it is small enough to read and decodes losslessly.
function afterSide(
  bridge: FileBridge,
  abs: string,
): { size: number | null; after: string | null; omitted: boolean } {
  let size: number | null = null;
  try {
    size = bridge.fileInfo(abs).size;
  } catch {
    // Vanished since the walk: no size to bound a read by, so the entry
    // records no after-side — exactly the pre shape for this race.
  }
  if (size === null) return { size, after: null, omitted: false };
  if (size > MAX_SWEEP_CONTENT_BYTES) {
    // Above the bound: never read whole. Hash-only, with the
    // walk hash intact, rendered as a size-only change.
    return { size, after: null, omitted: true };
  }
  try {
    // At or under the bound: one read, bytes first — the lossless check
    // needs the bytes the decode came from, and the range read is
    // bounded by the size just observed.
    const bytes =
      bridge.readFileRange === undefined
        ? bridge.readBinaryFile(abs)
        : bridge.readFileRange(abs, 0, size);
    const after = decodeLossless(bytes);
    // decodeLossless returns null only for a lossy decode (binary
    // content): record hash-only instead of a mangled blob.
    return { size, after, omitted: after === null };
  } catch {
    return { size, after: null, omitted: false };
  }
}

// Expected but gone: a delete.
function recordDeletes(sweep: Sweep, current: Baseline): void {
  const { baseline, sinceStart } = sweep;
  const candidates = new Set([...Object.keys(baseline), ...sinceStart.keys()]);
  for (const relPath of candidates) {
    // The same rule in the delete direction: a baseline captured
    // before the entry was declared — or supplied by a caller — can name
    // out-of-scope paths, and their disappearance is not a journal event
    // either.
    if (isOutOfScope(relPath, sweep.outOfScope)) continue;
    if (current[relPath] !== undefined) continue;
    const expected = expectedHash(sweep, relPath);
    if (expected === null) continue;
    // A path only a tool journaled (not in the boot baseline) is absent from
    // `current` whenever the walk skips it — gitignored, `.git/`, `.kubic/` —
    // while the regular file is still on disk: no delete happened, so none is
    // recorded. Replaced by a directory or a link it
    // IS a delete. Baseline keys keep the old rule.
    if (
      baseline[relPath] === undefined &&
      regularFileStillThere(sweep.bridge, sweep.root, relPath)
    )
      continue;
    record(sweep, {
      path: relPath,
      op: 'delete',
      // The same tool-chain rule in the delete direction — a
      // path journaled this run unwinds through its entries, never the boot
      // blob.
      before: sinceStart.has(relPath)
        ? null
        : gitBeforeContent(sweep.root, relPath, expected, sweep.options),
      beforeHash: expected,
      after: null,
    });
  }
}

// The HEAD-move marker. Recorded after the file finds so the
// marker is the sweep's newest entry — `undo --step` (which never targets
// markers) still lands on the latest file entry. One marker per observed
// move: a repeat sweep of an unchanged HEAD appends nothing.
function recordHeadMove(sweep: Sweep): void {
  const { store, ctx, root, options } = sweep;
  const headBaseline = options.headBaseline;
  if (headBaseline === undefined || headBaseline === null) return;
  const currentHead = captureHeadState(root, options.gitRun);
  if (currentHead === null || sameHeadState(headBaseline, currentHead)) return;
  const known = entriesSinceRunStart(store.entries(), ctx.runStart).some(
    (e) =>
      e.op === 'marker' &&
      e.headFrom !== undefined &&
      e.headTo !== undefined &&
      sameHeadState(e.headFrom, headBaseline) &&
      sameHeadState(e.headTo, currentHead),
  );
  if (known) return;
  store.append({
    path: '',
    op: 'marker',
    before: null,
    after: null,
    bytesDelta: 0,
    headFrom: headBaseline,
    headTo: currentHead,
    sessionId: ctx.sessionId,
    source: 'sweep',
    toolCallId: null,
    timestamp: ctx.timestamp,
    unattributed: true,
    ...(ctx.turn === undefined ? {} : { turn: ctx.turn }),
  });
  sweep.added++;
}
