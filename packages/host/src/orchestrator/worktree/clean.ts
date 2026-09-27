// `kubic clean`: explicit-only worktree disposal (issue #92; §42.4, §44.1, §78).
// Nothing else in this directory disposes a worktree: add/settle/merge
// retain by default, and only this command prunes — with --dry-run to
// preview, --json for machine-readable output, and --session to scope to
// one orchestrate run. Disposal goes through the existing library path
// (remove.ts: worktree remove + branch delete + prune); the journal
// retention prune (§42.4) rides along via an injected pruner so this
// module never touches the filesystem directly.
//
// Refusal posture (never garbage-collect what Kubic did not name): the
// planned set is the intersection of the spawned set under
// `<root>/<worktreeRoot>/` (`.kubic/wt` unless `[orchestrator].root` says
// otherwise, issue #133) and the `kubic/<agent>` branch namespace. A
// hand-made worktree, a foreign branch, or the main checkout is never
// planned — and each mutation re-checks its own confinement.

import { join } from 'node:path';
import { answerHelp } from '../../../../core/src/cli-help.js';
import { type FlagSpec, parseFlagArgs } from '../../../../core/src/flags.js';
import type { ExecutionEnv, Provenance } from '../../../../exec/src/env.js';
import { createNodeFileBridge } from '../../../../exec/src/file-bridge.js';
import {
  DEFAULT_JOURNAL_MAX_BYTES,
  FileJournalStore,
} from '../../../../exec/src/journal.js';
import { SESSION_ID_PATTERN } from '../../run-cli.js';
import {
  isSpawnedWorktreePath,
  isSpawnedWorktreeShape,
} from './confinement.js';
import { isWorktreeError } from './errors.js';
import {
  listSpawnedBranches,
  listWorktrees,
  type WorktreeEntry,
} from './list.js';
import {
  branchForAgent,
  parseBranchAgent,
  pathForAgent,
  validateAgentId,
} from './naming.js';
import {
  deleteSpawnedBranch,
  pruneWorktrees,
  removeWorktree,
} from './remove.js';

export const CLEAN_EXIT_OK = 0;

export const CLEAN_EXIT_FAILURE = 1;

// §78: 2 is usage *and* the non-repo refusal (nothing is mutated either way).
export const CLEAN_EXIT_USAGE = 2;

export interface CleanOptions {
  dryRun?: boolean;
  json?: boolean;
  all?: boolean;
  force?: boolean;
  journal?: boolean;
  maxAgeMs?: number;
  maxBytes?: number;
  sessionId?: string;
}

export interface CleanPlan {
  worktrees: { path: string; branch: string | null }[];
  branches: string[];
  journal: { maxAgeMs?: number; maxBytes?: number };
}

export interface JournalPruneResult {
  entries: number;
  bytes: number;
}

export interface CleanDeps {
  env: ExecutionEnv;
  out: (line: string) => void;
  repoRoot?: string;
  // The spawned set's parent, workspace-relative: `[orchestrator].root` when
  // the config sets one, `.kubic/wt` otherwise (issue #133). It is a config
  // projection from the composition root — never an argv flag.
  worktreeRoot?: string;
  lister?: (env: ExecutionEnv) => Promise<WorktreeEntry[]>;
  branchLister?: (env: ExecutionEnv) => Promise<string[]>;
  remover?: (
    env: ExecutionEnv,
    path: string,
    options: { force: boolean },
  ) => Promise<unknown>;
  branchDeleter?: (env: ExecutionEnv, branch: string) => Promise<unknown>;
  pruner?: (env: ExecutionEnv) => Promise<unknown>;
  pruneJournal?: (
    policy: { maxAgeMs?: number; maxBytes?: number },
    repoRoot: string,
  ) => JournalPruneResult;
  sessionAgents?: (sessionId: string, repoRoot: string) => string[] | undefined;
  resolveRepoRoot?: (env: ExecutionEnv) => Promise<string | undefined>;
}

export const CLEAN_USAGE =
  'usage: kubic clean [--all] [--session <id>] [--dry-run] [--force] [--journal] [--max-age-ms <n>] [--max-bytes <n>] [--json]';

