// Prod `kubic orchestrate` path (issue #85): drives the composition-root
// adapter (apps/kubic) against real git, no provider needed — every case
// here fails (or settles) before a model call. Reaches across to the
// adapter purely as a black-box caller, never into its internals.
// Regression pins for the two prod-only defects the fake-`runWorker`
// contract tests could not see:
//   1. the worker session must be created with cwd = the WORKER WORKTREE,
//      so worker journals/sessions land with the worker, never in the
//      parent repo;
//   2. a surviving worker branch with no worktree directory must fail with
//      a named §78 code, never a raw `spawn … ENOENT` crash.
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { orchestrateDepsWithDefaults } from '../../../apps/kubic/src/orchestrate-run.js';
import type { Provenance } from '../../exec/src/env.js';
import { NodeExecutionEnv } from '../../exec/src/env.js';
import { createNodeFileBridge } from '../../exec/src/file-bridge.js';
import {
  attachSession,
  createSession,
  openSessionStore,
  SessionAttachError,
} from '../../worker/src/lane/session-store.js';
import { BACKGROUND_CONTEXT } from '../../worker/src/pi-boundary.js';
import { runOrchestrateCommand } from './orchestrate-cli.js';
import { addWorktree } from './orchestrator/worktree/add.js';
import type { WorktreeError } from './orchestrator/worktree/errors.js';

const PROVENANCE: Provenance = {
  sessionId: 'prodsess',
  agentId: 'manager',
  toolCallId: 'prod-path-test',
  turnId: 0,
  operation: 'orchestrate_prod_path',
};

function scratchRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

async function gitIn(
  cwd: string,
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const env = new NodeExecutionEnv(cwd);
  return env.shell.spawn('git', args, { provenance: PROVENANCE }).wait();
}

