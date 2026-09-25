// Prod `kubic orchestrate` deps (issue #76): the composition root drives the
// real EPIC E stack — git worktrees via addWorktree, worker runs as child
// `kubic run -p` processes inside their worktrees (one process per subagent),
// FIFO merge via `git merge` (a pre-merge guard aborts stale MERGE_HEAD
// and refuses dirty trees, plus abort-after-failure, so the tree is
// never half-merged), with a write-ahead merging intent per candidate
// (kill between merge and save reconciles via merge-base --is-ancestor
// instead of double-merging), and session state under
// <repo>/.kubic/orchestrator/<session>.json written atomically (tmp +
// rename, fail-closed) through the exec FileBridge. The manager authors nothing: worker commits run under
// worker provenance, merges are worker-branch merges, and every merge passes
// through the assertManagerZeroWrites gate in orchestrate-cli.ts.

import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { ShellResult } from '../../../packages/exec/src/env.js';
import { NodeExecutionEnv } from '../../../packages/exec/src/env.js';
import { createNodeFileBridge } from '../../../packages/exec/src/file-bridge.js';
import { ensureRuntimeExcludeRules } from '../../../packages/exec/src/runtime-exclude.js';
import type {
  OrchestrateCommandDeps,
  OrchestrateWorktree,
  OrchestratorRunState,
  WorkerSpawnInfo,
} from '../../../packages/host/src/orchestrate-cli.js';
import {
  MergeConflictError,
  parseOrchestratorRunState,
  workerSessionFor,
} from '../../../packages/host/src/orchestrate-cli.js';
import type { MergedHunk } from '../../../packages/host/src/orchestrator/merge/attribution.js';
import { addWorktree } from '../../../packages/host/src/orchestrator/worktree/add.js';
import {
  isWorktreeError,
  worktreeMissingError,
} from '../../../packages/host/src/orchestrator/worktree/errors.js';
import {
  branchForAgent,
  pathForAgent,
} from '../../../packages/host/src/orchestrator/worktree/naming.js';
import { defaultSessionsRoot } from '../../../packages/host/src/sessions-cli.js';
import {
  attachSession,
  createSession,
  openSessionStore,
  SessionAttachError,
} from '../../../packages/worker/src/lane/session-store.js';
import { BACKGROUND_CONTEXT } from '../../../packages/worker/src/pi-boundary.js';

export interface OrchestrateRunOptions {
  out: (line: string) => void;
  debug?: (line: string) => void;
  cwd?: string;
  /** Worker sessions root; defaults to the user sessions root (~/.kubic/sessions). */
  sessionsRoot?: string;
}

function provenanceFor(sessionId: string, agentId: string, tool: string) {
  return {
    sessionId,
    agentId,
    toolCallId: tool,
    turnId: 0,
    operation: 'orchestrate',
  };
}

async function runGit(
  cwd: string,
  args: string[],
  sessionId: string,
  agentId: string,
  tool: string,
): Promise<ShellResult> {
  const env = new NodeExecutionEnv(cwd);
  return env.shell
    .spawn('git', args, { provenance: provenanceFor(sessionId, agentId, tool) })
    .wait();
}

function entryScript(): string {
  const argv1 = process.argv[1];
  if (typeof argv1 === 'string' && argv1.endsWith('.js')) return argv1;
  return resolve(process.cwd(), 'bin', 'kubic.js');
}

// Kubic's own state dir must never dirty the tree it sits in (§35: `.kubic/`
// runtime state is ignored). A fresh `git init` scratch repo has no ignore
// entry, so the dir shows up as `?? .kubic/` and the pre-merge guard refuses
// every merge — no run can settle.
//
// The rules come from issue #91's single source of truth (the same mechanism
// `kubic run` uses at dispatch): the five runtime prefixes go into the
// repo-local, uncommitted exclude file, so `.kubic/roles/*.md` and
// `config.toml` stay committable. An earlier version of this helper wrote a
// `*` file into `.kubic/.gitignore`, which ignored the roles too — verified
// to break `git add .kubic/roles/new-role.md` — so it defers here instead.
// Best-effort: a repo we cannot write into fails later with its own named code.
function ensureStateIgnored(root: string): void {
  ensureRuntimeExcludeRules({ cwd: root });
}

