// `kubic diff`, `undo`, `log`, `status` and `journal prune` over the change
// journal.
export type { JournalRequest } from './journal-cli.js';
export {
  /** @internal */ colorizeDiffLine,
  runJournalCommand,
} from './journal-cli.js';
