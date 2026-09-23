// `kubic clean`: explicit-only worktree disposal (issue #45; §42.4, §44.1).
// Nothing else in this directory disposes a worktree: add/settle/merge
// retain by default, and only this command prunes — with --dry-run to
// preview and --json for machine-readable output. Journal retention
// (max-bytes / max-age) rides along via an injected pruner so this
// module never touches the filesystem directly.

import type { ExecutionEnv } from '../../../../exec/src/env.js';
import { isWorktreeError } from './errors.js';
import { listWorktrees, type WorktreeEntry } from './list.js';
import { removeWorktree } from './remove.js';

export const CLEAN_EXIT_OK = 0;

export const CLEAN_EXIT_USAGE = 1;

export interface CleanOptions {
  dryRun?: boolean;
  json?: boolean;
  maxAgeMs?: number;
  maxBytes?: number;
  sessionId?: string;
}

export interface CleanPlan {
  worktrees: { path: string; branch: string | null }[];
  journal: { maxAgeMs?: number; maxBytes?: number };
}

export interface JournalPruneResult {
  entries: number;
  bytes: number;
}

export interface CleanDeps {
  env: ExecutionEnv;
  out: (line: string) => void;
  lister?: (env: ExecutionEnv) => Promise<WorktreeEntry[]>;
  remover?: (env: ExecutionEnv, path: string) => Promise<unknown>;
  pruneJournal?: (policy: {
    maxAgeMs?: number;
    maxBytes?: number;
  }) => JournalPruneResult;
}

function usage(out: (line: string) => void): number {
  out(
    'usage: kubic clean [--dry-run] [--json] [--max-age-ms <n>] [--max-bytes <n>]',
  );
  return CLEAN_EXIT_USAGE;
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

function positiveInt(raw: string): number | null {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) return null;
  return parsed;
}

export function parseCleanArgs(
  args: string[],
): { valid: true; options: CleanOptions } | { valid: false; error: string } {
  const known = new Set(['--dry-run', '--json', '--max-age-ms', '--max-bytes']);
  for (const arg of args) {
    if (arg.startsWith('--') && !known.has(arg)) {
      return { valid: false, error: `unknown flag ${arg}` };
    }
  }
  const maxAgeRaw = flagValue(args, '--max-age-ms');
  const maxBytesRaw = flagValue(args, '--max-bytes');
  if (maxAgeRaw === 'missing' || maxBytesRaw === 'missing') {
    return { valid: false, error: '--max-age-ms/--max-bytes need a value' };
  }
  let maxAgeMs: number | undefined;
  let maxBytes: number | undefined;
  if (maxAgeRaw !== undefined) {
    const parsed = positiveInt(maxAgeRaw);
    if (parsed === null) {
      return { valid: false, error: '--max-age-ms needs a positive integer' };
    }
    maxAgeMs = parsed;
  }
  if (maxBytesRaw !== undefined) {
    const parsed = positiveInt(maxBytesRaw);
    if (parsed === null) {
      return { valid: false, error: '--max-bytes needs a positive integer' };
    }
    maxBytes = parsed;
  }
  return {
    valid: true,
    options: {
      ...(args.includes('--dry-run') ? { dryRun: true } : {}),
      ...(args.includes('--json') ? { json: true } : {}),
      ...(maxAgeMs === undefined ? {} : { maxAgeMs }),
      ...(maxBytes === undefined ? {} : { maxBytes }),
    },
  };
}

// Only spawned worktrees are planned — the main checkout is never pruned.
export function planClean(
  entries: WorktreeEntry[],
  options: CleanOptions,
): CleanPlan {
  void options;
  return {
    worktrees: entries
      .filter((entry) => entry.path.includes('/.kubic/wt/'))
      .map((entry) => ({ path: entry.path, branch: entry.branch })),
    journal: {
      ...(options.maxAgeMs === undefined ? {} : { maxAgeMs: options.maxAgeMs }),
      ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
    },
  };
}

function noopPrune(): JournalPruneResult {
  return { entries: 0, bytes: 0 };
}

export async function runCleanCommand(
  args: string[],
  deps: CleanDeps,
): Promise<number> {
  const parsed = parseCleanArgs(args);
  if (!parsed.valid) {
    deps.out(`error: ${parsed.error}`);
    return usage(deps.out);
  }
  const options = parsed.options;
  const lister = deps.lister ?? ((env) => listWorktrees(env));
  let entries: WorktreeEntry[];
  try {
    entries = await lister(deps.env);
  } catch (error) {
    if (isWorktreeError(error)) {
      deps.out(error.message);
      return error.exitCode;
    }
    throw error;
  }
  const plan = planClean(entries, options);
  const remover =
    deps.remover ??
    ((env, path) =>
      removeWorktree(env, path, { sessionId: options.sessionId }));
  const prune = deps.pruneJournal ?? noopPrune;

  if (options.dryRun === true) {
    if (options.json === true) {
      deps.out(
        JSON.stringify(
          {
            dryRun: true,
            wouldPrune: plan.worktrees.map((w) => w.path),
            journal: plan.journal,
          },
          null,
          2,
        ),
      );
      return CLEAN_EXIT_OK;
    }
    if (plan.worktrees.length === 0) {
      deps.out('clean: nothing to prune');
      return CLEAN_EXIT_OK;
    }
    deps.out(`would prune ${plan.worktrees.length} worktree(s):`);
    for (const item of plan.worktrees) deps.out(`would prune ${item.path}`);
    return CLEAN_EXIT_OK;
  }

  const pruned: string[] = [];
  for (const item of plan.worktrees) {
    await remover(deps.env, item.path);
    pruned.push(item.path);
  }
  const journal =
    plan.journal.maxAgeMs === undefined && plan.journal.maxBytes === undefined
      ? noopPrune()
      : prune(plan.journal);

  if (options.json === true) {
    deps.out(JSON.stringify({ dryRun: false, pruned, journal }, null, 2));
    return CLEAN_EXIT_OK;
  }
  if (pruned.length === 0) {
    deps.out('clean: nothing to prune');
  } else {
    for (const path of pruned) deps.out(`pruned ${path}`);
  }
  deps.out(
    `journal: pruned ${journal.entries} entr(ies), freed ${journal.bytes} byte(s)`,
  );
  return CLEAN_EXIT_OK;
}
