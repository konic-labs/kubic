// Role-driven worker prompts on the PROD orchestrate path (issue #104;
// §12/§12.1, §40, §71). Drives the real composition-root adapter against
// real git and a REAL child process: the child fixture dumps the prompt it
// received and its own environment, so the claims are read from the child's
// view — not from the spawn call the test could have gotten wrong. Two
// assertions matter here:
//   1. two workers with different roles receive different composed prompts
//      (role `## Prompt` text + that worker's plan step), and
//   2. the child `kubic run` is told which role it runs as, so its own lane
//      registers the role's resolved tool set (§40: absence withholds) —
//      plus the role's model default via the EXISTING `KUBIC_MODEL` pin.
// No provider is dialled: the fixture child never reaches a model.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { orchestrateDepsWithDefaults } from '../../../apps/kubic/src/orchestrate-run.js';
import type { Provenance } from '../../exec/src/env.js';
import { NodeExecutionEnv } from '../../exec/src/env.js';
import { WorkerRegistry } from '../../worker/src/lifecycle/registry.js';
import { runOrchestrateCommand } from './orchestrate-cli.js';

const PROVENANCE: Provenance = {
  sessionId: 'roles-prod',
  agentId: 'manager',
  toolCallId: 'issue-104',
  turnId: 0,
  operation: 'orchestrate_roles_prod',
};

// The child contract as a real process: write the prompt it was given and
// its own environment under its worker id, announce readiness, exit 0.
const FIXTURE = `
import { writeFileSync } from 'node:fs';
const argv = process.argv.slice(2);
const index = argv.indexOf('-p');
const prompt = index === -1 ? '' : (argv[index + 1] ?? '');
const roleIndex = argv.indexOf('--role');
const role = roleIndex === -1 ? '(none)' : (argv[roleIndex + 1] ?? '');
const dumpDir = /PROMPTDUMPDIR=(\\S+)/.exec(prompt);
if (dumpDir !== null) {
  const id = process.env.KUBIC_WORKER_ID ?? 'worker';
  writeFileSync(dumpDir[1] + '/' + id + '.prompt.txt', prompt);
  writeFileSync(dumpDir[1] + '/' + id + '.role.txt', role);
  writeFileSync(dumpDir[1] + '/' + id + '.model.txt', process.env.KUBIC_MODEL ?? '(none)');
}
process.stdout.write('KUBIC_WORKER_READY ' + (process.env.KUBIC_WORKER_ID ?? '') + '\\n');
if (0 === 0) { const a = process.argv; process.stdout.write(JSON.stringify({ ok: true, exitCode: 0, sessionId: a[a.indexOf('--session') + 1], status: 'completed', result: { summary: 'fixture done' } }) + String.fromCharCode(10)); }
process.exit(0);
`;

// Every scratch dir is removed after each test (worktrees live under the repo
// root, so removing it disposes them too) — nothing accumulates in tmpdir.
const scratchDirs: string[] = [];

function scratchRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

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

function roleText(name: string, frontmatter: string, prompt: string): string {
  return `---\nrole: ${name}\n${frontmatter}---\n\n# ${name}\n\n## Prompt\n\n${prompt}\n`;
}

const PLANNER_FM =
  'tools: [read, ls, find, grep]\nfilesystem: read\nshell: false\nnetwork: none\ngit: false\ncredentials: none\n';
const IMPLEMENTER_FM =
  'tools: [read, ls, find, grep, write, edit, bash]\nfilesystem: workspace-write\nshell: true\nnetwork: none\ngit: false\ncredentials: none\n';

// A repo with the two role documents COMMITTED, the way `.kubic/roles/*.md`
// live in the real project: the worker's worktree is a checkout of this
// branch, so the child `kubic run --role <name>` finds its own document.
async function initRepoWithRoles(): Promise<string> {
  const root = scratchRoot('kubic-orch-roles-');
  await gitOrThrow(root, ['init', '-b', 'main']);
  await gitOrThrow(root, ['config', 'user.email', 'roles@kubic.dev']);
  await gitOrThrow(root, ['config', 'user.name', 'kubic roles']);
  await gitOrThrow(root, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(root, 'base.txt'), 'base\n');
  const rolesDir = join(root, '.kubic', 'roles');
  mkdirSync(rolesDir, { recursive: true });
  writeFileSync(
    join(rolesDir, 'planner.md'),
    roleText(
      'planner',
      PLANNER_FM,
      'You are the planner. Produce ordered steps with file refs.',
    ),
  );
  writeFileSync(
    join(rolesDir, 'implementer.md'),
    roleText(
      'implementer',
      IMPLEMENTER_FM,
      'You are the implementer. Execute the plan inside your worktree.',
    ),
  );
  await gitOrThrow(root, ['add', '-A']);
  await gitOrThrow(root, ['commit', '-m', 'base + roles']);
  return root;
}

