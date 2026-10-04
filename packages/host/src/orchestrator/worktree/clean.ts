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

import { dirname, join, resolve } from 'node:path';
import {
  EXIT_FAILED,
  EXIT_OK,
  EXIT_USAGE,
  EXIT_WORKSPACE,
} from '../../../../core/src/cli/exit-codes.js';
import { createLineLogger } from '../../../../core/src/cli/logger.js';
import { formatJson } from '../../../../core/src/cli/output.js';
import {
  type CliTheme,
  createCliTheme,
} from '../../../../core/src/cli/theme.js';
import type { ExecutionEnv, Provenance } from '../../../../exec/src/env.js';
import { createNodeFileBridge } from '../../../../exec/src/file-bridge.js';
import {
  DEFAULT_JOURNAL_MAX_BYTES,
  FileJournalStore,
} from '../../../../exec/src/journal.js';
import {
  commandOwnsSession,
  isLiveWorkerRow,
  killProcessGroup,
} from '../../../../worker/src/lifecycle/orphans.js';
import { workersListFromRepo } from '../../../../worker/src/lifecycle/rows.js';
import { resolveRepoRuntimeRoot } from '../../policy/audit-ledger.js';
import { SESSION_ID_PATTERN } from '../../run-cli.js';
import {
  approvalsSessionDir,
  removeSessionApprovalsState,
} from '../approvals/worker-asks.js';
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
  DEFAULT_WORKTREE_ROOT,
  parseBranchAgent,
  parseSpawnedBranch,
  pathForAgent,
  type SpawnedBranch,
  validateAgentId,
} from './naming.js';
import {
  deleteSpawnedBranch,
  pruneWorktrees,
  removeWorktree,
} from './remove.js';

export const CLEAN_EXIT_OK = EXIT_OK;

export const CLEAN_EXIT_FAILURE = EXIT_FAILED;

// §78: 2 is usage; the non-repo refusal is 5 (workspace_unavailable, issue
// #372) — a well-formed invocation whose workspace cannot run the command.
export const CLEAN_EXIT_USAGE = EXIT_USAGE;

export const CLEAN_EXIT_WORKSPACE = EXIT_WORKSPACE;

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
  // Issue #348: bytes the kept journal is still over the retention bound by,
  // when the newest entry alone cannot fit — it is never dropped, so the
  // excess is reported instead of deleted. 0 means the bound holds.
  overBound: number;
}

