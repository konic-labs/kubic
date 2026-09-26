// `kubic diff / undo / log / status` commands (issue #18; §42.2, §78).
// Thin over the exec journal core; presentation only (one line per fact).
// Exit codes: 0 success (including empty diff and clean dry-run),
// 1 usage/IO errors, 2 undo completed with non-reversible skips.

import { basename, dirname, join } from 'node:path';
import { answerHelp } from '../../core/src/cli-help.js';
import { createNodeFileBridge } from '../../exec/src/file-bridge.js';
import { FileJournalStore } from '../../exec/src/journal.js';
import {
  clipChangeContent,
  DEFAULT_MAX_CONTENT_BYTES,
  diffEntries,
  renderDiff,
} from '../../exec/src/journal-diff.js';
import {
  journalStatus,
  reconciliationSummary,
  renderLog,
} from '../../exec/src/journal-status.js';
import { applyUndo, planUndo } from '../../exec/src/journal-undo.js';
import { MS_PER_DAY } from './config/runtime.js';
import { SESSION_ID_PATTERN } from './run-cli.js';
import { defaultSessionsRoot } from './sessions-cli.js';

export interface JournalCommandDeps {
  journalDir?: string;
  sessionsRoot?: string;
  root?: string;
  // `session.retentionDays` (issue #119): the read-time self-heal window for
  // SESSION journals. Undefined — or 0 — means retention is off, and the
  // read path writes nothing. The workspace journal is never governed by
  // this key: `journal.retentionDays` bounds it on append.
  retentionDays?: number;
  out: (line: string) => void;
}

export function defaultJournalDir(root: string): string {
  return join(root, '.kubic', 'journal');
}

const JOURNAL_USAGE =
  'usage: kubic <diff [--path <p>] [--agent <id>] [--json] [--max-content-bytes <n>] [--session <id>] | undo [<path>] [--step] [--dry-run] [--force] [--session <id>] | log [--session <id>] | status [--session <id>]>';