async function harness(): Promise<{
  root: string;
  deps: Awaited<ReturnType<typeof orchestrateDepsWithDefaults>>;
  lines: string[];
  dumpDir: string;
}> {
  const root = await initRepoWithRoles();
  const sessionsRoot = scratchRoot('kubic-orch-roles-sessions-');
  const scratch = scratchRoot('kubic-orch-roles-child-');
  const fixture = join(scratch, 'worker-child.mjs');
  writeFileSync(fixture, FIXTURE);
  const lines: string[] = [];
  const deps = await orchestrateDepsWithDefaults({
    out: (line) => lines.push(line),
    cwd: root,
    sessionsRoot,
    registry: new WorkerRegistry(),
    workerEntry: { cmd: process.execPath, args: [fixture] },
  });
  const dumpDir = scratchRoot('kubic-orch-roles-prompts-');
  return { root, deps, lines, dumpDir };
}

function readDump(dumpDir: string, agentId: string, suffix: string): string {
  return readFileSync(join(dumpDir, `${agentId}.${suffix}.txt`), 'utf8');
}

describe('prod orchestrate path: role-driven worker prompts (issue #104)', () => {
  it('hands each real child a role-composed prompt and its own role', async () => {
    const h = await harness();
    const objective = `do the thing EXIT=0 PROMPTDUMPDIR=${h.dumpDir}`;
    const code = await runOrchestrateCommand(
      [
        '-p',
        objective,
        '--agents',
        'alpha,beta',
        '--yes',
        '--session',
        'rolesession',
      ],
      h.deps,
    );
    expect(code).toBe(0);
    const alpha = readDump(h.dumpDir, 'alpha', 'prompt');
    const beta = readDump(h.dumpDir, 'beta', 'prompt');
    // Two workers, two different prompts — neither is the shared -p text.
    expect(alpha).not.toBe(beta);
    expect(alpha).not.toBe(objective);
    expect(beta).not.toBe(objective);
    // Each is the assigned role's `## Prompt` text PLUS its own plan step:
    // role text first, then the step.
    expect(alpha).toContain('You are the planner.');
    expect(alpha).toContain("Plan step 1 of 2 for agent 'alpha'");
    expect(beta).toContain('You are the implementer.');
    expect(beta).toContain("Plan step 2 of 2 for agent 'beta'");
    expect(alpha).not.toContain('You are the implementer.');
    expect(beta).not.toContain('You are the planner.');
    expect(alpha.indexOf('You are the planner.')).toBeLessThan(
      alpha.indexOf('Plan step 1 of 2'),
    );
    // The child is told which role it runs as, so its own lane registers the
    // role's resolved tool set — and the role's model default travels via the
    // existing KUBIC_MODEL pin.
    expect(readDump(h.dumpDir, 'alpha', 'role')).toBe('planner');
    expect(readDump(h.dumpDir, 'beta', 'role')).toBe('implementer');
    expect(readDump(h.dumpDir, 'alpha', 'model')).toBe('local/llama3');
    expect(readDump(h.dumpDir, 'beta', 'model')).toBe('local/llama3');
  });

  it('refuses a contradictory role document before any worktree or spawn exists', async () => {
    const h = await harness();
    // The document that landed in the repo contradicts itself: `tools`
    // declares a write tool under a read-only filesystem class (§40.3).
    writeFileSync(
      join(h.root, '.kubic', 'roles', 'planner.md'),
      roleText(
        'planner',
        'tools: [read, write]\nfilesystem: read\nshell: false\nnetwork: none\ngit: false\ncredentials: none\n',
        'You claim to be read-only.',
      ),
    );
    const code = await runOrchestrateCommand(
      [
        '-p',
        `do the thing EXIT=0 PROMPTDUMPDIR=${h.dumpDir}`,
        '--agents',
        'alpha,beta',
        '--yes',
      ],
      h.deps,
    );
    expect(code).toBe(1);
    const text = h.lines.join('\n');
    expect(text).toMatch(/code=role_refused/);
    expect(text).toContain(
      "filesystem is 'read' but write tool 'write' is registered",
    );
    // Nothing spawned (a spawned child would have dumped its prompt), nothing
    // merged, no retained worktree.
    expect(text).not.toMatch(/worker: /);
    expect(readdirSync(h.dumpDir)).toEqual([]);
    const wt = join(h.root, '.kubic', 'wt');
    expect(existsSync(wt) ? readdirSync(wt) : []).toEqual([]);
  });

  it('does not leave the run hanging when a role document does not parse', async () => {
    // Frontmatter that cannot be parsed is a role-document failure too: it
    // must reach the operator as the loader's named reason under the same
    // machine-readable code, never as an unhandled rejection.
    const h = await harness();
    writeFileSync(
      join(h.root, '.kubic', 'roles', 'planner.md'),
      'not frontmatter at all\n',
    );
    const code = await runOrchestrateCommand(
      ['-p', 'do the thing', '--agents', 'alpha', '--yes'],
      h.deps,
    );
    expect(code).toBe(1);
    expect(h.lines.join('\n')).toMatch(/code=role_refused/);
    expect(h.lines.join('\n')).toMatch(/role document/i);
  });

  it('lets an explicit operator model pin outrank the role default', async () => {
    // §12.1 precedence: the role default is the LOWEST-precedence choice. An
    // operator who pinned KUBIC_MODEL must keep it — the delegation path may
    // not quietly replace their model with a role default.
    const h = await harness();
    const previous = process.env.KUBIC_MODEL;
    process.env.KUBIC_MODEL = 'acme/m9';
    try {
      const code = await runOrchestrateCommand(
        [
          '-p',
          `do the thing EXIT=0 PROMPTDUMPDIR=${h.dumpDir}`,
          '--agents',
          'alpha',
          '--yes',
          '--session',
          'pinsession',
        ],
        h.deps,
      );
      expect(code).toBe(0);
      expect(readDump(h.dumpDir, 'alpha', 'model')).toBe('acme/m9');
    } finally {
      if (previous === undefined) delete process.env.KUBIC_MODEL;
      else process.env.KUBIC_MODEL = previous;
    }
  });

  it('resolves role documents from the run cwd, not the process cwd', async () => {
    // The composition root is given an explicit cwd (a caller embedding the
    // run); the role documents must come from THAT repo. A process-cwd read
    // would pick up this repository's own `.kubic/roles/` and hand the
    // scratch run a role it never committed.
    const plain = scratchRoot('kubic-orch-noroles-');
    await gitOrThrow(plain, ['init', '-b', 'main']);
    await gitOrThrow(plain, ['config', 'user.email', 'roles@kubic.dev']);
    await gitOrThrow(plain, ['config', 'user.name', 'kubic roles']);
    await gitOrThrow(plain, ['config', 'commit.gpgsign', 'false']);
    writeFileSync(join(plain, 'base.txt'), 'base\n');
    await gitOrThrow(plain, ['add', '-A']);
    await gitOrThrow(plain, ['commit', '-m', 'base']);
    const sessionsRoot = scratchRoot('kubic-orch-noroles-sessions-');
    const scratch = scratchRoot('kubic-orch-noroles-child-');
    const fixture = join(scratch, 'worker-child.mjs');
    writeFileSync(fixture, FIXTURE);
    const dumpDir = scratchRoot('kubic-orch-noroles-prompts-');
    const deps = await orchestrateDepsWithDefaults({
      out: () => undefined,
      cwd: plain,
      sessionsRoot,
      registry: new WorkerRegistry(),
      workerEntry: { cmd: process.execPath, args: [fixture] },
    });
    const code = await runOrchestrateCommand(
      [
        '-p',
        `do the thing EXIT=0 PROMPTDUMPDIR=${dumpDir}`,
        '--agents',
        'alpha',
        '--yes',
        '--session',
        'norolesession',
      ],
      deps,
    );
    expect(code).toBe(0);
    // No role documents in that repo: the plan prompt stands and no role
    // reaches the child.
    expect(readDump(dumpDir, 'alpha', 'prompt')).toContain('Plan step 1 of 1');
    expect(readDump(dumpDir, 'alpha', 'prompt')).not.toContain(
      'You are the planner.',
    );
    expect(readDump(dumpDir, 'alpha', 'role')).toBe('(none)');
    expect(readDump(dumpDir, 'alpha', 'model')).toBe('(none)');
  });
});
