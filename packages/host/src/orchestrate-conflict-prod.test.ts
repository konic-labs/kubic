// Prod-path measurement of #106 (issue #106; §45.2, §44.1) — real git, real
// child processes, no fakes.
//
// The unit tests pin the CLI's contract with fakes; this file measures the
// thing those tests cannot see: the composition root's resolver seam spawns a
// REAL child that settles a REAL merge conflict on a REAL worktree, and the
// retained-worktree status is read by the REAL `git status` reader. Two real
// workers are made to edit the same line of the same file so the second merge
// genuinely conflicts; the resolver fixture then resolves it by taking the
// merge target's version and committing on the worker branch — a resolution a
// real agent could pick — and the manager re-merges.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { orchestrateDepsWithDefaults } from '../../../apps/kubic/src/orchestrate-run.js';
import {
  createGitSandbox,
  disposeAllGitSandboxes,
  type GitSandbox,
} from '../../exec/src/test-support/git-sandbox.js';
import {
  runOrchestrateCommand,
  workerApprovalBoundMs,
} from './orchestrate-cli.js';
import type { ApprovalSnapshot } from './orchestrator/merge/conflicts.js';
import { hashApprovalPolicy } from './orchestrator/merge/conflicts.js';

// The worker child contract: announce readiness, write the line it was told
// to write into shared.txt (the file both workers touch, so their merges
// conflict), then exit. DIRECTIVE=<text> drives the content and TOUCH=<path>
// an extra untracked file the worker leaves behind.
const WORKER_FIXTURE = `
import { writeFileSync } from 'node:fs';
const argv = process.argv.slice(2);
const index = argv.indexOf('-p');
const prompt = index === -1 ? '' : (argv[index + 1] ?? '');
const touch = /TOUCH=(\\S+)/.exec(prompt)?.[1];
// The WORKER's own id decides the line it writes. Two workers therefore
// change the SAME line of the SAME file to DIFFERENT content, which is what
// makes the second merge a genuine conflict — identical content on both
// branches would merge cleanly and prove nothing.
writeFileSync('shared.txt', 'shared\\nline-by-' + (process.env.KUBIC_WORKER_ID ?? 'worker') + '\\n');
if (touch !== undefined) writeFileSync(touch, 'left by the worker\\n');
process.stdout.write('KUBIC_WORKER_READY ' + (process.env.KUBIC_WORKER_ID ?? '') + '\\n');
if (0 === 0) { const a = process.argv; process.stdout.write(JSON.stringify({ ok: true, exitCode: 0, sessionId: a[a.indexOf('--session') + 1], status: 'completed', result: { summary: 'fixture done' } }) + String.fromCharCode(10)); }
process.exit(0);
`;

// Resolver-child fixtures that spawn git live in
// ./orchestrate-conflict-fixtures.ts (issue #420): they run in spawned
// children, scrub their own git view, and must not sit in this .test.ts
// file, which the git-sandbox gate scans per line.

// The resolver child that FAILS: announces readiness, then exits non-zero —
// the run must keep the pre-#106 terminus and stop the queue.
const RESOLVER_FAIL = `
process.stdout.write('KUBIC_WORKER_READY ' + (process.env.KUBIC_WORKER_ID ?? '') + '\\n');
process.exit(6);
`;

import {
  RESOLVER_DUMPS_ENV,
  RESOLVER_SETTLE,
} from '../../exec/src/test-support/orchestrate-conflict-fixtures.js';

const POLICY: ApprovalSnapshot = {
  route: 'ask-user',
  autoApprove: [],
  maxPendingMs: 60_000,
};

// Every scratch dir (repo, sessions, fixtures) is removed after each test —
// the worktrees live under the repo root, so removing it disposes them too.
const scratchDirs: string[] = [];

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