function usage(out: (line: string) => void): number {
  out(CLEAN_USAGE);
  return CLEAN_EXIT_USAGE;
}

function positiveInt(raw: string): number | null {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) return null;
  return parsed;
}

// Issue #127: the shared parser replaces the known-set scan + flagValue
// helper. The old lines are preserved: a starved bound is still reported
// first (`--max-age-ms --nuke` → '--max-age-ms/--max-bytes need a value',
// not `--nuke`), and `--max-age-ms 5 --nuke` still refuses `--nuke` by
// name once the bound is set (both exit 2). The parser adds `--flag=value`
// and the `--` terminator.
const CLEAN_FLAG_SPEC: readonly FlagSpec[] = [
  { name: '--all', takes: 'boolean' },
  { name: '--dry-run', takes: 'boolean' },
  { name: '--force', takes: 'boolean' },
  { name: '--journal', takes: 'boolean' },
  { name: '--json', takes: 'boolean' },
  { name: '--max-age-ms', takes: 'value' },
  { name: '--max-bytes', takes: 'value' },
  { name: '--session', takes: 'value' },
];

export function parseCleanArgs(
  args: string[],
): { valid: true; options: CleanOptions } | { valid: false; error: string } {
  const parsed = parseFlagArgs(args, CLEAN_FLAG_SPEC);
  const missing = parsed.missing;
  if (missing.includes('--max-age-ms') || missing.includes('--max-bytes')) {
    return { valid: false, error: '--max-age-ms/--max-bytes need a value' };
  }
  if (missing.includes('--session')) {
    return { valid: false, error: '--session needs a value' };
  }
  if (parsed.unknown.length > 0) {
    return { valid: false, error: `unknown flag ${parsed.unknown[0]}` };
  }
  if (parsed.positional.length > 0) {
    return {
      valid: false,
      error: `unexpected argument ${JSON.stringify(parsed.positional[0])}`,
    };
  }
  const values = parsed.values;
  const maxAgeRaw = values['--max-age-ms'] as string | undefined;
  const maxBytesRaw = values['--max-bytes'] as string | undefined;
  const sessionRaw = values['--session'] as string | undefined;
  let sessionId: string | undefined;
  if (sessionRaw !== undefined) {
    if (!SESSION_ID_PATTERN.test(sessionRaw)) {
      return {
        valid: false,
        error: `invalid --session id ${JSON.stringify(sessionRaw)} (use [A-Za-z0-9_-])`,
      };
    }
    sessionId = sessionRaw;
  }
  let maxAgeMs: number | undefined;
  let maxBytes: number | undefined;
  if (maxAgeRaw !== undefined) {
    const parsedBound = positiveInt(maxAgeRaw);
    if (parsedBound === null) {
      return { valid: false, error: '--max-age-ms needs a positive integer' };
    }
    maxAgeMs = parsedBound;
  }
  if (maxBytesRaw !== undefined) {
    const parsedBound = positiveInt(maxBytesRaw);
    if (parsedBound === null) {
      return { valid: false, error: '--max-bytes needs a positive integer' };
    }
    maxBytes = parsedBound;
  }
  // Two contradictory scopes at once: refuse before either is resolved.
  if (values['--all'] === true && sessionId !== undefined) {
    return {
      valid: false,
      error: '--all and --session are mutually exclusive',
    };
  }
  return {
    valid: true,
    options: {
      ...(values['--dry-run'] === true ? { dryRun: true } : {}),
      ...(values['--json'] === true ? { json: true } : {}),
      ...(values['--all'] === true ? { all: true } : {}),
      ...(values['--force'] === true ? { force: true } : {}),
      ...(values['--journal'] === true ? { journal: true } : {}),
      ...(maxAgeMs === undefined ? {} : { maxAgeMs }),
      ...(maxBytes === undefined ? {} : { maxBytes }),
      ...(sessionId === undefined ? {} : { sessionId }),
    },
  };
}

