// Role-driven worker prompts on the PROD orchestrate path (issue #104;
// §12/§12.1, §40, §71; model resolution reworked by #202). Drives the real
// composition-root adapter against real git and a REAL child process: the
// child fixture dumps the prompt it received and its own environment, so the
// claims are read from the child's view — not from the spawn call the test
// could have gotten wrong. The assertions matter here:
//   1. two workers with different roles receive different composed prompts
//      (role `## Prompt` text + that worker's plan step),
//   2. the child `kubic run` is told which role it runs as, so its own lane
//      registers the role's resolved tool set (§40: absence withholds), and
//   3. §38.1 model precedence (#202): the role's `[roles.<r>].model` config
//      pin, then the manager's effective model — never a hardcoded provider —
//      with the role's thinking default (or the run's explicit level) on the
//      child's `KUBIC_MODEL` / `KUBIC_MODEL_THINKING`.
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
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  loadCliConfig,
  roleLayersFromConfig,
  runtimeModelPin,
} from '../../../apps/kubic/src/config-runtime.js';
import { orchestrateDepsWithDefaults } from '../../../apps/kubic/src/orchestrate-run.js';
import type { Provenance } from '../../exec/src/env.js';
import { NodeExecutionEnv } from '../../exec/src/env.js';
import { WorkerRegistry } from '../../worker/src/lifecycle/registry.js';
import { runOrchestrateCommand } from './orchestrate-cli.js';
import type { RoleLayerInput } from './roles/resolver.js';

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
  writeFileSync(dumpDir[1] + '/' + id + '.thinking.txt', process.env.KUBIC_MODEL_THINKING ?? '(none)');
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
  vi.unstubAllEnvs();
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
// A project config, when given, is committed with them — an untracked one
// would dirty the tree the pre-merge guard checks.
async function initRepoWithRoles(projectConfig?: string): Promise<string> {
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
  if (projectConfig !== undefined) {
    writeFileSync(join(root, '.kubic', 'config.toml'), projectConfig);
  }
  await gitOrThrow(root, ['add', '-A']);
  await gitOrThrow(root, ['commit', '-m', 'base + roles']);
  return root;
}

interface HarnessOptions {
  /** The manager's effective model pin (`orchestrateDepsWithDefaults.model`). */
  model?: { provider: string; id: string };
  /** A committed project `.kubic/config.toml` (trusted for the run). */
  projectConfig?: string;
}