afterEach(() => {
  driver = undefined;
  disposeAllGitSandboxes();
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The test's git driver (issue #420). Set by initRepo.
let driver: GitSandbox | undefined;

function gitIn(cwd: string, args: string[]): string {
  if (driver === undefined) throw new Error('gitIn() needs initRepo() first');
  return driver.git(args, { cwd });
}

async function initRepo(): Promise<string> {
  // Injected: the run commits, merges and spawns resolver children through
  // production git on the inherited environment.
  const sandbox = createGitSandbox({ injectProcessEnv: true });
  driver = sandbox;
  const root = sandbox.path;
  writeFileSync(join(root, 'shared.txt'), 'shared\nbase\n');
  sandbox.git(['add', 'shared.txt']);
  sandbox.git(['commit', '-m', 'base']);
  return root;
}

interface Harness {
  root: string;
  sessionsRoot: string;
  lines: string[];
  debugLines: string[];
  deps: Awaited<ReturnType<typeof orchestrateDepsWithDefaults>>;
}

async function harness(
  resolverBody: string,
  options: { approvalPolicy?: ApprovalSnapshot } = {},
): Promise<Harness> {
  const root = realpathSync(await initRepo());
  const sessionsRoot = scratch('kubic-orch-106-sessions-');
  const dir = scratch('kubic-orch-106-child-');
  const workerFixture = join(dir, 'worker-child.mjs');
  const resolverFixture = join(dir, 'resolver-child.mjs');
  writeFileSync(workerFixture, WORKER_FIXTURE);
  // The FIXTURE BODY, not the path to it: writing the path here would make
  // the child a file whose whole content is a string literal — a syntax
  // error, which is what a first run of this test measured.
  writeFileSync(resolverFixture, resolverBody);
  const lines: string[] = [];
  const debugLines: string[] = [];
  const deps = await orchestrateDepsWithDefaults({
    out: (line) => lines.push(line),
    err: (line) => lines.push(line),
    debug: (line) => debugLines.push(line),
    cwd: root,
    sessionsRoot,
    workerEntry: { cmd: process.execPath, args: [workerFixture] },
    // The resolver is reached through the same entry shape; the composition
    // root's runResolver builds the argv, so the fixture file is what differs.
    resolverEntry: { cmd: process.execPath, args: [resolverFixture] },
    approvalPolicy: options.approvalPolicy ?? POLICY,
  });
  return { root, sessionsRoot, lines, debugLines, deps };
}

describe('prod orchestrate path: conflict delegation (issue #106, §45.2)', () => {
  it('settles a genuine conflict through a real resolver child', async () => {
    const h = await harness(RESOLVER_SETTLE);
    // The resolver's prompt is built from the SPEC (both diffs, the
    // constraints, the conflicted files) — not from the manager's `-p` text,
    // which is why the fixture parses nothing and the assertions below read
    // what the run actually handed it.
    const code = await runOrchestrateCommand(
      {
        prompt: 'edit shared.txt in every worktree',
        agents: ['alpha', 'beta'],
        session: 'iss106',
        yes: true,
        // §67 task resources (issue #170): the resolver gets the run's
        // skills, like every worker (L-D9).
        skills: ['./skills/house.md'],
      },
      h.deps,
    );
    expect(code).toBe(0);
    // The conflict really happened: two branches changed the same line.
    const log = gitIn(h.root, ['log', '--format=%s', '--merges']);
    expect(log).toContain('kubic: merge alpha');
    expect(log).toContain('kubic: merge beta');
    // …and the resolution was performed by the spawned resolver, whose prompt
    // it wrote into its worktree before committing.
    const resolverWorktree = realpathSync(
      join(h.root, '.kubic', 'wt', 'iss106', 'beta'),
    );
    const resolverPrompt = readFileSync(
      join(resolverWorktree, 'resolver-prompt.txt'),
      'utf8',
    );
    expect(resolverPrompt).toContain(
      'Resolve the merge conflict left by worker',
    );
    expect(resolverPrompt).toContain('Constraint:');
    // Both diffs travel: the spec's diff parsing found the real conflicted
    // file in each side's changes since the merge base.
    expect(resolverPrompt).toContain('shared.txt');
    expect(resolverPrompt).not.toContain('(no file headers in either diff)');
    // §67 (issue #191): the resolver gets an explicit task too — the spec's
    // writer tool set travels as `task.toolNames`, so a worktree without the
    // role document no longer drops it onto a default lane.
    const taskFile = readFileSync(
      join(resolverWorktree, 'resolver-task-file.txt'),
      'utf8',
    );
    expect(taskFile).not.toBe('(none)');
    const resolverTask = JSON.parse(readFileSync(taskFile, 'utf8')) as {
      role: string;
      toolNames: string[];
      workspaceMode: string;
    };
    expect(resolverTask.role).toBe('implementer');
    expect(resolverTask.workspaceMode).toBe('worktree');
    expect(resolverTask.toolNames).toContain('write');
    expect(resolverTask.toolNames).toContain('edit');
    // The resolver is granted the run's skills, resolved against the
    // manager's cwd (its own worktree would resolve the relative path
    // elsewhere).
    expect(
      (resolverTask as { resources?: { skills?: string[] } }).resources,
    ).toEqual({ skills: [join(h.root, 'skills', 'house.md')] });
    // The merge target ends up with the resolver's settlement.
    // main holds alpha's line: the resolver took the merge target's version,
    // so the settling content is alpha's, and the merge is clean afterwards.
    expect(readFileSync(join(h.root, 'shared.txt'), 'utf8')).toBe(
      'shared\nline-by-alpha\n',
    );
  });

  it('stops the queue exactly as today when the real resolver fails', async () => {
    const h = await harness(RESOLVER_FAIL);
    const code = await runOrchestrateCommand(
      {
        prompt: 'edit shared.txt in every worktree',
        agents: ['alpha', 'beta'],
        session: 'iss106',
        yes: true,
      },
      h.deps,
    );
    expect(code).toBe(1);
    expect(h.lines.join('\n')).toMatch(/code=merge_conflict/);
    // beta never merged; alpha did (FIFO, alpha first). A stopped queue emits
    // no success lines at all, so the merge log is the evidence.
    const log = gitIn(h.root, ['log', '--format=%s', '--merges']);
    expect(log).toContain('kubic: merge alpha');
    expect(log).not.toContain('kubic: merge beta');
    // The terminus names WHY nothing settled it — a delegation attempt is
    // never indistinguishable from no attempt.
    expect(h.lines.join('\n')).toMatch(/resolver: resolver child exited/);
  });

  it('never delegates without the manager snapshot', async () => {
    const h = await harness(RESOLVER_SETTLE);
    const depsWithout = { ...h.deps };
    depsWithout.approvalPolicy = undefined;
    const code = await runOrchestrateCommand(
      {
        prompt: 'edit shared.txt',
        agents: ['alpha', 'beta'],
        session: 'iss106',
        yes: true,
      },
      depsWithout,
    );
    expect(code).toBe(1);
    expect(h.lines.join('\n')).toMatch(/code=merge_conflict/);
    expect(h.lines.join('\n')).toMatch(/approval snapshot/);
    // Never delegated: the resolver child, which writes its prompt first
    // thing, was never spawned in the conflicted worktree.
    expect(
      existsSync(
        join(h.root, '.kubic', 'wt', 'iss106', 'beta', 'resolver-prompt.txt'),
      ),
    ).toBe(false);
    expect(h.lines.join('\n')).not.toMatch(/resolver: resolver child exited/);
  });

  it('launches the real resolver child with the run approval surface (issue #156)', async () => {
    const h = await harness(RESOLVER_DUMPS_ENV);
    // A committed role document for the spec's role (§45.2): the manager then
    // passes `--role implementer` (and the resolver's own lane would resolve
    // the document from its worktree), so the dump below pins the role the
    // resolver was actually told it runs as.
    mkdirSync(join(h.root, '.kubic', 'roles'), { recursive: true });
    // Both documents the built-in preset assigns (§12.1): the role plan
    // refuses a run whose worker would get a role with no document, and the
    // resolver's spec role is the implementer set.
    for (const [name, tools, prompt] of [
      ['planner', '[read, ls, find, grep]', 'Produce ordered steps.'],
      [
        'implementer',
        '[read, ls, find, grep, write, edit, bash]',
        'Settle conflicts in your worktree.',
      ],
    ] as const) {
      writeFileSync(
        join(h.root, '.kubic', 'roles', `${name}.md`),
        `---\nrole: ${name}\n\ntools: ${tools}\nfilesystem: workspace-write\nshell: true\nnetwork: none\ngit: false\ncredentials: none\n---\n\n# ${name}\n\n## Prompt\n\n${prompt}\n`,
      );
    }
    gitIn(h.root, ['add', '-A']);
    gitIn(h.root, ['commit', '-m', 'add some roles']);
    const code = await runOrchestrateCommand(
      {
        prompt: 'edit shared.txt in every worktree',
        agents: ['alpha', 'beta'],
        session: 'iss156',
        yes: true,
      },
      h.deps,
    );
    expect(code, h.lines.join('\n')).toBe(0);
    const dump = JSON.parse(
      readFileSync(
        join(
          realpathSync(join(h.root, '.kubic', 'wt', 'iss156', 'beta')),
          'resolver-approvals-env.json',
        ),
        'utf8',
      ),
    ) as Record<string, string | null>;
    // The mailbox the run's own approvals layer answers for — outside the
    // repo, under the user home, for THIS run's session (issues #149, #156).
    expect(dump.approvalsDir).toContain(join('iss156'));
    expect(dump.approvalsDir?.startsWith(h.root)).toBe(false);
    expect(dump.verifyKey).toBeTruthy();
    // …and the resolver is treated as a delegated child: its own session, the
    // run as parent, its spec role, and the child's bound below the manager's
    // (issues #156, #159, #230).
    expect(dump.orchestratorSession).toBe('iss156');
    expect(dump.workerSession).toBe('iss156-beta');
    expect(dump.workerId).toBe('beta');
    expect(dump.role).toBe('implementer');
    expect(dump.boundMs).toBe(
      String(workerApprovalBoundMs(POLICY.maxPendingMs)),
    );
  });

  it('reads real retained-worktree dirtiness and names the files', async () => {
    const h = await harness(RESOLVER_SETTLE);
    // Two clean workers retain clean worktrees; then dirty ONE of them for
    // real, and read the status through the composition root's own seam.
    const code = await runOrchestrateCommand(
      {
        prompt: 'edit shared.txt in this worktree',
        agents: ['alpha'],
        session: 'iss106',
        yes: true,
      },
      h.deps,
    );
    expect(code).toBe(0);
    expect(
      h.lines,
      `lines were:\n${h.lines.join('\n')}\ndebug:\n${h.debugLines.join('\n')}`,
    ).toContain(
      `retained: alpha branch=kubic/iss106/alpha worktree=${join(h.root, '.kubic', 'wt', 'iss106', 'alpha')} clean=true`,
    );
    const dirtyWorktree = realpathSync(
      join(h.root, '.kubic', 'wt', 'iss106', 'alpha'),
    );
    // A modification of a TRACKED file is what `unstaged` means; a brand-new
    // file is `untracked`. Getting this backwards would make the assertion
    // pass for the wrong reason.
    writeFileSync(
      join(dirtyWorktree, 'shared.txt'),
      'shared\nline-by-alpha\nplus a hand edit\n',
    );
    writeFileSync(join(dirtyWorktree, 'untracked.txt'), 'never staged\n');
    const status = await h.deps.worktreeStatus?.(dirtyWorktree, {
      sessionId: 'iss106',
      agentId: 'alpha',
    });
    expect(status?.clean).toBe(false);
    expect(status?.untracked).toContain('untracked.txt');
    expect(status?.unstaged).toContain('shared.txt');
    expect(status?.untracked).not.toContain('shared.txt');
    // The worktree is still on disk with its branch: retaining is the rule,
    // and `kubic clean` (pinned by clean-docs.test.ts) is the only disposer.
    expect(gitIn(dirtyWorktree, ['branch', '--show-current']).trim()).toBe(
      'kubic/iss106/alpha',
    );
  });

  it('carries a manager snapshot whose hash the spec re-checks', async () => {
    // The snapshot the composition root threads in is the one the CLI hands
    // the spec builder; the hash it derives must round-trip, which is what
    // makes the spec's self-consistency check meaningful rather than theatre.
    const h = await harness(RESOLVER_SETTLE);
    expect(h.deps.approvalPolicy).toEqual(POLICY);
    expect(hashApprovalPolicy(h.deps.approvalPolicy as ApprovalSnapshot)).toBe(
      hashApprovalPolicy({ ...POLICY }),
    );
    // …and the hash is not a constant: a changed snapshot no longer matches,
    // so the re-check can actually refuse a drifted policy.
    expect(hashApprovalPolicy({ ...POLICY, maxPendingMs: 1 })).not.toBe(
      hashApprovalPolicy(POLICY),
    );
    expect(hashApprovalPolicy({ ...POLICY, route: 'auto' })).not.toBe(
      hashApprovalPolicy(POLICY),
    );
  });
});
