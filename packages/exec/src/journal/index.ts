// The change journal: a VCS-independent record of every file change, so
// `kubic diff` and `kubic undo` work anywhere. The store (store.ts) keeps
// index lines over content-addressed blobs; baseline.ts and sweep.ts record
// the changes no tool call made; restore.ts and undo.ts reverse them;
// diff.ts and status.ts report them. README.md states the durability protocol.
//
// Exports with an `internal` JSDoc tag are for the composition-root tests only.
export { /** @internal */ captureBaseline } from './baseline.js';
export type { FileChange } from './diff.js';
export {
  clipChangeContent,
  DEFAULT_MAX_CONTENT_BYTES,
  diffEntries,
  renderDiff,
  renderDiffStat,
  unifiedHunks,
} from './diff.js';
export { HASH_CHUNK_BYTES, /** @internal */ sha256Hex } from './hash.js';
export type {
  ReconciliationPeers,
  RunReconciliation,
} from './reconcile.js';
export { beginReconciliation } from './reconcile.js';
export { /** @internal */ restoreEntry } from './restore.js';
export {
  formatHeadMove,
  journalStatus,
  reconciliationSummary,
} from './status.js';
export { FileJournalStore } from './store.js';
export { /** @internal */ reconcile } from './sweep.js';
export type {
  JournalEntry,
  JournalEntryInput,
  JournalRetention,
} from './types.js';
export { /** @internal */ JournalEntryTooLargeError } from './types.js';
export { applyUndo } from './undo.js';
export { planUndo } from './undo-plan.js';