function journalPolicy(options: CleanOptions): {
  maxAgeMs?: number;
  maxBytes?: number;
} {
  const bounded =
    options.maxAgeMs !== undefined || options.maxBytes !== undefined;
  return {
    ...(options.maxAgeMs === undefined ? {} : { maxAgeMs: options.maxAgeMs }),
    ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
    // `--journal` alone prunes to the store's default byte bound, so the
    // flag is never a silent no-op.
    ...(options.journal === true && !bounded
      ? { maxBytes: DEFAULT_JOURNAL_MAX_BYTES }
      : {}),
  };
}

// Only spawned worktrees *on a kubic/<agent> branch* are planned — the main
// checkout, hand-made worktrees, and namespace-shaped checkouts sitting on a
// foreign branch are never planned. Scope is repoRoot-anchored (normalized
// prefix under `<root>/.kubic/wt/`) when repoRoot is known; otherwise a
// normalized shape-only fallback so direct `..` escapes never slip through a
// substring filter. The composition root always supplies (or defaults) the
// repo root, so the unanchored path is never the shipped default.
export function planClean(
  entries: WorktreeEntry[],
  options: CleanOptions,
  repoRoot?: string,
  branches: readonly string[] = [],
  worktreeRoot?: string,
): CleanPlan {
  const inScope =
    repoRoot === undefined
      ? (path: string): boolean => isSpawnedWorktreeShape(path, worktreeRoot)
      : (path: string): boolean =>
          isSpawnedWorktreePath(repoRoot, path, worktreeRoot);
  const spawnedBranch = (branch: string | null): boolean =>
    branch !== null && parseBranchAgent(branch) !== null;
  return {
    worktrees: entries
      .filter((entry) => inScope(entry.path) && spawnedBranch(entry.branch))
      .map((entry) => ({ path: entry.path, branch: entry.branch })),
    branches: [...branches].filter((branch) => spawnedBranch(branch)),
    journal: journalPolicy(options),
  };
}

// Session scope: one failed or finished orchestrate run names its agents in
// `<root>/.kubic/orchestrator/<session>.json`. The retained set for that
// session is exactly `kubic/<agent>` at `<root>/<worktreeRoot>/<agent>` per
// named agent — deterministic, so a hand-deleted directory still plans its
// branch.
export function planSessionClean(
  agents: readonly string[],
  repoRoot: string,
  options: CleanOptions,
  worktreeRoot?: string,
): CleanPlan {
  const worktrees: { path: string; branch: string | null }[] = [];
  const branches: string[] = [];
  for (const agent of agents) {
    // Agent ids from stored state are untrusted JSON — anything outside the
    // naming pattern is dropped here, never turned into a git path.
    if (validateAgentId(agent).length > 0) continue;
    const branch = branchForAgent(agent);
    worktrees.push({
      path: pathForAgent(repoRoot, agent, worktreeRoot),
      branch,
    });
    branches.push(branch);
  }
  return { worktrees, branches, journal: journalPolicy(options) };
}

// Minimal, fail-closed read of a stored orchestrator state: a well-formed
// `agents: string[]` is all disposal needs. A lenient read is safe by
// construction — every planned name is re-confined to the spawned path and
// the `kubic/` namespace before any git call.
export function sessionAgentsFromState(raw: unknown): string[] | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const value = raw as Record<string, unknown>;
  if (!Array.isArray(value.agents)) return undefined;
  const agents: string[] = [];
  for (const entry of value.agents) {
    if (typeof entry !== 'string') return undefined;
    agents.push(entry);
  }
  return agents;
}

function defaultSessionAgents(
  sessionId: string,
  repoRoot: string,
): string[] | undefined {
  try {
    const bridge = createNodeFileBridge(
      join(repoRoot, '.kubic', 'orchestrator'),
    );
    const name = `${sessionId}.json`;
    if (!bridge.exists(name)) return undefined;
    return sessionAgentsFromState(JSON.parse(bridge.readTextFile(name)));
  } catch {
    return undefined;
  }
}

function sessionStorePath(repoRoot: string, sessionId: string): string {
  return join(repoRoot, '.kubic', 'orchestrator', `${sessionId}.json`);
}

function defaultPruneJournal(
  policy: { maxAgeMs?: number; maxBytes?: number },
  repoRoot: string,
): JournalPruneResult {
  const store = new FileJournalStore(join(repoRoot, '.kubic', 'journal'));
  return store.enforceRetention(policy);
}