function usage(out: (line: string) => void): number {
  out(JOURNAL_USAGE);
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

// Session ids are path segments under the sessions root: the shared
// run-cli SESSION_ID_PATTERN ([A-Za-z0-9_-]) is checked before any path
// join, so the join below is contained by construction (#17
// resolve/relative guard). Imported (not copied) so the rule cannot drift.

// The `journal:<id>` ref `kubic run` prints; accepted verbatim as the
// --session value so the printed token needs no extra lookup.
const JOURNAL_REF_PREFIX = 'journal:';

// A store "has a journal" once its index exists — an absent index means
// nothing has ever been appended there (the dead default this fallback
// exists for).
function hasJournalIndex(dir: string): boolean {
  return createNodeFileBridge(dir).exists('index.jsonl');
}

// The most recent run journal under the sessions root (issue #125): one
// level of session ids (the shared SESSION_ID_PATTERN, checked before any
// path join — contained by construction, same rule as --session), newest
// `journal/index.jsonl` mtime wins. A session whose journal index cannot
// be statted is skipped (no journal there); a missing sessions root is
// simply "nothing here" (fresh machine), never a throw.
function latestSessionJournal(sessionsRoot: string): string | undefined {
  const bridge = createNodeFileBridge(sessionsRoot);
  let best: { dir: string; mtime: number } | undefined;
  try {
    for (const info of bridge.listDir('.')) {
      if (!info.isDirectory || !SESSION_ID_PATTERN.test(info.name)) continue;
      const idx = join(info.name, 'journal', 'index.jsonl');
      try {
        const mtime = bridge.fileInfo(idx).mtimeMs;
        if (best === undefined || mtime > best.mtime) {
          best = { dir: join(sessionsRoot, info.name, 'journal'), mtime };
        }
      } catch {
        // Session without a journal — skip it.
      }
    }
  } catch {
    // No sessions root yet — nothing to fall back to.
  }
  return best?.dir;
}

// `sessionId` is set exactly when the resolved store is a session journal
// (explicit --session or the latest-session fallback) — the read-time
// self-heal below keys off it, so a pinned/workspace store can never be
// pruned by `session.retentionDays`.
function resolveJournalDir(
  deps: JournalCommandDeps,
  root: string,
  session: string | undefined,
): { dir: string; sessionId?: string; latestSessionId?: string } | string {
  if (session === undefined) {
    const dir = deps.journalDir ?? defaultJournalDir(root);
    // Issue #125: the bare default is a store nothing writes (runs journal
    // under `<sessionsRoot>/<id>/journal`), so with no index here fall back
    // to the latest session journal. Only the CLI's bare default falls
    // back: a configured journal dir pins the store (one store per
    // invocation, fail-closed — the same rule as the --session conflict
    // below), and keeping the scan off that path keeps pinned-store tests
    // hermetic (no walk of the real sessions root).
    if (deps.journalDir === undefined && !hasJournalIndex(dir)) {
      const fallback = latestSessionJournal(
        deps.sessionsRoot ?? defaultSessionsRoot(),
      );
      if (fallback !== undefined) {
        const id = basename(dirname(fallback));
        return { dir: fallback, sessionId: id, latestSessionId: id };
      }
    }
    return { dir };
  }
  const id = session.startsWith(JOURNAL_REF_PREFIX)
    ? session.slice(JOURNAL_REF_PREFIX.length)
    : session;
  if (!SESSION_ID_PATTERN.test(id)) {
    return `error: invalid --session id ${JSON.stringify(session)} (use [A-Za-z0-9_-] or journal:<id>)`;
  }
  if (deps.journalDir !== undefined) {
    // Explicit precedence, fail-closed: a programmatic journalDir plus an
    // operator --session is ambiguous — refuse rather than silently
    // ignoring one side.
    return `error: --session ${JSON.stringify(session)} conflicts with a configured journal dir (use one store per invocation)`;
  }
  const sessionsRoot = deps.sessionsRoot ?? defaultSessionsRoot();
  return { dir: join(sessionsRoot, id, 'journal'), sessionId: id };
}

export async function runJournalCommand(
  args: string[],
  deps: JournalCommandDeps,
): Promise<number> {
  // `--help`/`-h` prints the shared usage line and exits 0 (issue #100).
  // The line names all four subcommands, so `kubic diff --help` and
  // `kubic undo --help` answer with the same listing they belong to.
  const help = answerHelp(args, deps.out, JOURNAL_USAGE);
  if (help !== null) return help;
  const [sub, ...rest] = args;
  if (sub === undefined) return usage(deps.out);
  const root = deps.root ?? process.cwd();
  const session = flagValue(rest, '--session');
  if (session === 'missing') {
    deps.out('error: --session needs a value');
    return 1;
  }
  const journalDir = resolveJournalDir(deps, root, session);
  if (typeof journalDir === 'string') {
    deps.out(journalDir);
    return 1;
  }
  // Issue #125: a fallback store is named before any subcommand output so
  // the resolution is never silent. `--json` keeps its parseable envelope —
  // the refs there are self-describing, so no line is added.
  if (journalDir.latestSessionId !== undefined && !rest.includes('--json')) {
    deps.out(`session: ${journalDir.latestSessionId}`);
  }
  const store = new FileJournalStore(journalDir.dir);

  if (sub === 'diff') {
    const path = flagValue(rest, '--path');
    const agent = flagValue(rest, '--agent');
    // Issue #126: the `--json` content bound. Validated on every diff
    // invocation (fail-closed like --path/--agent), applied to `--json`
    // only — the human path renders hunks, not whole files.
    const maxContent = flagValue(rest, '--max-content-bytes');
    if (path === 'missing' || agent === 'missing') {
      deps.out('error: --path/--agent need a value');
      return 1;
    }
    if (maxContent === 'missing') {
      deps.out('error: --max-content-bytes needs a value');
      return 1;
    }
    if (maxContent !== undefined && !/^\d+$/.test(maxContent)) {
      deps.out(
        'error: --max-content-bytes needs a non-negative integer (0 = unlimited)',
      );
      return 1;
    }
    const changes = diffEntries(store, {
      ...(path === undefined ? {} : { path }),
      ...(agent === undefined ? {} : { agent }),
    });
    if (rest.includes('--json')) {
      // One change's before/after can be a whole file: the envelope clips
      // each side at 64 KiB by default (marker line + `contentTruncated`),
      // and `--max-content-bytes 0` restores the unbounded form for
      // scripting.
      const maxBytes =
        maxContent === undefined
          ? DEFAULT_MAX_CONTENT_BYTES
          : Number(maxContent);
      deps.out(
        JSON.stringify(
          changes.map((c) => clipChangeContent(c, maxBytes)),
          null,
          2,
        ),
      );
      return 0;
    }
    if (changes.length === 0) {
      deps.out('no changes');
      // Issue #125: with no journal anywhere, name both places that were
      // looked at — the empty result is otherwise indistinguishable from
      // "ran and nothing changed". Only the bare default path hints (a
      // configured store or --session is a deliberate choice), and never
      // on the --json branch above. "Nothing anywhere" means the resolved
      // store has no entries AND no session journal exists to fall back to.
      if (
        session === undefined &&
        deps.journalDir === undefined &&
        store.entries().length === 0 &&
        latestSessionJournal(deps.sessionsRoot ?? defaultSessionsRoot()) ===
          undefined
      ) {
        deps.out(
          `hint: no journal under ${journalDir.dir} and none under the sessions root (${deps.sessionsRoot ?? defaultSessionsRoot()}) — start a run or pass --session`,
        );
      }
      return 0;
    }
    for (const line of renderDiff(changes).split('\n')) deps.out(line);
    return 0;
  }

  if (sub === 'undo') {
    const dryRun = rest.includes('--dry-run');
    const step = rest.includes('--step');
    // Issue #108: --force overrides the staleness refusal per-invocation;
    // nothing persists it — the next undo re-checks by default.
    const force = rest.includes('--force');
    // The --session value is a store selector, not a path scope: skip the
    // flag and its value before looking for the positional <path>.
    const scopeArgs = rest.filter(
      (a, i) => a !== '--session' && rest[i - 1] !== '--session',
    );
    const positional = scopeArgs.find((a) => !a.startsWith('--'));
    const plan = planUndo(
      store,
      {
        ...(positional === undefined ? {} : { path: positional }),
        ...(step ? { step: true } : {}),
      },
      root,
    );
    if (plan.steps.length === 0) {
      deps.out('nothing to undo');
      return 0;
    }
    const result = applyUndo(store, plan, root, { dryRun, force });
    // Stale refusals and already-undone skips get their own line shapes so
    // scripts (and humans) can tell "cannot reverse" from "refused because
    // the file changed since" from "a previous undo already unwound it".
    const parts: string[] = [];
    for (const detail of result.skippedDetails) {
      if (detail.reason.startsWith('stale:')) parts.push('stale');
      else if (detail.reason.startsWith('already undone:'))
        parts.push('already undone');
      else parts.push('non-reversible');
    }
    const staleCount = parts.filter((p) => p === 'stale').length;
    const undoneCount = parts.filter((p) => p === 'already undone').length;
    const skipLabel =
      staleCount > 0 || undoneCount > 0
        ? ` (${[staleCount > 0 ? `${staleCount} stale` : null, undoneCount > 0 ? `${undoneCount} already undone` : null].filter((s) => s !== null).join(', ')})`
        : ' non-reversible';
    if (dryRun) {
      deps.out(
        `would restore ${result.restored.length} step(s)` +
          (result.skipped.length > 0
            ? `, skip ${result.skipped.length}${skipLabel}: ${result.skipped.join(', ')}`
            : ''),
      );
      return 0;
    }
    for (const path of result.restored) deps.out(`restored ${path}`);
    for (const [detail, kind] of result.skippedDetails.map(
      (d, i) => [d, parts[i]] as const,
    )) {
      deps.out(
        kind === 'stale'
          ? `stale (skipped): ${detail.path} — ${detail.reason}`
          : kind === 'already undone'
            ? `already undone (skipped): ${detail.path}`
            : `non-reversible (skipped): ${detail.path}`,
      );
    }
    deps.out(
      staleCount > 0 || undoneCount > 0
        ? `undo: ${result.restored.length} restored, ${result.skipped.length} skipped${skipLabel}`
        : `undo: ${result.restored.length} restored, ${result.skipped.length} non-reversible`,
    );
    return result.skipped.length > 0 ? 2 : 0;
  }

  if (sub === 'log') {
    // Issue #119 (read-time self-heal): with `session.retentionDays` set, a
    // SESSION journal drops entries older than the window as it is read —
    // the same age bound `kubic sessions prune` applies to whole session
    // dirs, enforced entry-wise through the store's retention pass (which
    // `append` already runs; the read path triggers it explicitly here).
    // Session-scoped by construction (`sessionId` is set only for a session
    // journal): the workspace journal keeps its own `journal.retentionDays`
    // append-time bound, and prune remains the only deleter of session
    // dirs. With retention unset — or 0 — no pass runs: the read path
    // writes nothing.
    const retentionDays = deps.retentionDays ?? 0;
    if (journalDir.sessionId !== undefined && retentionDays > 0) {
      store.enforceRetention({ maxAgeMs: retentionDays * MS_PER_DAY });
    }
    const lines = renderLog(store);
    // `--json` stays the raw entries array (the count is derivable from the
    // `unattributed` flags there); the human path gains the summary line.
    if (rest.includes('--json')) {
      deps.out(JSON.stringify(store.entries(), null, 2));
      return 0;
    }
    if (lines.length === 0) {
      deps.out('journal is empty');
    } else {
      for (const line of lines) deps.out(line);
    }
    // Issue #87: the reconciliation count is part of `log`'s contract — it
    // is the only surface that answers "did anything bypass the tools?"
    // without the operator grepping for the `reconciled` marker. Printed
    // for an empty journal too, so scripts see a stable shape.
    deps.out(reconciliationSummary(store));
    return 0;
  }

  if (sub === 'status') {
    const status = journalStatus(store, root);
    deps.out(
      `entries: ${status.entries} (reversible: ${status.reversible}, non-reversible: ${status.nonReversible})`,
    );
    // Issue #87: unattributed entries are a subset of non-reversible ones;
    // naming the count keeps reconciliation visible in the summary, not
    // only in the per-entry `reconciled` marker.
    deps.out(
      `unattributed: ${status.unattributed} of ${status.entries} (reconciled at run end)`,
    );
    // Issue #111: lost journal content is named on its own line ("0 is the
    // honest answer") so a corrupt store is visible at a glance.
    deps.out(`corrupt: ${status.corrupt}`);
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
