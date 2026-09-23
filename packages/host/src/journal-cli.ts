// `kubic diff / undo / log / status` commands (issue #18; §42.2, §78).
// Thin over the exec journal core; presentation only (one line per fact).
// Exit codes: 0 success (including empty diff and clean dry-run),
// 1 usage/IO errors, 2 undo completed with non-reversible skips.

import { join } from 'node:path';
import { FileJournalStore } from '../../exec/src/journal.js';
import { diffEntries, renderDiff } from '../../exec/src/journal-diff.js';
import { journalStatus, renderLog } from '../../exec/src/journal-status.js';
import { applyUndo, planUndo } from '../../exec/src/journal-undo.js';

export interface JournalCommandDeps {
  journalDir?: string;
  root?: string;
  out: (line: string) => void;
}

export function defaultJournalDir(root: string): string {
  return join(root, '.kubic', 'journal');
}

function usage(out: (line: string) => void): number {
  out(
    'usage: kubic <diff [--path <p>] [--agent <id>] [--json] | undo [<path>] [--step] [--dry-run] | log | status>',
  );
  return 1;
}

function flagValue(
  args: string[],
  flag: string,
): string | undefined | 'missing' {
  const at = args.indexOf(flag);
  if (at === -1) return undefined;
  const value = args[at + 1];
  if (value === undefined || value.startsWith('--')) return 'missing';
  return value;
}

export async function runJournalCommand(
  args: string[],
  deps: JournalCommandDeps,
): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === undefined) return usage(deps.out);
  const root = deps.root ?? process.cwd();
  const store = new FileJournalStore(
    deps.journalDir ?? defaultJournalDir(root),
  );

  if (sub === 'diff') {
    const path = flagValue(rest, '--path');
    const agent = flagValue(rest, '--agent');
    if (path === 'missing' || agent === 'missing') {
      deps.out('error: --path/--agent need a value');
      return 1;
    }
    const changes = diffEntries(store, {
      ...(path === undefined ? {} : { path }),
      ...(agent === undefined ? {} : { agent }),
    });
    if (rest.includes('--json')) {
      deps.out(JSON.stringify(changes, null, 2));
      return 0;
    }
    if (changes.length === 0) {
      deps.out('no changes');
      return 0;
    }
    for (const line of renderDiff(changes).split('\n')) deps.out(line);
    return 0;
  }

  if (sub === 'undo') {
    const dryRun = rest.includes('--dry-run');
    const step = rest.includes('--step');
    const positional = rest.find((a) => !a.startsWith('--'));
    const plan = planUndo(store, {
      ...(positional === undefined ? {} : { path: positional }),
      ...(step ? { step: true } : {}),
    });
    if (plan.steps.length === 0) {
      deps.out('nothing to undo');
      return 0;
    }
    const result = applyUndo(store, plan, root, { dryRun });
    if (dryRun) {
      deps.out(
        `would restore ${result.restored.length} step(s)` +
          (result.skipped.length > 0
            ? `, skip ${result.skipped.length} non-reversible: ${result.skipped.join(', ')}`
            : ''),
      );
      return 0;
    }
    for (const path of result.restored) deps.out(`restored ${path}`);
    for (const path of result.skipped) {
      deps.out(`non-reversible (skipped): ${path}`);
    }
    deps.out(
      `undo: ${result.restored.length} restored, ${result.skipped.length} non-reversible`,
    );
    return result.skipped.length > 0 ? 2 : 0;
  }

  if (sub === 'log') {
    const lines = renderLog(store);
    if (lines.length === 0) {
      deps.out('journal is empty');
      return 0;
    }
    if (rest.includes('--json')) {
      deps.out(JSON.stringify(store.entries(), null, 2));
      return 0;
    }
    for (const line of lines) deps.out(line);
    return 0;
  }

  if (sub === 'status') {
    const status = journalStatus(store, root);
    deps.out(
      `entries: ${status.entries} (reversible: ${status.reversible}, non-reversible: ${status.nonReversible})`,
    );
    if (status.repo === null) {
      deps.out('repo: non-repo directory (journal works without git)');
    } else {
      deps.out(
        `repo: branch ${status.repo.branch}, dirty: ${
          status.repo.dirty === null
            ? 'unknown'
            : status.repo.dirty
              ? 'yes'
              : 'no'
        }`,
      );
    }
    return 0;
  }

  return usage(deps.out);
}
