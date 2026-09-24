// Prod `kubic orchestrate` deps (issue #76): the composition root drives the
// real EPIC E stack — git worktrees via addWorktree, worker runs as child
// `kubic run -p` processes inside their worktrees (one process per subagent),
// FIFO merge via `git merge` (abort-first, so the tree is never half-merged),
// and session state under <repo>/.kubic/orchestrator/<session>.json through
// the exec FileBridge. The manager authors nothing: worker commits run under
// worker provenance, merges are worker-branch merges, and every merge passes
// through the assertManagerZeroWrites gate in orchestrate-cli.ts.

import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { ShellResult } from '../../../packages/exec/src/env.js';
import { NodeExecutionEnv } from '../../../packages/exec/src/env.js';
import { createNodeFileBridge } from '../../../packages/exec/src/file-bridge.js';
import type {
  OrchestrateCommandDeps,
  OrchestrateWorktree,
  OrchestratorRunState,
} from '../../../packages/host/src/orchestrate-cli.js';
import { MergeConflictError } from '../../../packages/host/src/orchestrate-cli.js';
import type { MergedHunk } from '../../../packages/host/src/orchestrator/merge/attribution.js';
import { addWorktree } from '../../../packages/host/src/orchestrator/worktree/add.js';
import { isWorktreeError } from '../../../packages/host/src/orchestrator/worktree/errors.js';
import {
  branchForAgent,
  pathForAgent,
} from '../../../packages/host/src/orchestrator/worktree/naming.js';

export interface OrchestrateRunOptions {
  out: (line: string) => void;
  debug?: (line: string) => void;
  cwd?: string;
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

  return {
    out: options.out,
    debug,
    isGitRepo: () => root !== undefined,
    ensureWorktree: async (agentId: string): Promise<OrchestrateWorktree> => {
      const repo = needRoot();
      const env = new NodeExecutionEnv(repo);
      try {
        const added = await addWorktree(env, repo, agentId, {
          sessionId: 'cli',
        });
        for (const warning of added.warnings) debug(`gap: ${warning.message}`);
        return { path: added.path, branch: added.branch };
      } catch (error) {
        // Resume tolerance: the worktree/branch from a killed run is
        // reused — never rebuilt over, never silently dropped.
        if (isWorktreeError(error) && error.code === 'already_exists') {
          return {
            path: pathForAgent(repo, agentId),
            branch: branchForAgent(agentId),
          };
        }
        throw error;
      }
    },
    runWorker: async (
      agentId: string,
      worktree: OrchestrateWorktree,
      prompt: string,
      info?: { sessionId: string },
    ): Promise<MergedHunk[]> => {
      const repo = needRoot();
      void repo;
      const workerSession = `${info?.sessionId ?? 'orch'}-${agentId}`;
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
        const parsed = JSON.parse(raw) as OrchestratorRunState;
        if (parsed.version !== 1 || parsed.sessionId !== sessionId)
          return undefined;
        return parsed;
      } catch {
        return undefined;
      }
    },
    saveState: (state: OrchestratorRunState): void => {
      try {
        const repo = needRoot();
        const bridge = createNodeFileBridge(
          join(repo, '.kubic', 'orchestrator'),
        );
        bridge.writeFile(
          storeName(state.sessionId),
          JSON.stringify(state, null, 2),
        );
      } catch (error) {
        debug(
          `state: save failed for session '${state.sessionId}': ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  };
}
