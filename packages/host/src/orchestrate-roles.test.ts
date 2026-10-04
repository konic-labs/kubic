// Role-driven prompts on the `kubic orchestrate` delegation path (issue
// #104; §12/§12.1, §40, §71). Covers the acceptance criteria at the CLI
// seam: two role-assigned workers get different prompts (role text + that
// worker's plan step), a withholder role's tools are never registered
// (absence, not approval), a contradictory role document refuses the run
// with the resolver's named reason, and --resume replays each worker's own
// composed prompt. Faux/in-memory only: zero network, zero paid tokens.
import { describe, expect, it } from 'vitest';
import type {
  OrchestrateCommandDeps,
  OrchestrateWorktree,
  OrchestratorRunState,
  WorkerSpawnInfo,
} from './orchestrate-cli.js';
import { runOrchestrateCommand } from './orchestrate-cli.js';
import {
  MANAGER_ALLOWLIST,
  registerManagerLane,
} from './orchestrator/manager.js';
import type { MergedHunk } from './orchestrator/merge/attribution.js';
import { createRoleToolGuard } from './roles/resolver.js';
import { planWorkerRoles } from './roles/worker-roles.js';

const REPO = '/repo';

// An in-memory bridge slice: the loader's own contract, no filesystem.
function memBridge(files: Record<string, string>) {
  return {
    listDir: (dir: string) => {
      const prefix = `${dir}/`;
      const names = new Map<string, boolean>();
      for (const path of Object.keys(files)) {
        if (!path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length);
        const slash = rest.indexOf('/');
        if (slash === -1) names.set(rest, false);
        else names.set(rest.slice(0, slash), true);
      }
      return [...names.entries()].map(([name, isDirectory]) => ({
        name,
        path: `${prefix}${name}`,
        isDirectory,
        isSymbolicLink: false,
        size: 0,
        mtimeMs: 0,
      }));
    },
    readTextFile: (path: string) => {
      const text = files[path];
      if (text === undefined) throw new Error(`ENOENT: ${path}`);
      return text;
    },
  };
}

function roleText(name: string, frontmatter: string, prompt: string): string {
  return `---\nrole: ${name}\n${frontmatter}---\n\n# ${name}\n\n## Prompt\n\n${prompt}\n`;
}

const PLANNER_FM =
  'tools: [read, ls, find, grep]\nfilesystem: read\nshell: false\nnetwork: none\ngit: false\ncredentials: none\n';
const IMPLEMENTER_FM =
  'tools: [read, ls, find, grep, write, edit, bash]\nfilesystem: workspace-write\nshell: true\nnetwork: none\ngit: false\ncredentials: none\n';

function rolesFor(...docs: Record<string, string>[]): Record<string, string> {
  return Object.assign({}, ...docs);
}

function plannerDoc(
  prompt = 'You are the planner. Produce ordered steps.',
): Record<string, string> {
  return {
    [`${REPO}/.kubic/roles/planner.md`]: roleText(
      'planner',
      PLANNER_FM,
      prompt,
    ),
  };
}

function implementerDoc(
  prompt = 'You are the implementer. Write the code.',
): Record<string, string> {
  return {
    [`${REPO}/.kubic/roles/implementer.md`]: roleText(
      'implementer',
      IMPLEMENTER_FM,
      prompt,
    ),
  };
}

interface World {
  deps: OrchestrateCommandDeps;
  lines: string[];
  errLines: string[];
  saved: OrchestratorRunState[];
  prompts: { agentId: string; prompt: string }[];
  spawnInfo: { agentId: string; info?: WorkerSpawnInfo }[];
  calls: { run: string[]; merge: string[]; ensure: string[] };
}

function makeWorld(overrides: Partial<OrchestrateCommandDeps> = {}): World {
  const lines: string[] = [];
  const errLines: string[] = [];
  const saved: OrchestratorRunState[] = [];
  const prompts: { agentId: string; prompt: string }[] = [];
  const spawnInfo: { agentId: string; info?: WorkerSpawnInfo }[] = [];
  const calls = {
    run: [] as string[],
    merge: [] as string[],
    ensure: [] as string[],
  };
  const deps: OrchestrateCommandDeps = {
    out: (line: string) => lines.push(line),
    err: (line: string) => errLines.push(line),
    now: () => 1700000000000,
    isGitRepo: () => true,
    ensureWorktree: (agentId: string): OrchestrateWorktree => {
      calls.ensure.push(agentId);
      return {
        path: `${REPO}/.kubic/wt/${agentId}`,
        branch: `kubic/${agentId}`,
      };
    },
    createWorkerSession: (input) => ({ sessionId: input.workerSessionId }),
    runWorker: (
      agentId: string,
      _worktree: OrchestrateWorktree,
      prompt: string,
      info?: WorkerSpawnInfo,
    ) => {
      calls.run.push(agentId);
      prompts.push({ agentId, prompt });
      spawnInfo.push({ agentId, ...(info === undefined ? {} : { info }) });
      const hunks: MergedHunk[] = [
        { path: `${agentId}.txt`, hunk: '@@ +1 @@' },
      ];
      return hunks;
    },
    mergeBranch: (agentId: string) => {
      calls.merge.push(agentId);
    },
    reapWorker: () => undefined,
    registerManagerLane: () => registerManagerLane([...MANAGER_ALLOWLIST]),
    loadState: () => undefined,
    saveState: (state: OrchestratorRunState) => {
      saved.push(structuredClone(state));
    },
    ...overrides,
  };
  return { deps, lines, errLines, saved, prompts, spawnInfo, calls };
}