async function gitOrThrow(cwd: string, args: string[]): Promise<string> {
  const done = await gitIn(cwd, args);
  if (done.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${done.stderr}`);
  }
  return done.stdout;
}

async function initRepo(): Promise<string> {
  const root = scratchRoot('kubic-orch-prod-');
  await gitOrThrow(root, ['init', '-b', 'main']);
  await gitOrThrow(root, ['config', 'user.email', 'prod@kubic.dev']);
  await gitOrThrow(root, ['config', 'user.name', 'kubic prod']);
  await gitOrThrow(root, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(root, 'base.txt'), 'base\n');
  await gitOrThrow(root, ['add', 'base.txt']);
  await gitOrThrow(root, ['commit', '-m', 'base']);
  return root;
}

describe('prod orchestrate path: worker session creation (issue #85)', () => {
  it('creates the worker session with the worktree cwd so the child can attach', async () => {
    const root = await initRepo();
    const sessionsRoot = scratchRoot('kubic-orch-sessions-');
    const env = new NodeExecutionEnv(root);
    const added = await addWorktree(env, root, 'worker-1', {
      sessionId: 'prodsess',
    });
    const deps = await orchestrateDepsWithDefaults({
      out: () => undefined,
      cwd: root,
      sessionsRoot,
    });

    // The hook is what the CLI calls before spawning the child; the child
    // then runs `kubic run --session <id>` from inside the worktree, which
    // only ATTACHES.
    const created = await deps.createWorkerSession?.({
      sessionId: 'prodsess',
      agentId: 'worker-1',
      workerSessionId: 'prodsess-worker-1',
      worktree: { path: added.path, branch: added.branch },
    });
    expect(created?.sessionId).toBe('prodsess-worker-1');

    const store = openSessionStore(
      sessionsRoot,
      createNodeFileBridge(sessionsRoot),
    );
    const attached = await attachSession(
      store,
      'prodsess-worker-1',
      BACKGROUND_CONTEXT,
    );
    try {
      // AC5: the session's cwd is the WORKER's worktree — worker journals
      // and session state land with the worker, not the parent repo.
      expect(attached.metadata.cwd).toBe(added.path);
      expect(attached.metadata.cwd).not.toBe(root);
    } finally {
      await attached.close(BACKGROUND_CONTEXT);
    }
    // The session lives under the sessions root, nowhere near the repo.
    const dirs = createNodeFileBridge(sessionsRoot).listDir('.');
    const names = dirs.map((entry) => entry.name).join('\n');
    expect(names).toContain(
      added.path.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-'),
    );
  });

  it('is idempotent on resume: an existing worker session is reused, not recreated', async () => {
    const root = await initRepo();
    const sessionsRoot = scratchRoot('kubic-orch-sessions-');
    const env = new NodeExecutionEnv(root);
    const added = await addWorktree(env, root, 'worker-1', {
      sessionId: 'prodsess',
    });
    const deps = await orchestrateDepsWithDefaults({
      out: () => undefined,
      cwd: root,
      sessionsRoot,
    });
    const request = {
      sessionId: 'prodsess',
      agentId: 'worker-1',
      workerSessionId: 'prodsess-worker-1',
      worktree: { path: added.path, branch: added.branch },
    };
    const first = await deps.createWorkerSession?.(request);
    expect(first?.sessionId).toBe('prodsess-worker-1');
    // A killed run left the session on disk; --resume retries the worker
    // and must re-attach that same session (one chain), never fail with
    // "Session already exists".
    const second = await deps.createWorkerSession?.(request);
    expect(second?.sessionId).toBe('prodsess-worker-1');
    const store = openSessionStore(
      sessionsRoot,
      createNodeFileBridge(sessionsRoot),
    );
    const attached = await attachSession(
      store,
      'prodsess-worker-1',
      BACKGROUND_CONTEXT,
    );
    try {
      expect(attached.metadata.cwd).toBe(added.path);
    } finally {
      await attached.close(BACKGROUND_CONTEXT);
    }
  });
  it('refuses a surviving worker session pinned to a different cwd', async () => {
    const root = await initRepo();
    const other = await initRepo();
    const sessionsRoot = scratchRoot('kubic-orch-sessions-');
    const env = new NodeExecutionEnv(root);
    const added = await addWorktree(env, root, 'worker-1', {
      sessionId: 'prodsess',
    });
    const deps = await orchestrateDepsWithDefaults({
      out: () => undefined,
      cwd: root,
      sessionsRoot,
    });
    // A session under this id that belongs to some OTHER cwd: reusing it
    // would journal the worker's effects outside its worktree, so the
    // create step must fail closed instead.
    const store = openSessionStore(
      sessionsRoot,
      createNodeFileBridge(sessionsRoot),
    );
    const stray = await createSession(
      store,
      other,
      BACKGROUND_CONTEXT,
      'prodsess-worker-1',
    );
    await stray.close(BACKGROUND_CONTEXT);
    const error = await Promise.resolve(
      deps.createWorkerSession?.({
        sessionId: 'prodsess',
        agentId: 'worker-1',
        workerSessionId: 'prodsess-worker-1',
        worktree: { path: added.path, branch: added.branch },
      }) ?? undefined,
    ).catch((e: unknown) => e as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/belongs to/);
    expect((error as Error).message).toMatch(/worktree/);
  });
});

describe('prod orchestrate path: stale branch without a worktree (issue #85)', () => {
  it('fails closed with spawn_failed and no raw ENOENT when the worktree is gone', async () => {
    const root = await initRepo();
    const sessionsRoot = scratchRoot('kubic-orch-sessions-');
    // The branch survives, the worktree directory does not — the shape a
    // `rm -rf .kubic && git worktree prune` leaves behind.
    await gitOrThrow(root, ['branch', 'kubic/worker-1']);
    const lines: string[] = [];
    const deps = await orchestrateDepsWithDefaults({
      out: (line) => lines.push(line),
      cwd: root,
      sessionsRoot,
    });
    const code = await runOrchestrateCommand(
      [
        '-p',
        'say hi',
        '--agents',
        'worker-1',
        '--yes',
        '--session',
        'prodsess',
      ],
      deps,
    );
    const text = lines.join('\n');
    expect(code).toBe(1);
    expect(text).toMatch(/code=spawn_failed/);
    // A raw ENOENT crash (unhandled 'error' event, stack trace, no §78
    // code) is exactly what this pins against.
    expect(text).not.toMatch(/ENOENT/);
    expect(text).not.toMatch(/node:events/);
    expect(text).toMatch(/worktree/i);
  });

  it('accepts the surviving worktree on resume instead of failing', async () => {
    const root = await initRepo();
    const sessionsRoot = scratchRoot('kubic-orch-sessions-');
    const env = new NodeExecutionEnv(root);
    const added = await addWorktree(env, root, 'worker-1', {
      sessionId: 'prodsess',
    });
    // Same call again: addWorktree refuses (`already_exists`) and the
    // resume tolerance must hand back the live worktree. No provider is
    // configured, so the run still stops — but at the provider boundary,
    // never at a phantom worktree.
    const deps = await orchestrateDepsWithDefaults({
      out: () => undefined,
      cwd: root,
      sessionsRoot,
    });
    const worktree = await deps.ensureWorktree('worker-1');
    // macOS: /var is a symlink to /private/var and git reports the resolved
    // toplevel, so compare resolved paths — the worktree is the same one.
    expect(realpathSync(worktree.path)).toBe(realpathSync(added.path));
    expect(worktree.branch).toBe('kubic/worker-1');
  });

  it('names the missing worktree with its own worktree error code', async () => {
    const root = await initRepo();
    const sessionsRoot = scratchRoot('kubic-orch-sessions-');
    await gitOrThrow(root, ['branch', 'kubic/worker-1']);
    const deps = await orchestrateDepsWithDefaults({
      out: () => undefined,
      cwd: root,
      sessionsRoot,
    });
    const error = (await Promise.resolve(deps.ensureWorktree('worker-1')).catch(
      (e: unknown) => e,
    )) as WorktreeError;
    expect(error.code).toBe('worktree_missing');
    expect(error.exitCode).toBe(1);
    expect(error.message).toMatch(/worktree/i);
    expect(error.message).toMatch(/kubic\/worker-1/);
  });
});

describe('prod orchestrate path: kubic state never dirties the tree (issue #85)', () => {
  it('keeps .kubic runtime state invisible to git status in a repo with no ignore entry', async () => {
    const root = await initRepo();
    const sessionsRoot = scratchRoot('kubic-orch-sessions-');
    const deps = await orchestrateDepsWithDefaults({
      out: () => undefined,
      cwd: root,
      sessionsRoot,
    });
    // `.kubic/wt/<agent>` and `.kubic/orchestrator/<session>.json` are the
    // orchestrator's own state; §35 has them gitignored. Without that, the
    // pre-merge guard refuses every merge in a fresh scratch repo
    // (`?? .kubic/`) and no run can ever settle.
    await deps.ensureWorktree('worker-1');
    const env = new NodeExecutionEnv(root);
    // The rules land in the repo-local exclude file (issue #91's single
    // source of truth), NOT in a `.kubic/.gitignore` that would ignore the
    // committable roles/config alongside the runtime state.
    env.fs.writeFile(join('.kubic', 'orchestrator', 'state.json'), '{}');
    const status = await gitOrThrow(root, ['status', '--porcelain=v1']);
    expect(status.trim()).toBe('');
    // The ignore must cover runtime state only — roles and config stay
    // addable (issue #91 criterion 2). Ordering is load-bearing: `git add
    // --dry-run` exits 0 only because the file exists (verified — with the
    // path absent it exits 128 'pathspec did not match any files'), so the
    // assertion cannot silently degrade into a no-op.
    env.fs.writeFile(join('.kubic', 'roles', 'planner.md'), '# planner');
    const added = await gitOrThrow(root, [
      'add',
      '--dry-run',
      '.kubic/roles/planner.md',
    ]);
    expect(added).toContain('planner.md');
  });

  it('reports a skipped exclude write on the debug channel instead of swallowing it', async () => {
    // A repo whose exclude FILE refuses the write (read-only): the setup pass
    // is best-effort BY DESIGN and must stay that way, but a skipped write is
    // otherwise indistinguishable from a successful one, so the outcome must
    // reach the debug channel (issue #85 review, diagnosability).
    // `.git/info/exclude` exists from `git init`, so the file's own mode
    // governs — a read-only `.git` directory alone does not block the write.
    const root = await initRepo();
    const sessionsRoot = scratchRoot('kubic-orch-sessions-');
    const excludeFile = join(root, '.git', 'info', 'exclude');
    chmodSync(excludeFile, 0o444);
    try {
      const lines: string[] = [];
      await orchestrateDepsWithDefaults({
        out: () => undefined,
        debug: (line) => lines.push(line),
        cwd: root,
        sessionsRoot,
      });
      expect(
        lines.some((l) => l.includes('state ignore') && l.includes('skipped')),
      ).toBe(true);
    } finally {
      chmodSync(excludeFile, 0o644);
    }
  });

  it('defers to the shared exclude file and never writes a .kubic/.gitignore', async () => {
    const root = await initRepo();
    const sessionsRoot = scratchRoot('kubic-orch-sessions-');
    const env = new NodeExecutionEnv(root);
    // A hand-tuned `.kubic/.gitignore` from an older run must stand untouched,
    // and the orchestrator must not create one.
    env.fs.writeFile(join('.kubic', '.gitignore'), 'wt/\n');
    await orchestrateDepsWithDefaults({
      out: () => undefined,
      cwd: root,
      sessionsRoot,
    });
    expect(env.fs.readFile(join('.kubic', '.gitignore'))).toBe('wt/\n');
  });

  it('a user-authored `*` .kubic/.gitignore still keeps the tree clean for the guard', async () => {
    // Measured, not assumed (review of #85 raised the opposite): a USER-authored
    // `.kubic/.gitignore` holding `*` does not re-break the pre-merge clean-tree
    // guard — `*` covers the runtime state too, so `git status` stays empty and
    // the merge can settle. What it does break is role/config addability, which
    // is the user's own choice of rule, so the orchestrator leaves the file
    // alone (pinned by the test above) and keeps its own rules in the exclude
    // file. This test exists so the failure mode cannot silently drift.
    const root = await initRepo();
    const sessionsRoot = scratchRoot('kubic-orch-sessions-');
    const env = new NodeExecutionEnv(root);
    env.fs.writeFile(join('.kubic', '.gitignore'), '*\n');
    const deps = await orchestrateDepsWithDefaults({
      out: () => undefined,
      cwd: root,
      sessionsRoot,
    });
    await deps.ensureWorktree('worker-1');
    env.fs.writeFile(join('.kubic', 'orchestrator', 'state.json'), '{}');
    const status = await gitOrThrow(root, ['status', '--porcelain=v1']);
    expect(status.trim()).toBe('');
    // The exclude file still carries the rules (the mechanism is not skipped
    // just because a .gitignore exists).
    const exclude = readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude).toContain('.kubic/orchestrator/');
  });

  it('leaves the repo .gitignore and unrelated untracked files alone', async () => {
    const root = await initRepo();
    const sessionsRoot = scratchRoot('kubic-orch-sessions-');
    writeFileSync(join(root, '.gitignore'), 'node_modules/\n');
    await gitOrThrow(root, ['add', '.gitignore']);
    await gitOrThrow(root, ['commit', '-m', 'ignore node_modules']);
    writeFileSync(join(root, 'keep.txt'), 'keep\n');
    const deps = await orchestrateDepsWithDefaults({
      out: () => undefined,
      cwd: root,
      sessionsRoot,
    });
    await deps.ensureWorktree('worker-1');
    // The repo's own .gitignore is untouched, and the only untracked entry
    // is the user's own file — `.kubic/` is invisible.
    expect(new NodeExecutionEnv(root).fs.readFile('.gitignore')).toBe(
      'node_modules/\n',
    );
    const status = await gitOrThrow(root, ['status', '--porcelain=v1']);
    expect(status.trim()).toBe('?? keep.txt');
  });
});

