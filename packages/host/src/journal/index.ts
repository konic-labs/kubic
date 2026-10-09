// `kubic diff`, `undo`, `log`, `status` and `journal prune` over the change
// journal.

export {
  /** @internal */ colorizeDiffLine,
  runJournalCommand,
} from './journal-cli.js';
export type { JournalRequest } from './journal-run.js';