async function askUser(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await new Promise<string>((resolveAnswer) => {
      rl.question(question, resolveAnswer);
    });
    return /^y(es)?\s*$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

export async function orchestrateDepsWithDefaults(
  options: OrchestrateRunOptions,
): Promise<OrchestrateCommandDeps> {
  const cwd = options.cwd ?? process.cwd();
  const debug = options.debug ?? (() => undefined);
  const top = await runGit(
    cwd,
    ['rev-parse', '--show-toplevel'],
    'cli',
    'manager',
    'repo-root',
  );
  const root = top.exitCode === 0 ? top.stdout.trim() : undefined;

  const needRoot = (): string => {
    if (root === undefined) throw new Error('not a git repository');
    return root;
  };

  // The orchestrator writes its state under `<repo>/.kubic/` from the very
  // first save (and adds worktrees under it). Make sure that dir never dirties
  // the tree it sits in (§35: `.kubic/` is gitignored) BEFORE the first write
  // — otherwise a fresh scratch repo shows `?? .kubic/` and the pre-merge
  // guard refuses every merge, so no run can ever settle. Best-effort here:
  // a repo we cannot write into fails later with its own named code.
  if (root !== undefined) {
    try {
      ensureStateIgnored(root);
    } catch {
      // Intentionally swallowed — the named failure comes from the write path.
    }
  }

  // The session branch at start is the merge target and the hunk base.
  // Resolved lazily (only inside a repo) and cached per process.
  let baseRef: string | undefined;
  const resolveBase = async (
    repo: string,
    sessionId: string,
  ): Promise<string> => {
    if (baseRef !== undefined) return baseRef;
    const branch = await runGit(
      repo,
      ['branch', '--show-current'],
      sessionId,
      'manager',
      'base-branch',
    );
    const name = branch.stdout.trim();
    if (branch.exitCode === 0 && name.length > 0) {
      baseRef = name;
      return baseRef;
    }
    const head = await runGit(
      repo,
      ['rev-parse', 'HEAD'],
      sessionId,
      'manager',
      'base-head',
    );
    baseRef = head.stdout.trim();
    return baseRef;
  };

  const storeName = (sessionId: string): string => `${sessionId}.json`;

  // Worker sessions live in the user sessions root (one store for the whole
  // CLI, `kubic sessions`/`diff --session` read the same place). Injected
  // in tests; the real run uses the default root.
  const sessionsRoot = options.sessionsRoot ?? defaultSessionsRoot();
  const sessionBridge = createNodeFileBridge(sessionsRoot);
  const sessionStore = openSessionStore(sessionsRoot, sessionBridge);

  // Pre-merge guard (issue #76 fix a): a kill-during-merge can leave a
  // stale MERGE_HEAD behind, so a resume would merge onto a half-merged
  // tree. Abort the stale merge first, then refuse a dirty tree — the
  // merge never runs unless the tree is provably clean.
  const ensureCleanMergeState = async (
    repo: string,
    agentId: string,
  ): Promise<void> => {
    const merging = await runGit(
      repo,
      ['rev-parse', '--verify', 'MERGE_HEAD'],
      'cli',
      'manager',
      'merge-guard',
    );
    if (merging.exitCode === 0) {
      debug(
        `merge: stale MERGE_HEAD before merging '${agentId}' — aborting first`,
      );
      const abort = await runGit(
        repo,
        ['merge', '--abort'],
        'cli',
        'manager',
        'merge-abort-stale',
      );
      if (abort.exitCode !== 0) {
        throw new Error(
          `stale merge in progress (MERGE_HEAD) and 'git merge --abort' failed: ${abort.stderr.trim().slice(0, 200)}`,
        );
      }
    }
    const status = await runGit(
      repo,
      ['status', '--porcelain=v1'],
      'cli',
      'manager',
      'merge-status',
    );
    if (status.exitCode !== 0) {
      throw new Error(
        `pre-merge status check failed: ${status.stderr.trim().slice(0, 200)}`,
      );
    }
    if (status.stdout.trim().length > 0) {
      throw new Error(
        `working tree not clean — refusing merge for worker '${agentId}': ${status.stdout.trim().slice(0, 200)}`,
      );
    }
  };

  return {
    out: options.out,
    debug,
    isGitRepo: () => root !== undefined,
    ensureWorktree: async (agentId: string): Promise<OrchestrateWorktree> => {
      const repo = needRoot();
      const env = new NodeExecutionEnv(repo);
      ensureStateIgnored(repo);
      try {
        const added = await addWorktree(env, repo, agentId, {
          sessionId: 'cli',
        });
        for (const warning of added.warnings) debug(`gap: ${warning.message}`);
        return { path: added.path, branch: added.branch };
      } catch (error) {
        // Resume tolerance: the worktree/branch from a killed run is
        // reused — never rebuilt over, never silently dropped. The
        // directory must really be there: handing a vanished path to the
        // child spawn dies as a raw `spawn … ENOENT` uncaught event with
        // no §78 code (issue #85), so fail closed with a named error.
        if (isWorktreeError(error) && error.code === 'already_exists') {
          const path = pathForAgent(repo, agentId);
          const branch = branchForAgent(agentId);
          const probe = new NodeExecutionEnv(repo);
          let present = false;
          try {
            present = probe.fs.stat(path).isDirectory;
          } catch {
            present = false;
          }
          if (!present) throw worktreeMissingError(path, branch);
          return { path, branch };
        }
        throw error;
      }
    },
    createWorkerSession: async (input) => {
      // Create the worker's session before the child spawns (issue #85):
      // `kubic run --session <id>` only ATTACHES, so without this the child
      // dies at attach (exit 5 "unknown session") before any model call.
      // The cwd is the worker's WORKTREE, so worker journals, usage, and
      // session state land with the worker — never in the parent repo.
      // Resume tolerance: a session left by a killed run is re-attached
      // (one chain), never recreated into a "Session already exists" fail.
      try {
        const existing = await attachSession(
          sessionStore,
          input.workerSessionId,
          BACKGROUND_CONTEXT,
        );
        // The worker's whole point is that its state travels with its
        // worktree: a session recorded against a different cwd (a hand
        // re-pointed id, a worktree moved and re-added) would silently
        // journal somewhere else. Fail closed rather than misuse it.
        const recorded = existing.metadata.cwd;
        await existing.close(BACKGROUND_CONTEXT);
        if (recorded !== input.worktree.path) {
          throw new Error(
            `session '${input.workerSessionId}' belongs to ${recorded ?? '(no cwd)'}, not the worker worktree ${input.worktree.path}`,
          );
        }
        debug(
          `session: reusing '${input.workerSessionId}' from the killed run`,
        );
        return { sessionId: input.workerSessionId };
      } catch (error) {
        if (!(error instanceof SessionAttachError)) throw error;
      }
      const session = await createSession(
        sessionStore,
        input.worktree.path,
        BACKGROUND_CONTEXT,
        input.workerSessionId,
      );
      const id = session.metadata.id;
      try {
        // The session dir exists; create the journal dir the worker's
        // file effects will land in (same layout as `kubic run`, E3) so
        // `journal:<id>` resolves for the worker's worktree effects.
        sessionBridge.createDir(join(id, 'journal'));
      } finally {
        await session.close(BACKGROUND_CONTEXT);
      }
      debug(
        `session: created '${id}' for worker '${input.agentId}' (cwd ${input.worktree.path})`,
      );
      return { sessionId: id };
    },
    runWorker: async (
      agentId: string,
      worktree: OrchestrateWorktree,
      prompt: string,
      info?: WorkerSpawnInfo,
    ): Promise<MergedHunk[]> => {
      const repo = needRoot();
      void repo;
      const workerSession =
        info?.workerSessionId ??
        workerSessionFor(info?.sessionId ?? 'orch', agentId);
      const child = new NodeExecutionEnv(worktree.path);
      const done = await child.shell
        .spawn(
          process.execPath,
          [
            entryScript(),
            'run',
            '-p',
            prompt,
            '--session',
            workerSession,
            '--json',
          ],
          { provenance: provenanceFor(workerSession, agentId, 'worker-run') },
        )
        .wait();
      if (done.exitCode !== 0) {
        const last = done.stdout.trim().split('\n').pop() ?? '';
        let detail = done.stderr.trim() || done.stdout.trim();
        try {
          const envelope = JSON.parse(last) as { error?: { message?: string } };
          if (typeof envelope.error?.message === 'string')
            detail = envelope.error.message;
        } catch {
          // Non-JSON output — keep the raw detail.
        }
        throw new Error(
          `worker run exited ${done.exitCode}: ${detail.slice(0, 300)}`,
        );
      }
      // The worker authors (sole committer on its branch); the manager
      // never stages or commits — see assertManagerZeroWrites.
      const status = await runGit(
        worktree.path,
        ['status', '--porcelain=v1'],
        workerSession,
        agentId,
        'worker-status',
      );
      if (status.exitCode === 0 && status.stdout.trim().length > 0) {
        const add = await runGit(
          worktree.path,
          ['add', '-A'],
          workerSession,
          agentId,
          'worker-stage',
        );
        if (add.exitCode !== 0)
          throw new Error(
            `worker stage failed: ${add.stderr.trim().slice(0, 200)}`,
          );
        const commit = await runGit(
          worktree.path,
          [
            '-c',
            'user.name=kubic-worker',
            '-c',
            'user.email=kubic-worker@local',
            'commit',
            '-m',
            `worker ${agentId}: ${prompt.slice(0, 120)}`,
          ],
          workerSession,
          agentId,
          'worker-commit',
        );
        if (commit.exitCode !== 0)
          throw new Error(
            `worker commit failed: ${commit.stderr.trim().slice(0, 200)}`,
          );
      }
      const base = await resolveBase(needRoot(), workerSession);
      const names = await runGit(
        worktree.path,
        ['diff', '--name-only', `${base}...HEAD`, '--'],
        workerSession,
        agentId,
        'worker-diff',
      );
      if (names.exitCode !== 0)
        throw new Error(
          `worker diff failed: ${names.stderr.trim().slice(0, 200)}`,
        );
      const hunks: MergedHunk[] = [];
      for (const path of names.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)) {
        const diff = await runGit(
          worktree.path,
          ['diff', `${base}...HEAD`, '--', path],
          workerSession,
          agentId,
          'worker-hunk',
        );
        hunks.push({ path, hunk: diff.stdout });
      }
      return hunks;
    },
    mergeBranch: async (
      agentId: string,
      worktree: OrchestrateWorktree,
    ): Promise<void> => {
      const repo = needRoot();
      // Guard first (fix a): never merge onto a half-merged tree — the
      // CLI also calls prepareMerge, this covers direct callers too.
      await ensureCleanMergeState(repo, agentId);
      const merged = await runGit(
        repo,
        ['merge', '--no-ff', worktree.branch, '-m', `kubic: merge ${agentId}`],
        'cli',
        'manager',
        'merge',
      );
      if (merged.exitCode !== 0) {
        // Abort first: the tree is never left half-merged.
        await runGit(
          repo,
          ['merge', '--abort'],
          'cli',
          'manager',
          'merge-abort',
        );
        const output = `${merged.stdout}\n${merged.stderr}`;
        if (/conflict/i.test(output)) {
          throw new MergeConflictError(agentId, {
            oursDiff: merged.stdout.slice(0, 2000),
            theirsDiff: merged.stderr.slice(0, 2000),
          });
        }
        throw new Error(
          `git merge ${worktree.branch} failed (exit ${merged.exitCode}): ${merged.stderr.trim().slice(0, 200)}`,
        );
      }
    },
    prepareMerge: async (agentId: string): Promise<void> => {
      await ensureCleanMergeState(needRoot(), agentId);
    },
    isBranchMerged: async (
      agentId: string,
      worktree: OrchestrateWorktree,
    ): Promise<boolean> => {
      // Write-ahead intent reconciliation (issue #76 fix b): exit 0
      // means the worker branch is already an ancestor of the merge
      // target, so resume marks it merged without re-running the worker.
      // Any other exit (branch missing, not merged) means retry.
      void agentId;
      const repo = needRoot();
      const done = await runGit(
        repo,
        ['merge-base', '--is-ancestor', worktree.branch, 'HEAD'],
        'cli',
        'manager',
        'merge-check',
      );
      return done.exitCode === 0;
    },
    reapWorker: (agentId: string): void => {
      // The child process was reaped at wait() inside runWorker; the
      // worktree + branch stay retained as evidence (§44.1 — only
      // `kubic clean` disposes). Reap here is the accounting step.
      debug(`reaped: ${agentId} (worktree + branch retained)`);
    },
    requestApproval:
      process.stdin.isTTY === true
        ? async (input: {
            agentId: string;
            branch: string;
          }): Promise<boolean> =>
            askUser(
              `approve merge of '${input.agentId}' (${input.branch})? [y/N] `,
            )
        : undefined,
    loadState: (sessionId: string): OrchestratorRunState | undefined => {
      try {
        const repo = needRoot();
        const bridge = createNodeFileBridge(
          join(repo, '.kubic', 'orchestrator'),
        );
        if (!bridge.exists(storeName(sessionId))) return undefined;
        const raw = bridge.readTextFile(storeName(sessionId));
        // Structural validation (issue #76 fix): torn writes, hand
        // edits, or newer versions fail closed as missing state —
        // never a half-shaped object the resume path crashes on.
        return parseOrchestratorRunState(JSON.parse(raw), sessionId);
      } catch {
        return undefined;
      }
    },
    saveState: (state: OrchestratorRunState): void => {
      // Atomic + fail-closed (issue #76 fix c): write to a temp file in
      // the same directory and rename over the target, so a kill can
      // never leave a torn state file behind. Write errors propagate
      // (the CLI maps them to state_save_failed) — never swallowed to
      // debug-only.
      const repo = needRoot();
      const bridge = createNodeFileBridge(join(repo, '.kubic', 'orchestrator'));
      const target = storeName(state.sessionId);
      const tmp = `${target}.tmp.${process.pid}.${randomUUID().slice(0, 8)}`;
      try {
        bridge.writeFile(tmp, JSON.stringify(state, null, 2));
        bridge.renameFile(tmp, target);
      } catch (error) {
        try {
          bridge.remove(tmp);
        } catch {
          // Best-effort temp cleanup — the original error is what matters.
        }
        const message = error instanceof Error ? error.message : String(error);
        debug(
          `state: save failed for session '${state.sessionId}': ${message}`,
        );
        throw new Error(
          `orchestrator state save failed for session '${state.sessionId}': ${message}`,
        );
      }
    },
  };
}