describe('prod orchestrate path: the child that cannot attach (issue #85)', () => {
  it('attaches an unknown worker session as exit 5, proving creation is required', async () => {
    // The defect in one assertion: `kubic run --session <ghost>` refuses.
    // Nothing but the create step in the composition root can change that.
    const sessionsRoot = scratchRoot('kubic-orch-ghost-');
    const store = openSessionStore(
      sessionsRoot,
      createNodeFileBridge(sessionsRoot),
    );
    const error = await attachSession(
      store,
      'ghost-worker-1',
      BACKGROUND_CONTEXT,
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SessionAttachError);
    expect((error as Error).message).toMatch(/unknown session/);
  });

  it('keeps the worker worktree free of the parent repo session store', async () => {
    const root = await initRepo();
    const sessionsRoot = scratchRoot('kubic-orch-sessions-');
    const env = new NodeExecutionEnv(root);
    const added = await addWorktree(env, root, 'worker-1', {
      sessionId: 'prodsess',
    });
    const deps = await orchestrateDepsWithDefaults({
      out: () => undefined,
      cwd: root,
      sessionsRoot,
    });
    await deps.createWorkerSession?.({
      sessionId: 'prodsess',
      agentId: 'worker-1',
      workerSessionId: 'prodsess-worker-1',
      worktree: { path: added.path, branch: added.branch },
    });
    // Nothing session-shaped is written into the parent repo's .kubic dir
    // beyond the orchestrator state file the CLI owns.
    const repoKubic = join(root, '.kubic');
    expect(existsSync(join(repoKubic, 'sessions'))).toBe(false);
    const header = readFileSync(
      join(
        sessionDirName(sessionsRoot, added.path),
        findJsonl(sessionsRoot, added.path),
      ),
      'utf8',
    )
      .split('\n')[0]
      ?.trim() as string;
    expect(JSON.parse(header)).toMatchObject({
      id: 'prodsess-worker-1',
      cwd: added.path,
    });
  });
});

// Pi's JsonlSessionRepo encodes the session cwd into the directory name
// (`--<cwd with / and : replaced>--`); tests must reach the same store the
// composition root wrote to, so they derive it the same way.
function sessionDirName(sessionsRoot: string, worktreePath: string): string {
  const encoded = worktreePath.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-');
  return join(sessionsRoot, `--${encoded}--`);
}

function findJsonl(sessionsRoot: string, worktreePath: string): string {
  const dir = sessionDirName(sessionsRoot, worktreePath);
  const entries = createNodeFileBridge(dir).listDir('.');
  const file = entries.find((entry) => entry.name.endsWith('.jsonl'));
  if (file === undefined) throw new Error(`no session file under ${dir}`);
  return file.name;
}