function roleLoaderFor(files: Record<string, string>) {
  return (agents: readonly string[]) =>
    planWorkerRoles({
      bridge: memBridge(files),
      cwd: REPO,
      agents,
      // §38.1 (#202): the manager's effective model is the fallback under a
      // role's own `[roles.<r>].model` pin — the run's plan resolves the
      // value the child is then told.
      parentModel: 'acme/manager',
    });
}

const OBJECTIVE = 'apply the change across the repo';

describe('orchestrate assigns roles per worker (issue #104, criterion 1)', () => {
  it('gives two role-assigned workers different prompts: role text + that worker step', async () => {
    const world = makeWorld({
      loadWorkerRoles: roleLoaderFor(rolesFor(plannerDoc(), implementerDoc())),
    });
    const code = await runOrchestrateCommand(
      {
        prompt: OBJECTIVE,
        agents: ['alpha', 'beta'],
        session: 'sess-1',
        yes: true,
      },
      world.deps,
    );
    expect(code).toBe(0);
    const [alpha, beta] = world.prompts;
    expect(alpha?.agentId).toBe('alpha');
    expect(beta?.agentId).toBe('beta');
    // Different prompts, never the shared -p text.
    expect(alpha?.prompt).not.toBe(beta?.prompt);
    for (const entry of world.prompts) {
      expect(entry.prompt).not.toBe(OBJECTIVE);
    }
    // Each carries its OWN role document's `## Prompt` text…
    expect(alpha?.prompt).toContain('You are the planner.');
    expect(beta?.prompt).toContain('You are the implementer.');
    expect(alpha?.prompt).not.toContain('You are the implementer.');
    expect(beta?.prompt).not.toContain('You are the planner.');
    // …composed WITH its own plan step (both halves, role first).
    expect(alpha?.prompt).toContain("Plan step 1 of 2 for agent 'alpha'");
    expect(beta?.prompt).toContain("Plan step 2 of 2 for agent 'beta'");
    expect(alpha?.prompt?.indexOf('You are the planner.')).toBeLessThan(
      alpha?.prompt?.indexOf('Plan step 1 of 2') as number,
    );
    // The role and its resolved model/thinking levels travel to the child
    // spawn (§12.1, §38.1): no role pin here, so the manager's model is what
    // the worker is told.
    expect(world.spawnInfo[0]?.info?.role).toBe('planner');
    expect(world.spawnInfo[1]?.info?.role).toBe('implementer');
    expect(world.spawnInfo[0]?.info?.modelRef).toBe('acme/manager');
    expect(world.spawnInfo[0]?.info?.thinking).toBe('medium');
  });

  it('stores the composed prompt per worker and replays it on --resume', async () => {
    const files = rolesFor(plannerDoc(), implementerDoc());
    const first = makeWorld({
      loadWorkerRoles: roleLoaderFor(files),
      mergeBranch: (agentId: string) => {
        if (agentId === 'beta') throw new Error('KILLED');
      },
    });
    expect(
      await runOrchestrateCommand(
        {
          prompt: OBJECTIVE,
          agents: ['alpha', 'beta'],
          session: 'sess-1',
          yes: true,
        },
        first.deps,
      ),
    ).toBe(1);
    const killed = first.saved[first.saved.length - 1] as OrchestratorRunState;
    expect(killed.pending).toEqual(['beta']);
    // The stored plan carries the COMPOSED prompt (role text + step)…
    const storedBeta = killed.plan?.[1]?.prompt ?? '';
    expect(storedBeta).toContain('You are the implementer.');
    expect(storedBeta).toContain("Plan step 2 of 2 for agent 'beta'");

    // …and a resume with no -p replays it verbatim, so the retried worker
    // runs the same composed prompt it ran before the kill.
    const second = makeWorld({
      loadWorkerRoles: roleLoaderFor(files),
      loadState: () => structuredClone(killed),
    });
    expect(
      await runOrchestrateCommand(
        { resume: true, session: 'sess-1', yes: true },
        second.deps,
      ),
    ).toBe(0);
    expect(second.prompts).toHaveLength(1);
    expect(second.prompts[0]?.prompt).toBe(storedBeta);
    expect(second.spawnInfo[0]?.info?.role).toBe('implementer');
  });

  it('keeps the plan step working when no role documents exist (solo default unaffected)', async () => {
    const world = makeWorld({ loadWorkerRoles: roleLoaderFor({}) });
    const code = await runOrchestrateCommand(
      {
        prompt: OBJECTIVE,
        agents: ['alpha', 'beta'],
        session: 'sess-1',
        yes: true,
      },
      world.deps,
    );
    expect(code).toBe(0);
    expect(world.prompts[0]?.prompt).toContain('Plan step 1 of 2');
    expect(world.prompts[0]?.prompt).not.toContain('You are the planner.');
    expect(world.spawnInfo[0]?.info?.role).toBeUndefined();
  });
});