// Prod deps for the composition root: the env is injected (host never
// constructs the node binding itself), the session store and the journal
// pruner are the real library paths.
export function cleanDepsWithDefaults(options: {
  env: ExecutionEnv;
  out: (line: string) => void;
  worktreeRoot?: string;
}): CleanDeps {
  return {
    env: options.env,
    out: options.out,
    ...(options.worktreeRoot === undefined
      ? {}
      : { worktreeRoot: options.worktreeRoot }),
    sessionAgents: defaultSessionAgents,
    pruneJournal: defaultPruneJournal,
  };
}

async function defaultResolveRepoRoot(
  env: ExecutionEnv,
): Promise<string | undefined> {
  const provenance: Provenance = {
    sessionId: 'cli',
    agentId: 'manager',
    toolCallId: 'clean-repo-root',
    turnId: 0,
    operation: 'worktree_list',
  };
  const handle = env.shell.spawn('git', ['rev-parse', '--show-toplevel'], {
    provenance,
  });
  const done = await handle.wait();
  const root = done.stdout.trim();
  if (done.exitCode !== 0 || root.length === 0) return undefined;
  return root;
}

function noopPrune(): JournalPruneResult {
  return { entries: 0, bytes: 0 };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runCleanCommand(
  args: string[],
  deps: CleanDeps,
): Promise<number> {
  // `--help`/`-h` is answered before argv parsing (issue #100).
  const help = answerHelp(args, deps.out, CLEAN_USAGE);
  if (help !== null) return help;
  const parsed = parseCleanArgs(args);
  if (!parsed.valid) {
    deps.out(`error: ${parsed.error}`);
    return usage(deps.out);
  }
  const options = parsed.options;
  if (options.all === true && options.sessionId !== undefined) {
    deps.out('error: --all and --session are mutually exclusive');
    return usage(deps.out);
  }
  // The spawned set's parent comes from the config projection on the deps
  // (issue #133) — `[orchestrator].root`, `.kubic/wt` by default.
  const worktreeRoot = deps.worktreeRoot;

  // Outside a git repo the refusal is explicit and non-destructive: exit 2
  // before any list or mutation (§78), never a silent solo-like no-op.
  const repoRoot =
    deps.repoRoot ??
    (await (deps.resolveRepoRoot ?? defaultResolveRepoRoot)(deps.env));
  if (repoRoot === undefined) {
    deps.out(
      'error: `kubic clean` needs a git repository — it disposes retained `kubic/<agent>` worktrees and branches only; nothing was removed. Run solo here (`kubic run -p`) or retry inside a git checkout',
    );
    return usage(deps.out);
  }

  let plan: CleanPlan;
  try {
    if (options.sessionId !== undefined) {
      const agents = (deps.sessionAgents ?? defaultSessionAgents)(
        options.sessionId,
        repoRoot,
      );
      if (agents === undefined) {
        deps.out(
          `error: no retained set for session '${options.sessionId}' — expected ${sessionStorePath(repoRoot, options.sessionId)}; nothing was removed`,
        );
        return CLEAN_EXIT_FAILURE;
      }
      plan = planSessionClean(agents, repoRoot, options, worktreeRoot);
    } else {
      const lister = deps.lister ?? ((env) => listWorktrees(env));
      const branchLister =
        deps.branchLister ?? ((env) => listSpawnedBranches(env));
      const entries = await lister(deps.env);
      const branches = await branchLister(deps.env);
      plan = planClean(entries, options, repoRoot, branches, worktreeRoot);
    }
  } catch (error) {
    if (isWorktreeError(error)) {
      if (error.code === 'not_a_repo') {
        deps.out(`error: ${error.message} — nothing was removed`);
        return usage(deps.out);
      }
      deps.out(`error: ${error.message}`);
      return error.exitCode;
    }
    throw error;
  }

  const pruneJournal = deps.pruneJournal ?? defaultPruneJournal;
  const bounded =
    plan.journal.maxAgeMs !== undefined || plan.journal.maxBytes !== undefined;

  if (options.dryRun === true) {
    const changed =
      plan.worktrees.length > 0 || plan.branches.length > 0 || bounded;
    if (options.json === true) {
      deps.out(
        JSON.stringify(
          {
            ok: true,
            exitCode: CLEAN_EXIT_OK,
            dryRun: true,
            worktrees: plan.worktrees,
            branches: plan.branches,
            journal: plan.journal,
          },
          null,
          2,
        ),
      );
      return CLEAN_EXIT_OK;
    }
    if (!changed) {
      deps.out('clean: nothing to prune');
      return CLEAN_EXIT_OK;
    }
    for (const item of plan.worktrees) {
      deps.out(`would remove worktree ${item.path}`);
    }
    for (const branch of plan.branches) {
      deps.out(`would delete branch ${branch}`);
    }
    if (bounded) {
      deps.out('would prune journal entries outside the retention policy');
    }
    deps.out('clean (dry run): nothing changed');
    return CLEAN_EXIT_OK;
  }

  const remover =
    deps.remover ??
    ((env, path, removerOptions) =>
      removeWorktree(env, path, {
        force: removerOptions.force,
        sessionId: options.sessionId,
        repoRoot,
        ...(worktreeRoot === undefined ? {} : { worktreeRoot }),
      }));
  const branchDeleter =
    deps.branchDeleter ??
    ((env, branch) =>
      deleteSpawnedBranch(env, branch, { sessionId: options.sessionId }));
  const pruner =
    deps.pruner ??
    ((env) => pruneWorktrees(env, { sessionId: options.sessionId }));

  const removed: { path: string; branch: string | null }[] = [];
  const deleted: string[] = [];
  const failures: { target: string; message: string }[] = [];
  for (const item of plan.worktrees) {
    try {
      await remover(deps.env, item.path, { force: options.force === true });
      removed.push(item);
    } catch (error) {
      failures.push({ target: item.path, message: messageOf(error) });
      // Never half-dispose: a worktree that is still standing keeps its
      // branch (git would refuse the delete anyway; this is explicit).
      continue;
    }
    if (item.branch !== null) {
      try {
        await branchDeleter(deps.env, item.branch);
        deleted.push(item.branch);
      } catch (error) {
        failures.push({ target: item.branch, message: messageOf(error) });
      }
    }
  }
  // Branches whose worktree is already gone (hand-deleted directory, stale
  // admin record) are still Kubic-named and still disposable.
  const covered = new Set(plan.worktrees.map((item) => item.branch));
  for (const branch of plan.branches) {
    if (covered.has(branch)) continue;
    try {
      await branchDeleter(deps.env, branch);
      deleted.push(branch);
    } catch (error) {
      failures.push({ target: branch, message: messageOf(error) });
    }
  }
  try {
    await pruner(deps.env);
  } catch (error) {
    failures.push({ target: 'worktree prune', message: messageOf(error) });
  }
  const journal = bounded ? pruneJournal(plan.journal, repoRoot) : noopPrune();
  const exitCode = failures.length > 0 ? CLEAN_EXIT_FAILURE : CLEAN_EXIT_OK;

  if (options.json === true) {
    deps.out(
      JSON.stringify(
        {
          ok: exitCode === CLEAN_EXIT_OK,
          exitCode,
          dryRun: false,
          worktrees: removed,
          branches: deleted,
          journal,
          ...(failures.length === 0 ? {} : { failures }),
        },
        null,
        2,
      ),
    );
    return exitCode;
  }
  for (const item of removed) deps.out(`removed worktree ${item.path}`);
  for (const branch of deleted) deps.out(`deleted branch ${branch}`);
  for (const failure of failures) {
    deps.out(`error: ${failure.message}`);
  }
  // "nothing to prune" only when the invocation disposed nothing at all —
  // a journal-only prune already reported its own counts below.
  if (
    removed.length === 0 &&
    deleted.length === 0 &&
    failures.length === 0 &&
    !bounded
  ) {
    deps.out('clean: nothing to prune');
  }
  if (bounded) {
    deps.out(
      `journal: pruned ${journal.entries} entr(ies), freed ${journal.bytes} byte(s)`,
    );
  }
  return exitCode;
}