export interface CleanDeps {
  env: ExecutionEnv;
  // stdout: the disposal report or the `--json` document.
  out: (line: string) => void;
  // stderr: `error: …` diagnostics through the shared logger.
  err: (line: string) => void;
  // Colours the report verbs; colourless when absent (and under --json).
  theme?: CliTheme;
  // Colour of the stderr diagnostics, from stderr's own TTY state (never
  // stdout's); absent means plain.
  errTheme?: CliTheme;
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
  /** Workers whose process is still running, by agent id → pid (§51). A
   *  live worker's worktree is never disposed without --force. Defaults to
   *  the durable rows under `<repo>/.kubic/orchestrator/workers.json`. */
  liveWorkers?: (
    repoRoot: string,
  ) => Map<string, { pid: number; sessionId: string }>;
  /** A pid's command line (`ps -ww`), for the pid-reuse guard. */
  workerCommand?: (pid: number) => Promise<string | undefined>;
  /** Stops a live worker's process group (used only under --force). */
  killWorker?: (pid: number) => void;
  resolveRepoRoot?: (env: ExecutionEnv) => Promise<string | undefined>;
  /** Removes a directory only when it is empty (issue #144): the session
   *  directory a disposal emptied. Must be atomic and non-recursive — a
   *  concurrent `--resume` may add a worker directory at any moment. Defaults
   *  to `rmdir` through the env's shell. */
  removeEmptyDir?: (env: ExecutionEnv, path: string) => Promise<unknown>;
  /** Retires a session's stored run state (issue #144): called only once the
   *  session has nothing left to dispose (a full disposal, or no worktree or
   *  branch was ever left), so the id can start a fresh run. Defaults to
   *  removing `<repo>/.kubic/orchestrator/<session>.json` and that session's
   *  `approvals/<session>/` directory (its full-access record, decisions and
   *  ask mailbox) — never the repo-wide audit ledger. */
  retireSessionState?: (sessionId: string, repoRoot: string) => void;
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
// session is exactly `kubic/<session>/<agent>` at
// `<root>/<worktreeRoot>/<session>/<agent>` per named agent (issue #144: the
// names carry the session, so another session's same-named agent is never
// planned) — deterministic, so a hand-deleted directory still plans its
// branch. Without a session the legacy unscoped names are planned.
export function planSessionClean(
  agents: readonly string[],
  repoRoot: string,
  options: CleanOptions,
  worktreeRoot?: string,
  sessionId?: string,
): CleanPlan {
  const worktrees: { path: string; branch: string | null }[] = [];
  const branches: string[] = [];
  for (const agent of agents) {
    // Agent ids from stored state are untrusted JSON — anything outside the
    // naming pattern is dropped here, never turned into a git path.
    if (validateAgentId(agent).length > 0) continue;
    const branch = branchForAgent(agent, sessionId);
    worktrees.push({
      path: pathForAgent(repoRoot, agent, worktreeRoot, sessionId),
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

// A session-scoped worktree lives at `<root>/<worktreeRoot>/<session>/<agent>`
// (issue #144): disposing its last agent leaves `<session>/` behind, empty.
// Removed with a plain `rmdir` — atomic and non-recursive: the kernel refuses a
// directory that holds anything (a hand-added file, or a `<session>/worker-N`
// a concurrent `orchestrate --resume` created after the disposal emptied it),
// so nothing is ever deleted that was not the empty directory itself. The
// refusal is the expected outcome, not a failure: the directory stays.
async function defaultRemoveEmptyDir(
  env: ExecutionEnv,
  path: string,
): Promise<void> {
  const provenance: Provenance = {
    sessionId: 'cli',
    agentId: 'manager',
    toolCallId: 'clean-session-dir',
    turnId: 0,
    operation: 'clean',
  };
  await env.shell.spawn('rmdir', [path], { provenance }).wait();
}

// The run's approvals state sits under the repo runtime root (issue #279),
// which is `repoRoot` itself outside a linked worktree.
function sessionApprovalsRoot(repoRoot: string): string {
  return join(resolveRepoRuntimeRoot(repoRoot), '.kubic', 'orchestrator');
}

function sessionApprovalsPath(repoRoot: string, sessionId: string): string {
  return approvalsSessionDir(sessionApprovalsRoot(repoRoot), sessionId);
}

// Retiring a session also drops its `approvals/<session>/` directory: a stale
// full-access record or memoized decision must never be inherited by a later
// run that reuses the id. Only that one directory — the ledger stays.
function defaultRetireSessionState(sessionId: string, repoRoot: string): void {
  const bridge = createNodeFileBridge(join(repoRoot, '.kubic', 'orchestrator'));
  const name = `${sessionId}.json`;
  if (bridge.exists(name)) bridge.remove(name);
  removeSessionApprovalsState(sessionApprovalsRoot(repoRoot), sessionId);
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
  err: (line: string) => void;
  theme?: CliTheme;
  errTheme?: CliTheme;
  worktreeRoot?: string;
}): CleanDeps {
  return {
    env: options.env,
    out: options.out,
    err: options.err,
    ...(options.theme === undefined ? {} : { theme: options.theme }),
    ...(options.errTheme === undefined ? {} : { errTheme: options.errTheme }),
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
  return { entries: 0, bytes: 0, overBound: 0 };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultLiveWorkers(
  repoRoot: string,
): Map<string, { pid: number; sessionId: string }> {
  const live = new Map<string, { pid: number; sessionId: string }>();
  for (const row of workersListFromRepo(repoRoot)) {
    if (row.pid !== undefined && isLiveWorkerRow(row)) {
      live.set(row.workerId, { pid: row.pid, sessionId: row.sessionId });
      // Also keyed by the worker session (issue #144): two sessions may
      // each run a `worker-1`, and only the planned session's row counts.
      live.set(row.sessionId, { pid: row.pid, sessionId: row.sessionId });
    }
  }
  return live;
}

// The live row for a planned branch (issue #144). A session-scoped branch
// matches only its own worker session (`<session>-<agent>`, the
// orchestrator's worker-session naming), so cleaning session A never kills
// or refuses on session B's same-named worker. A legacy branch keeps the
// agent-keyed lookup.
function liveEntryFor(
  live: Map<string, { pid: number; sessionId: string }>,
  spawned: SpawnedBranch,
): { pid: number; sessionId: string } | undefined {
  if (spawned.sessionId === undefined) return live.get(spawned.agentId);
  const workerSession = `${spawned.sessionId}-${spawned.agentId}`;
  const bySession = live.get(workerSession);
  if (bySession !== undefined) return bySession;
  const byAgent = live.get(spawned.agentId);
  return byAgent?.sessionId === workerSession ? byAgent : undefined;
}

// The parsed `kubic clean` options arrive from the commander program
// (apps/kubic/src/commands/orchestrator.ts): unknown flags, missing or
// malformed values, an invalid `--session` id and `--all` with `--session`
// are refused there (exit 2) before this runs.
export async function runCleanCommand(
  options: CleanOptions,
  deps: CleanDeps,
): Promise<number> {
  const theme =
    options.json === true || deps.theme === undefined
      ? createCliTheme('none')
      : deps.theme;
  const log = createLineLogger(deps.err, {
    theme:
      options.json === true || deps.errTheme === undefined
        ? createCliTheme('none')
        : deps.errTheme,
  });
  // Defence in depth: the id names a state file under .kubic/orchestrator,
  // so a library caller cannot bypass the CLI's own --session check.
  if (
    options.sessionId !== undefined &&
    !SESSION_ID_PATTERN.test(options.sessionId)
  ) {
    log.error(
      `invalid --session id ${JSON.stringify(options.sessionId)} (use [A-Za-z0-9_-]); nothing was removed`,
    );
    return CLEAN_EXIT_USAGE;
  }
  // The spawned set's parent comes from the config projection on the deps
  // (issue #133) — `[orchestrator].root`, `.kubic/wt` by default.
  const worktreeRoot = deps.worktreeRoot;

  // Outside a git repo the refusal is explicit and non-destructive: exit 5
  // before any list or mutation (§78, issue #372), never a silent
  // solo-like no-op. Under `--json` the same one-document envelope a run
  // emits is printed (nothing planned, nothing touched, exitCode 5) so the
  // refusal is machine-readable too; text mode keeps stdout empty and the
  // one stderr `error:` line.
  const refuseNonRepo = (message: string): number => {
    log.error(message);
    if (options.json === true) {
      deps.out(
        formatJson({
          ok: false,
          exitCode: CLEAN_EXIT_WORKSPACE,
          dryRun: options.dryRun === true,
          worktrees: [],
          branches: [],
          journal: noopPrune(),
        }),
      );
    }
    return CLEAN_EXIT_WORKSPACE;
  };
  const repoRoot =
    deps.repoRoot ??
    (await (deps.resolveRepoRoot ?? defaultResolveRepoRoot)(deps.env));
  if (repoRoot === undefined) {
    return refuseNonRepo(
      '`kubic clean` needs a git repository — it disposes retained `kubic/<session>/<agent>` worktrees and branches only; nothing was removed. Run solo here (`kubic run -p`) or retry inside a git checkout',
    );
  }

  let plan: CleanPlan;
  // The session plan was narrowed by a successful listing: an empty plan then
  // means nothing of the session is left standing (not merely unreadable).
  let sessionListed = false;
  try {
    if (options.sessionId !== undefined) {
      const agents = (deps.sessionAgents ?? defaultSessionAgents)(
        options.sessionId,
        repoRoot,
      );
      if (agents === undefined) {
        log.error(
          `no retained set for session '${options.sessionId}' — expected ${sessionStorePath(repoRoot, options.sessionId)}; nothing was removed`,
        );
        return CLEAN_EXIT_FAILURE;
      }
      const planned = planSessionClean(
        agents,
        repoRoot,
        options,
        worktreeRoot,
        options.sessionId,
      );
      // Only what the run actually left behind (issue #144): a worker that
      // never spawned — the usual shape of a failed run — has neither a
      // worktree nor a branch, and asking git to remove them would fail the
      // whole disposal. An unreadable listing keeps the full plan.
      plan = planned;
      try {
        const lister = deps.lister ?? ((env) => listWorktrees(env));
        const branchLister =
          deps.branchLister ?? ((env) => listSpawnedBranches(env));
        const listedPaths = new Set(
          (await lister(deps.env)).map((entry) => resolve(entry.path)),
        );
        const listedBranches = new Set(await branchLister(deps.env));
        plan = {
          ...planned,
          worktrees: planned.worktrees.filter((item) =>
            listedPaths.has(resolve(item.path)),
          ),
          branches: planned.branches.filter((branch) =>
            listedBranches.has(branch),
          ),
        };
        sessionListed = true;
      } catch {
        plan = planned;
      }
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
        return refuseNonRepo(`${error.message} — nothing was removed`);
      }
      log.error(error.message);
      return error.exitCode;
    }
    throw error;
  }

  const pruneJournal = deps.pruneJournal ?? defaultPruneJournal;
  const bounded =
    plan.journal.maxAgeMs !== undefined || plan.journal.maxBytes !== undefined;

  const planEmpty = plan.worktrees.length === 0 && plan.branches.length === 0;

  if (options.dryRun === true) {
    // A session-scoped clean retires the session's state (and its approvals
    // directory) once nothing of it is left standing.
    const wouldRetire =
      options.sessionId !== undefined && (!planEmpty || sessionListed);
    const changed = !planEmpty || bounded || wouldRetire;
    if (options.json === true) {
      deps.out(
        formatJson({
          ok: true,
          exitCode: CLEAN_EXIT_OK,
          dryRun: true,
          worktrees: plan.worktrees,
          branches: plan.branches,
          journal: plan.journal,
        }),
      );
      return CLEAN_EXIT_OK;
    }
    if (!changed) {
      deps.out(theme.muted('clean: nothing to prune'));
      return CLEAN_EXIT_OK;
    }
    for (const item of plan.worktrees) {
      deps.out(`${theme.warning('would remove')} worktree ${item.path}`);
    }
    for (const branch of plan.branches) {
      deps.out(`${theme.warning('would delete')} branch ${branch}`);
    }
    if (wouldRetire && options.sessionId !== undefined) {
      deps.out(
        `${theme.warning('would retire')} session state ${sessionStorePath(repoRoot, options.sessionId)} and its approvals directory ${sessionApprovalsPath(repoRoot, options.sessionId)}`,
      );
    }
    if (bounded) {
      deps.out(
        `${theme.warning('would prune')} journal entries outside the retention policy`,
      );
    }
    deps.out(theme.muted('clean (dry run): nothing changed'));
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
  const live = (deps.liveWorkers ?? defaultLiveWorkers)(repoRoot);
  const killWorker = deps.killWorker ?? killProcessGroup;
  const workerCommand =
    deps.workerCommand ??
    (async (pid: number): Promise<string | undefined> => {
      const ps = await deps.env.shell
        .spawn('ps', ['-ww', '-o', 'command=', '-p', String(pid)], {
          provenance: {
            sessionId: options.sessionId ?? 'cli',
            agentId: 'manager',
            toolCallId: 'clean-live-probe',
            turnId: 0,
            operation: 'clean',
          },
        })
        .wait();
      return ps.exitCode === 0 ? ps.stdout.trim() : undefined;
    });
  for (const item of plan.worktrees) {
    const spawned =
      item.branch === null ? null : parseSpawnedBranch(item.branch);
    const entry = spawned === null ? undefined : liveEntryFor(live, spawned);
    // Pid-reuse guard: a live pid whose command line does not name the
    // worker's own session is not our worker — treated as dead, never killed.
    const livePid =
      entry !== undefined &&
      commandOwnsSession(await workerCommand(entry.pid), entry.sessionId)
        ? entry.pid
        : undefined;
    if (livePid !== undefined && options.force === true) {
      killWorker(livePid);
    } else if (livePid !== undefined) {
      failures.push({
        target: item.path,
        message: `worker '${spawned?.agentId}' is still live (pid ${livePid}) — not removed; stop it or rerun with --force`,
      });
      continue;
    }
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
  // The session directories this run emptied (issue #144). Only the parent of
  // a worktree that was actually removed, and only when that parent sits
  // directly under the worktree root: a legacy unscoped tree's parent IS the
  // root, which is never removed. Best-effort — a leftover empty directory
  // must not fail a disposal that already succeeded.
  const wtRoot = resolve(repoRoot, worktreeRoot ?? DEFAULT_WORKTREE_ROOT);
  const removeEmptyDir = deps.removeEmptyDir ?? defaultRemoveEmptyDir;
  for (const dir of new Set(removed.map((item) => dirname(item.path)))) {
    if (dirname(dir) !== wtRoot) continue;
    try {
      await removeEmptyDir(deps.env, dir);
    } catch {
      // Left in place; the next `kubic clean` retries.
    }
  }
  // A FULL session clean retires the run's stored state (issue #144): the
  // state file is what makes a fresh run under the same `--session` id refuse
  // (`session_exists`), and `kubic clean --session <id>` is the documented way
  // out. Only when this invocation disposed something of the session with no
  // failure (every worktree left standing — dirty, live — is a failure, so
  // none remains), or the listing showed nothing of the session left to
  // dispose (workers that never got a worktree, or an earlier plain clean
  // already removed them) — never while a worktree remains, since the state is
  // what `--resume` and a later clean plan from.
  let retiredState: string | undefined;
  if (
    options.sessionId !== undefined &&
    failures.length === 0 &&
    (removed.length + deleted.length > 0 || (sessionListed && planEmpty))
  ) {
    try {
      (deps.retireSessionState ?? defaultRetireSessionState)(
        options.sessionId,
        repoRoot,
      );
      retiredState = sessionStorePath(repoRoot, options.sessionId);
    } catch (error) {
      failures.push({
        target: sessionStorePath(repoRoot, options.sessionId),
        message: messageOf(error),
      });
    }
  }
  const journal = bounded ? pruneJournal(plan.journal, repoRoot) : noopPrune();
  const exitCode = failures.length > 0 ? CLEAN_EXIT_FAILURE : CLEAN_EXIT_OK;

  if (options.json === true) {
    deps.out(
      formatJson({
        ok: exitCode === CLEAN_EXIT_OK,
        exitCode,
        dryRun: false,
        worktrees: removed,
        branches: deleted,
        journal,
        ...(retiredState === undefined ? {} : { retiredState }),
        ...(failures.length === 0 ? {} : { failures }),
      }),
    );
    return exitCode;
  }
  for (const item of removed) {
    deps.out(`${theme.success('removed')} worktree ${item.path}`);
  }
  for (const branch of deleted) {
    deps.out(`${theme.success('deleted')} branch ${branch}`);
  }
  if (retiredState !== undefined) {
    deps.out(`${theme.success('retired')} session state ${retiredState}`);
  }
  for (const failure of failures) log.error(failure.message);
  // "nothing to prune" only when the invocation disposed nothing at all —
  // a journal-only prune already reported its own counts below.
  if (
    removed.length === 0 &&
    deleted.length === 0 &&
    failures.length === 0 &&
    retiredState === undefined &&
    !bounded
  ) {
    deps.out(theme.muted('clean: nothing to prune'));
  }
  if (bounded) {
    const over =
      journal.overBound > 0
        ? `, over bound by ${journal.overBound} byte(s) (newest entry kept)`
        : '';
    deps.out(
      `journal: pruned ${journal.entries} entr(ies), freed ${journal.bytes} byte(s)${over}`,
    );
  }
  return exitCode;
}