describe('a withholding role withholds by absence (issue #104, criterion 2)', () => {
  it('never registers write/edit/bash for a read-only role: they fail tool-absent, not approval', async () => {
    const world = makeWorld({
      loadWorkerRoles: roleLoaderFor(rolesFor(plannerDoc(), implementerDoc())),
    });
    await runOrchestrateCommand(
      {
        prompt: OBJECTIVE,
        agents: ['alpha', 'beta'],
        session: 'sess-1',
        yes: true,
      },
      world.deps,
    );
    // The tool set the worker lane registers is the role's resolved set,
    // carried on the spawn info. The planner's set excludes the write path.
    const plannerTools = world.spawnInfo[0]?.info?.tools ?? [];
    expect(plannerTools).toContain('read');
    for (const withheld of ['write', 'edit', 'bash']) {
      expect(plannerTools).not.toContain(withheld);
    }
    // Absence, not approval: the guard's verdict names the absence and no
    // decider is consulted (a read-only worker's write call cannot be
    // approved into existence).
    const guard = createRoleToolGuard('planner', plannerTools);
    const verdict = guard({
      toolCallId: 'call-1',
      toolName: 'write',
      args: { path: 'x.txt' },
    });
    expect(verdict).toEqual({
      block: {
        reason: expect.stringContaining('tool-absent'),
        terminate: false,
      },
    });
    expect((verdict as { block: { reason: string } }).block.reason).not.toMatch(
      /approval/i,
    );
    // The implementer's role DOES hold the write path — the filter is the
    // role's, not a blanket refusal.
    expect(world.spawnInfo[1]?.info?.tools).toContain('write');
  });
});

describe('a contradictory role document refuses the run (issue #104, criterion 3)', () => {
  it('refuses with the resolver named reason and spawns nothing', async () => {
    const files = rolesFor(
      {
        [`${REPO}/.kubic/roles/planner.md`]: roleText(
          'planner',
          'tools: [read, write]\nfilesystem: read\nshell: false\nnetwork: none\ngit: false\ncredentials: none\n',
          'You claim to be read-only.',
        ),
      },
      implementerDoc(),
    );
    const world = makeWorld({ loadWorkerRoles: roleLoaderFor(files) });
    const code = await runOrchestrateCommand(
      {
        prompt: OBJECTIVE,
        agents: ['alpha', 'beta'],
        session: 'sess-1',
        yes: true,
      },
      world.deps,
    );
    expect(code).toBe(1);
    const text = world.errLines.join('\n');
    expect(text).toMatch(/code=role_refused/);
    expect(text).toContain("role 'planner'");
    expect(text).toContain(
      "filesystem is 'read' but write tool 'write' is registered",
    );
    // Fail-closed: nothing was created, spawned or merged.
    expect(world.calls.ensure).toEqual([]);
    expect(world.calls.run).toEqual([]);
    expect(world.calls.merge).toEqual([]);
  });

  it('reports the refusal as one machine-readable envelope under --json', async () => {
    const files = rolesFor(plannerDoc(), {
      [`${REPO}/.kubic/roles/implementer.md`]: roleText(
        'implementer',
        'tools: [read, write]\nfilesystem: read\nshell: false\nnetwork: none\ngit: false\ncredentials: none\n',
        'Contradiction.',
      ),
    });
    const world = makeWorld({ loadWorkerRoles: roleLoaderFor(files) });
    const code = await runOrchestrateCommand(
      {
        prompt: OBJECTIVE,
        agents: ['alpha', 'beta'],
        session: 'sess-1',
        yes: true,
        json: true,
      },
      world.deps,
    );
    expect(code).toBe(1);
    const envelope = JSON.parse(
      world.lines[world.lines.length - 1] as string,
    ) as {
      ok?: boolean;
      error?: { code?: string; message?: string };
    };
    expect(envelope.ok).toBe(false);
    expect(envelope.error?.code).toBe('role_refused');
    expect(envelope.error?.message).toContain(
      "filesystem is 'read' but write tool 'write' is registered",
    );
  });
});
