// The production runners of the journal commands: `kubic git` and the
// journal readers and writers (diff, undo, log, status, journal prune).

import { NodeExecutionEnv } from '@kubic/exec/env';
import { runGitCommand } from '@kubic/host/git';
import { runJournalCommand } from '@kubic/host/journal';
import {
  journalRetentionDays,
  sessionRetentionDays,
} from '../config/projections.js';
import type { ProdRunnerIo, ProdRunners } from './shared.js';
import { PLAIN, reportStyle, stderrTheme } from './shared.js';

export function gitRunner(io: ProdRunnerIo): ProdRunners['git'] {
  const { out } = io;
  return (request) =>
    runGitCommand(request, {
      env: new NodeExecutionEnv(process.cwd()),
      out,
      ...reportStyle(request.json === true),
    });
}

export function journalRunner(io: ProdRunnerIo): ProdRunners['journal'] {
  const { out, debug } = io;
  return (request, cliConfig) => {
    // The same `session.retentionDays` projection `sessions
    // prune` reads — `log` self-heals aged entries of a session journal at
    // read time under it. Unset (or a refused config) leaves the read path
    // without a window: it then writes nothing.
    const retentionDays = sessionRetentionDays(cliConfig);
    // `journal prune` takes its default keep window from the resolved
    // `journal.retentionDays`; unset, it demands --keep-days, and a config
    // that did not load is named in that refusal.
    const journalWindow = journalRetentionDays(cliConfig);
    return runJournalCommand(request, {
      out,
      err: debug,
      errTheme: request.json === true ? PLAIN : stderrTheme(),
      ...reportStyle(request.json === true),
      ...(retentionDays === undefined ? {} : { retentionDays }),
      ...(journalWindow === undefined
        ? {}
        : { journalRetentionDays: journalWindow }),
      ...(cliConfig.error === undefined
        ? {}
        : { journalConfigError: cliConfig.error }),
    });
  };
}