async function harness(options: HarnessOptions = {}): Promise<{
  root: string;
  deps: Awaited<ReturnType<typeof orchestrateDepsWithDefaults>>;
  lines: string[];
  dumpDir: string;
}> {
  const root = await initRepoWithRoles(options.projectConfig);
  const sessionsRoot = scratchRoot('kubic-orch-roles-sessions-');
  const scratch = scratchRoot('kubic-orch-roles-child-');
  const fixture = join(scratch, 'worker-child.mjs');
  writeFileSync(fixture, FIXTURE);
  // The committed config is loaded and projected exactly as the composition
  // root does it: `roleLayersFromConfig(cliConfig)` for the `[roles.<name>]`
  // layers and `runtimeModelPin(cliConfig)` for the manager's effective
  // model. The run must plan over the same layers the worker's own
  // `kubic run --role` resolves.
  let roleLayers: RoleLayerInput[] | undefined;
  let model = options.model;
  if (options.projectConfig !== undefined) {
    const loaded = loadCliConfig({
      cwd: root,
      env: { KUBIC_TRUST_PROJECT: '1' },
      home: scratchRoot('kubic-orch-roles-home-'),
    });
    expect(loaded.error).toBeUndefined();
    roleLayers = roleLayersFromConfig(loaded.runtime as never);
    if (model === undefined) {
      const pin = runtimeModelPin(loaded);
      model =
        pin === undefined ? undefined : { provider: pin.provider, id: pin.id };
    }
  }
  const lines: string[] = [];
  const deps = await orchestrateDepsWithDefaults({
    out: (line) => lines.push(line),
    err: (line) => lines.push(line),
    cwd: root,
    sessionsRoot,
    registry: new WorkerRegistry(),
    workerEntry: { cmd: process.execPath, args: [fixture] },
    // Issue #430: the harness trusts the repo it just created, so worker
    // role planning reads its `.kubic/roles/*.md` like a trusted run.
    projectTrust: () => true,
    ...(model === undefined ? {} : { model }),
    ...(roleLayers === undefined ? {} : { roleLayers }),
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
      {
        prompt: objective,
        // The explicit per-agent binding (issue #178): alpha plans, beta
        // implements.
        agents: ['alpha:planner', 'beta:implementer'],
        yes: true,
        session: 'rolesession',
      },
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
    // role's resolved tool set. §38.1 (#202): no level chose a model for this
    // run, so no KUBIC_MODEL is invented — the child keeps its own selection
    // default — and the role's own thinking default still travels.
    expect(readDump(h.dumpDir, 'alpha', 'role')).toBe('planner');
    expect(readDump(h.dumpDir, 'beta', 'role')).toBe('implementer');
    expect(readDump(h.dumpDir, 'alpha', 'model')).toBe('(none)');
    expect(readDump(h.dumpDir, 'beta', 'model')).toBe('(none)');
    expect(readDump(h.dumpDir, 'alpha', 'thinking')).toBe('medium');
    expect(readDump(h.dumpDir, 'beta', 'thinking')).toBe('medium');
  });

  it('hands the committed [model] to every worker with no role pin (issue #202)', async () => {
    // Acceptance: parent config `[model]` acme/x, no KUBIC_MODEL env, role
    // docs present — the child is told acme/x, never local/llama3. (`acme` is
    // a provider the manager's catalog does not know, so the credential
    // preflight has nothing to deliver and the claim stays about the model.)
    const h = await harness({
      projectConfig: '[model]\nprovider = "acme"\nid = "x"\n',
    });
    const code = await runOrchestrateCommand(
      {
        prompt: `do the thing EXIT=0 PROMPTDUMPDIR=${h.dumpDir}`,
        agents: ['alpha', 'beta'],
        yes: true,
        session: 'parentmodel',
      },
      h.deps,
    );
    expect(code).toBe(0);
    expect(readDump(h.dumpDir, 'alpha', 'model')).toBe('acme/x');
    expect(readDump(h.dumpDir, 'beta', 'model')).toBe('acme/x');
  });

  it('lets the committed [roles.<r>].model pin win for its own worker (issue #202)', async () => {
    // Acceptance: `[roles.implementer] model = "acme/m2"` makes the
    // implementer worker run acme/m2 — through the real config load and the
    // same projection the composition root passes the run.
    const h = await harness({
      projectConfig:
        '[model]\nprovider = "acme"\nid = "x"\n\n[roles.implementer]\nmodel = "acme/m2"\n',
    });
    const code = await runOrchestrateCommand(
      {
        prompt: `do the thing EXIT=0 PROMPTDUMPDIR=${h.dumpDir}`,
        agents: ['alpha:planner', 'beta:implementer'],
        yes: true,
        session: 'rolepin',
      },
      h.deps,
    );
    expect(code).toBe(0);
    // The planner has no pin: it runs the manager's model.
    expect(readDump(h.dumpDir, 'alpha', 'model')).toBe('acme/x');
    // The implementer's own config pin outranks it.
    expect(readDump(h.dumpDir, 'beta', 'model')).toBe('acme/m2');
  });

  it('hands the committed [roles.<r>].thinking default to its worker (issue #225)', async () => {
    // Acceptance: `[roles.planner] thinking = "low"` makes the planner
    // worker run at low — through the real config load and the same
    // projection the composition root passes the run, down to the child's
    // own environment (the GAP in #225's review: the plan ignored the
    // config layer and every worker got the hardcoded §12 default).
    const h = await harness({
      projectConfig: '[roles.planner]\nthinking = "low"\n',
    });
    const code = await runOrchestrateCommand(
      {
        prompt: `do the thing EXIT=0 PROMPTDUMPDIR=${h.dumpDir}`,
        agents: ['alpha:planner', 'beta:implementer'],
        yes: true,
        session: 'rolethinking',
      },
      h.deps,
    );
    expect(code).toBe(0);
    // The planner runs its own config default; the implementer keeps the
    // hardcoded §12 default — the layer is per-role.
    expect(readDump(h.dumpDir, 'alpha', 'thinking')).toBe('low');
    expect(readDump(h.dumpDir, 'beta', 'thinking')).toBe('medium');
  });

  it('narrows the orchestrated role with the committed [roles.<r>].tools layer (issue #202)', async () => {
    // Acceptance: config `[roles.reviewer] tools` narrows the orchestrated
    // reviewer worker — the plan the run uses resolves over the same layers
    // the worker's own `kubic run --role reviewer` would.
    const h = await harness({
      projectConfig:
        '[roles.reviewer]\ntools = ["read", "ls"]\nmodel = "acme/rev"\n',
    });
    writeFileSync(
      join(h.root, '.kubic', 'roles', 'reviewer.md'),
      roleText(
        'reviewer',
        PLANNER_FM,
        'You are the reviewer. Inspect the diff.',
      ),
    );
    const plan = h.deps.loadWorkerRoles?.(['w1', 'w2', 'w3', 'w4', 'w5'], {
      roles: { w5: 'reviewer' },
      models: {},
    });
    const reviewer = plan?.assignments.find(
      (entry) => entry.role === 'reviewer',
    );
    expect(reviewer?.agentId).toBe('w5');
    expect(reviewer?.tools).toEqual(['ls', 'read']);
    expect(reviewer?.modelRef).toBe('acme/rev');
  });

  it("the run's explicit thinking level outranks the role's own default (issue #202)", async () => {
    // The plan the run uses resolves it per worker: the role's own default
    // when nothing explicit is set, the run's level for every worker when it
    // is — and the same value is what the child is told below.
    const bare = await harness();
    expect(
      bare.deps
        .loadWorkerRoles?.(['alpha', 'beta'])
        ?.assignments.map((entry) => entry.thinking),
    ).toEqual(['medium', 'medium']);
    vi.stubEnv('KUBIC_MODEL_THINKING', 'xhigh');
    const h = await harness();
    expect(h.deps.loadWorkerRoles?.(['alpha'])?.assignments[0]?.thinking).toBe(
      'xhigh',
    );
    const code = await runOrchestrateCommand(
      {
        prompt: `do the thing EXIT=0 PROMPTDUMPDIR=${h.dumpDir}`,
        agents: ['alpha'],
        yes: true,
        session: 'thinkinglevel',
      },
      h.deps,
    );
    expect(code).toBe(0);
    expect(readDump(h.dumpDir, 'alpha', 'thinking')).toBe('xhigh');
  });

  it('defaults every worker of a two-agent run to the implementer (issue #178)', async () => {
    // Acceptance: the default run no longer spends a worker on a planner
    // whose plan nothing consumes — position is not a task.
    const h = await harness();
    const code = await runOrchestrateCommand(
      {
        prompt: `do the thing EXIT=0 PROMPTDUMPDIR=${h.dumpDir}`,
        agents: ['alpha', 'beta'],
        yes: true,
        session: 'defaultroles',
      },
      h.deps,
    );
    expect(code).toBe(0);
    expect(readDump(h.dumpDir, 'alpha', 'role')).toBe('implementer');
    expect(readDump(h.dumpDir, 'beta', 'role')).toBe('implementer');
  });

  it('refuses an unknown role before anything spawns (issue #178)', async () => {
    const h = await harness();
    const code = await runOrchestrateCommand(
      {
        prompt: `do the thing EXIT=0 PROMPTDUMPDIR=${h.dumpDir}`,
        agents: ['alpha:teleporter'],
        yes: true,
        session: 'badrole',
      },
      h.deps,
    );
    expect(code).toBe(2);
    expect(h.lines.join('\n')).toMatch(/Unknown role "teleporter"/);
    expect(readdirSync(h.dumpDir)).toEqual([]);
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
      {
        prompt: `do the thing EXIT=0 PROMPTDUMPDIR=${h.dumpDir}`,
        agents: ['alpha', 'beta'],
        yes: true,
      },
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
    // machine-readable code, never as an unhandled rejection. Issue #236:
    // only the SELECTED document can block a run — alpha is bound to the
    // broken planner role, so the refusal names planner.md; a worker on
    // any other role would proceed.
    const h = await harness();
    writeFileSync(
      join(h.root, '.kubic', 'roles', 'planner.md'),
      'not frontmatter at all\n',
    );
    const code = await runOrchestrateCommand(
      { prompt: 'do the thing', agents: ['alpha:planner'], yes: true },
      h.deps,
    );
    expect(code).toBe(1);
    expect(h.lines.join('\n')).toMatch(/code=role_refused/);
    expect(h.lines.join('\n')).toMatch(/role document/i);
  });

  it('carries the operator KUBIC_MODEL to the worker unchanged (issue #202)', async () => {
    // §38.1: with no role pin the manager's effective model is the worker's —
    // an operator who pinned KUBIC_MODEL keeps it, and the delegation path may
    // neither replace it with a role default nor with anything else.
    const h = await harness();
    const previous = process.env.KUBIC_MODEL;
    process.env.KUBIC_MODEL = 'acme/m9';
    try {
      const code = await runOrchestrateCommand(
        {
          prompt: `do the thing EXIT=0 PROMPTDUMPDIR=${h.dumpDir}`,
          agents: ['alpha'],
          yes: true,
          session: 'pinsession',
        },
        h.deps,
      );
      expect(code).toBe(0);
      expect(readDump(h.dumpDir, 'alpha', 'model')).toBe('acme/m9');
    } finally {
      if (previous === undefined) delete process.env.KUBIC_MODEL;
      else process.env.KUBIC_MODEL = previous;
    }
  });

  it('assigns the embedded presets in a repo with no role documents (issue #203)', async () => {
    // The same scratch shape as the cwd test, minus the role document: the
    // built-in presets ship with the binary, so the child is still launched
    // as a role — `--role planner`, with the embedded planner prompt — instead
    // of running as a role-less worker.
    const plain = scratchRoot('kubic-orch-presets-');
    await gitOrThrow(plain, ['init', '-b', 'main']);
    await gitOrThrow(plain, ['config', 'user.email', 'roles@kubic.dev']);
    await gitOrThrow(plain, ['config', 'user.name', 'kubic roles']);
    await gitOrThrow(plain, ['config', 'commit.gpgsign', 'false']);
    writeFileSync(join(plain, 'base.txt'), 'base\n');
    await gitOrThrow(plain, ['add', '-A']);
    await gitOrThrow(plain, ['commit', '-m', 'base']);
    const sessionsRoot = scratchRoot('kubic-orch-presets-sessions-');
    const scratch = scratchRoot('kubic-orch-presets-child-');
    const fixture = join(scratch, 'worker-child.mjs');
    writeFileSync(fixture, FIXTURE);
    const dumpDir = scratchRoot('kubic-orch-presets-prompts-');
    const deps = await orchestrateDepsWithDefaults({
      out: () => undefined,
      err: () => undefined,
      cwd: plain,
      sessionsRoot,
      registry: new WorkerRegistry(),
      workerEntry: { cmd: process.execPath, args: [fixture] },
      // Issue #430: the scratch repo stands in for a trusted project.
      projectTrust: () => true,
    });
    const code = await runOrchestrateCommand(
      {
        prompt: `do the thing EXIT=0 PROMPTDUMPDIR=${dumpDir}`,
        agents: ['alpha:planner'],
        yes: true,
        session: 'presetsession',
      },
      deps,
    );
    expect(code).toBe(0);
    expect(readDump(dumpDir, 'alpha', 'role')).toBe('planner');
    expect(readDump(dumpDir, 'alpha', 'prompt')).toContain(
      'You are the planner.',
    );
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
    // A role document that exists ONLY in the scratch repo, with a prompt no
    // other layer could produce: if the run read the process cwd's own
    // `.kubic/roles/` (or fell back to the embedded preset) this text could
    // not reach the child.
    mkdirSync(join(plain, '.kubic', 'roles'), { recursive: true });
    writeFileSync(
      join(plain, '.kubic', 'roles', 'implementer.md'),
      '---\nrole: implementer\ntools: [read, ls, find, grep]\nfilesystem: read\nshell: false\nnetwork: none\ngit: false\ncredentials: none\n---\n\n# implementer\n\n## Prompt\n\nYou are the scratch implementer.\n',
    );
    await gitOrThrow(plain, ['add', '-A']);
    await gitOrThrow(plain, ['commit', '-m', 'base']);
    const sessionsRoot = scratchRoot('kubic-orch-noroles-sessions-');
    const scratch = scratchRoot('kubic-orch-noroles-child-');
    const fixture = join(scratch, 'worker-child.mjs');
    writeFileSync(fixture, FIXTURE);
    const dumpDir = scratchRoot('kubic-orch-noroles-prompts-');
    const deps = await orchestrateDepsWithDefaults({
      out: () => undefined,
      err: () => undefined,
      cwd: plain,
      sessionsRoot,
      registry: new WorkerRegistry(),
      workerEntry: { cmd: process.execPath, args: [fixture] },
      // Issue #430: the scratch repo stands in for a trusted project.
      projectTrust: () => true,
    });
    const code = await runOrchestrateCommand(
      {
        prompt: `do the thing EXIT=0 PROMPTDUMPDIR=${dumpDir}`,
        agents: ['alpha'],
        yes: true,
        session: 'norolesession',
      },
      deps,
    );
    expect(code).toBe(0);
    // The role comes from the SCRATCH repo's document — the default
    // implementer preset overridden there — not from the process cwd's own
    // `.kubic/roles/` nor from the preset embedded in the binary.
    expect(readDump(dumpDir, 'alpha', 'prompt')).toContain('Plan step 1 of 1');
    expect(readDump(dumpDir, 'alpha', 'prompt')).toContain(
      'You are the scratch implementer.',
    );
    expect(readDump(dumpDir, 'alpha', 'prompt')).not.toContain(
      'You are the implementer.',
    );
    expect(readDump(dumpDir, 'alpha', 'role')).toBe('implementer');
    expect(readDump(dumpDir, 'alpha', 'model')).toBe('(none)');
  });
});
