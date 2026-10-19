import type { HeadState } from './git.js';

export type JournalOp =
  | 'write'
  | 'edit'
  | 'create'
  | 'delete'
  | 'rename'
  // Not a file change — a HEAD-move marker the sweep appends
  // when the run moved git HEAD (`checkout`, `reset`, `stash`). Carries
  // `headFrom`/`headTo`, never content; every file-content consumer
  // (diff, restore, staleness) skips it, while undo treats it as a barrier
  // (`--force` to cross) and status/log surface it.
  | 'marker';
// Sweep after-content bound: a changed file above this is
// recorded hash-only — `after: null`, the walk hash intact, rendered as a
// size-only change — instead of being read whole. The sweep runs on the
// run's exit path, where reading a changed build artifact whole costs its
// size in memory at the worst possible moment; hash-only keeps the change
// visible with a bounded cost, and undo stays non-reversible for it exactly
// as for any other unattributed find.
export const MAX_SWEEP_CONTENT_BYTES = 4 * 1024 * 1024;

export interface JournalRetention {
  maxBytes?: number;
  maxAgeMs?: number;
  /**
   * Flush the journal's writes before they are trusted, default true. A few
   * fsyncs per tool write are the price of "reversible": the blob an entry
   * references is on platter before the entry is, and the index line is on
   * platter before the append returns, so a crash can neither take back a
   * change the journal already promised to undo nor leave a durable entry
   * pointing at bytes that were never written. The retention rewrite is flushed
   * the same way — it replaces the whole history, so a crash right after it
   * must not be able to leave an empty index. Set `false` to trade that
   * durability for throughput (a crash may then truncate the last line — the
   * next append closes the fragment on a line of its own and `kubic status`
   * reports it as a corrupt index line, and a failed append truncates its own
   * partial write back to the pre-append length); a bridge without
   * `appendDurably`/`flushFile`/`flushDir` degrades to the plain write, keeping
   * atomicity without durability.
   */
  durable?: boolean;
}

// Where a journal entry came from: a tool call (the default), the end-of-run
// reconciliation sweep (`unattributed` entries), or an undo's own bookkeeping
// (which plain undo plans skip).
export type JournalSource = 'tool' | 'sweep' | 'undo';

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
  // captured: the sweep records the walk hash for entries above
  // MAX_SWEEP_CONTENT_BYTES or whose utf-8 decode was lossy, so dedupe and
  // undo staleness keep comparing against the digest the baseline walk
  // produced. No blob is written for it.
  afterHash?: string | null;
  // True when the after-side was deliberately not captured:
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
  /** Defaults to `tool` when absent. */
  source?: JournalSource;
  toolCallId: string | null;
  timestamp: number;
  unattributed?: boolean;
  /**
   * The interactive turn the entry belongs to — 1 for
   * the session's first prompt in this process. Reconciliation sweep
   * entries carry the turn they swept; tool-journaled entries carry the
   * turn in flight when the call ran (TUI only — headless
   * runs are turn-less). Absent on every entry written before the field
   * existed.
   */
  turn?: number;
  /**
   * The tool that journaled the entry (`write`, `edit`) —
   * recorded at interception from the op name. Absent on reconciliation
   * finds (no tool ran) and on every entry written before the field
   * existed; `diff --stat` and `--json` render it when present.
   */
  toolName?: string;
  /**
   * Set only on `op: 'marker'` entries — the HEAD state before
   * and after the move the sweep observed. Absent on every file entry.
   */
  headFrom?: HeadState;
  headTo?: HeadState;
}

// The journal record format's major version, written on every index line
// as `v`. Within a major, fields are only ever added (absent on older lines,
// ignored by older readers); a line with another major is one this build
// cannot interpret. A line without `v` predates the field and is version 1.
export const JOURNAL_RECORD_VERSION = 1;

export interface JournalIndexRead {
  entries: JournalEntry[];
  /**
   * Index lines whose JSON.parse failed — a torn fragment from a crash or a
   * full disk. `entries()` drops them (a corrupt line must
   * never poison the journal read) and `kubic status` reports the count, so
   * the drop is visible instead of silent.
   */
  corruptLines: number;
  /**
   * Index lines with a record version this build cannot interpret — written
   * by a newer Kubic. They are never read as entries (so never restored or
   * diffed), `kubic status` reports the count, and a retention rewrite keeps
   * them verbatim instead of destroying records it does not understand.
   */
  unknownVersionLines: number;
}

// An entry whose own content cannot fit the store's bound is
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
  source: JournalSource;
  toolCallId: string | null;
  timestamp: number;
  unattributed?: boolean;
  /** See JournalEntryInput.turn. */
  turn?: number;
  /** See JournalEntryInput.toolName. */
  toolName?: string;
  /** True when the delta was encoded against '' (reconciliation entries with
   *  no before-blob). Absent on pre-schema entries — see readAfter fallback. */
  deltaBaseEmpty?: boolean;
  /** Hash-only after-side: content deliberately not captured —
   *  above MAX_SWEEP_CONTENT_BYTES, or a lossy utf-8 decode. readAfter
   *  returns null; `afterHash` keeps the walk hash, so dedupe and undo
   *  staleness behave exactly as for a content-captured entry. */
  afterOmitted?: boolean;
  beforeOmitted?: boolean;
  /** The observed size in bytes of an afterOmitted entry's file. */
  afterBytes?: number;
  /** See JournalEntryInput.headFrom/headTo. */
  headFrom?: HeadState;
  headTo?: HeadState;
}

export interface RetentionPolicy {
  maxBytes?: number;
  maxAgeMs?: number;
  now?: number;
}
