// Role-driven prompts on the delegation path (issue #104; §12/§12.1, §40,
// §71). RED first: `.kubic/roles/*.md` carry `## Prompt` bodies that nothing
// composes with a worker's plan step, no worker is assigned a role, and the
// role's resolved tool set never reaches a worker lane. Every test below
// fails until the delegation path assigns a role per worker and composes the
// worker prompt from the role's `## Prompt` text plus that worker's step.
//
// Built ON the live #99 seam (`roles-boot.ts`'s loader/resolver/prompt
// accessor) — this module is the delegation-side assignment, never a second
// loader. Faux/in-memory only: zero network, zero paid tokens.
import { describe, expect, it } from 'vitest';
import { resolveEffectivePolicy } from '../policy/enterprise.js';
import { createRoleToolGuard } from './resolver.js';
import {
  composeWorkerPrompt,
  planWorkerRoles,
  roleForAgent,
  type WorkerRolesPlan,
} from './worker-roles.js';

// An in-memory FileBridge slice: listDir + readTextFile over a path→text map,
// so the loader is driven without touching the filesystem.
function memBridge(files: Record<string, string>): {
  listDir: (dir: string) => Array<{
    name: string;
    path: string;
    isDirectory: boolean;
    isSymbolicLink: boolean;
    size: number;
    mtimeMs: number;
  }>;
  readTextFile: (path: string) => string;
} {
  return {
    listDir: (dir) => {
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
    readTextFile: (path) => {
      const text = files[path];
      if (text === undefined) throw new Error(`ENOENT: ${path}`);
      return text;
    },
  };
}

function roleText(name: string, frontmatter: string, prompt: string): string {
  return `---\nrole: ${name}\n${frontmatter}---\n\n# ${name}\n\n## Prompt\n\n${prompt}\n`;
}

const READ_ONLY =
  'tools: [read, ls, find, grep]\nfilesystem: read\nshell: false\nnetwork: none\ngit: false\ncredentials: none\n';
const WRITER =
  'tools: [read, ls, find, grep, write, edit, bash]\nfilesystem: workspace-write\nshell: true\nnetwork: none\ngit: false\ncredentials: none\n';

const CWD = '/repo';

function twoRoleCwd(): Record<string, string> {
  return {
    [`${CWD}/.kubic/roles/planner.md`]: roleText(
      'planner',
      READ_ONLY,
      'You are the planner. Read the objective and produce ordered steps.',
    ),
    [`${CWD}/.kubic/roles/implementer.md`]: roleText(
      'implementer',
      WRITER,
      'You are the implementer. Execute the plan inside your worktree.',
    ),
  };
}

function planFor(
  agents: readonly string[],
  binding: {
    roles?: Record<string, string>;
    models?: Record<string, string>;
  } = {},
): WorkerRolesPlan {
  return planWorkerRoles({
    bridge: memBridge(twoRoleCwd()),
    cwd: CWD,
    agents,
    ...(binding.roles === undefined ? {} : { roles: binding.roles }),
    ...(binding.models === undefined ? {} : { models: binding.models }),
  });
}

const TWO_ROLES = {
  roles: { alpha: 'planner', beta: 'implementer' },
};

describe('delegation-path role assignment (issue #104, §12)', () => {
  it('defaults every unassigned worker to the implementer, never a positional cycle (issue #178)', () => {
    // The five roles are fixed (D11): the manager composes from them and
    // never invents a role at runtime. Position is not a task: a worker with
    // no explicit role is an implementer — the role that produces a change —
    // so the default run no longer spawns a planner whose plan nothing uses.
    expect(roleForAgent(['alpha', 'beta'], 'alpha')).toBe('implementer');
    expect(roleForAgent(['alpha', 'beta'], 'beta')).toBe('implementer');
    expect(roleForAgent(['alpha', 'beta'], 'ghost')).toBeUndefined();
    expect(
      roleForAgent(['a', 'b', 'c', 'd', 'e', 'f'], 'f', {
        f: 'reviewer',
      }),
    ).toBe('reviewer');
    // An explicit binding names one of the five, by agent.
    expect(roleForAgent(['alpha', 'beta'], 'alpha', { alpha: 'tester' })).toBe(
      'tester',
    );
  });

  it('never mistakes an Object.prototype member for a binding (issue #178)', () => {
    // `toString` / `constructor` / `__proto__` are legal agent ids, so a
    // plain `roles[id]` lookup would hand back a FUNCTION as the role.
    expect(roleForAgent(['toString'], 'toString')).toBe('implementer');
    expect(roleForAgent(['constructor'], 'constructor')).toBe('implementer');
    expect(roleForAgent(['__proto__'], '__proto__')).toBe('implementer');
    const plan = planFor(['toString', 'constructor'], {
      roles: { toString: 'planner' },
    });
    expect(
      plan.assignments.map((entry) => [entry.agentId, entry.role]),
    ).toEqual([
      ['toString', 'planner'],
      ['constructor', 'implementer'],
    ]);
    // A `__proto__` model pin is a binding too, not a prototype.
    const pinned = planFor(['__proto__'], {
      models: { ['__proto__']: 'acme/m' },
    });
    expect(pinned.assignments[0]?.modelRef).toBe('acme/m');
  });

  it('assigns the explicit per-agent roles the caller bound (issue #178)', () => {
    const plan = planFor(['alpha', 'beta'], TWO_ROLES);
    expect(plan.refused).toEqual([]);
    expect(plan.assignments.map((entry) => entry.role)).toEqual([
      'planner',
      'implementer',
    ]);
    // A worker with no binding keeps the implementer default.
    const mixed = planFor(['alpha', 'beta'], { roles: { alpha: 'planner' } });
    expect(mixed.assignments.map((entry) => entry.role)).toEqual([
      'planner',
      'implementer',
    ]);
  });

  it('refuses an explicit role outside the fixed five by name (issue #178)', () => {
    const plan = planFor(['alpha'], { roles: { alpha: 'teleporter' } });
    expect(plan.assignments).toEqual([]);
    expect(plan.refused.map((entry) => entry.name)).toEqual(['teleporter']);
    expect(plan.refused[0]?.reason).toMatch(/unknown role 'teleporter'/);
  });

  it('lets an explicit per-agent model pin outrank the role config pin (issue #178)', () => {
    const plan = planWorkerRoles({
      bridge: memBridge(twoRoleCwd()),
      cwd: CWD,
      agents: ['alpha', 'beta'],
      layers: [{ layer: 'project', roles: { planner: { model: 'acme/cfg' } } }],
      parentModel: 'acme/manager',
      roles: { alpha: 'planner' },
      models: { alpha: 'acme/explicit' },
    });
    const [alpha, beta] = plan.assignments;
    // The flag is the highest level (§38.1 agent/spawn override)…
    expect(alpha?.modelRef).toBe('acme/explicit');
    // …and the other worker still resolves its own levels.
    expect(beta?.modelRef).toBe('acme/manager');
  });

  it('gives two role-assigned workers different prompts composed of role text + their step', () => {
    const plan = planFor(['alpha', 'beta'], TWO_ROLES);
    expect(plan.refused).toEqual([]);
    expect(plan.assignments.map((entry) => entry.role)).toEqual([
      'planner',
      'implementer',
    ]);
    const composed = plan.assignments.map((entry) =>
      composeWorkerPrompt(
        entry.promptText,
        `Plan step ${entry.agentId === 'alpha' ? 1 : 2} of 2 for agent '${entry.agentId}': ship it`,
      ),
    );
    // Two workers, two DIFFERENT prompts — neither is the shared -p text.
    expect(composed[0]).not.toBe(composed[1]);
    // Each carries its own role's `## Prompt` text…
    expect(composed[0]).toContain(
      'You are the planner. Read the objective and produce ordered steps.',
    );
    expect(composed[1]).toContain(
      'You are the implementer. Execute the plan inside your worktree.',
    );
    expect(composed[0]).not.toContain('You are the implementer.');
    expect(composed[1]).not.toContain('You are the planner.');
    // …and its own plan step: role prompt + step, never one replacing the
    // other.
    expect(composed[0]).toContain(
      "Plan step 1 of 2 for agent 'alpha': ship it",
    );
    expect(composed[1]).toContain("Plan step 2 of 2 for agent 'beta': ship it");
  });

  it('carries the role-resolved tool set and no invented model pin (issue #202)', () => {
    const plan = planFor(['alpha', 'beta'], TWO_ROLES);
    const [planner, implementer] = plan.assignments;
    // §12.1/§40: the tool set is the resolver's own resolved set.
    expect(planner?.tools).toEqual(['find', 'grep', 'ls', 'read']);
    expect(implementer?.tools).toContain('write');
    // §38.1: the model comes from the levels that actually set one — the
    // `[roles.<r>].model` config pin, then the manager's own effective model
    // — never a hardcoded provider. With neither, the child keeps its own
    // selection default instead of being forced onto `local/llama3`.
    expect(planner?.modelRef).toBeUndefined();
    // The role's own thinking default still travels per worker.
    expect(planner?.thinking).toBe('medium');
  });

  it('resolves the worker model as [roles.<r>].model, then the manager model (issue #202)', () => {
    const plan = planWorkerRoles({
      bridge: memBridge(twoRoleCwd()),
      cwd: CWD,
      agents: ['alpha', 'beta'],
      roles: { alpha: 'planner' },
      layers: [{ layer: 'project', roles: { planner: { model: 'acme/p1' } } }],
      parentModel: 'anthropic/claude',
    });
    const [planner, implementer] = plan.assignments;
    // The role's config pin outranks the manager's model for its own worker…
    expect(planner?.modelRef).toBe('acme/p1');
    // …and a role with no pin inherits the manager's effective model.
    expect(implementer?.modelRef).toBe('anthropic/claude');
  });

  it("the run's explicit thinking level outranks the role's own default (issue #202)", () => {
    const overridden = planWorkerRoles({
      bridge: memBridge(twoRoleCwd()),
      cwd: CWD,
      agents: ['alpha', 'beta'],
      thinkingOverride: 'xhigh',
    });
    expect(overridden.assignments.map((entry) => entry.thinking)).toEqual([
      'xhigh',
      'xhigh',
    ]);
    // Without an explicit level the defaults are per role, not one value for
    // every worker.
    const files = twoRoleCwd();
    files[`${CWD}/.kubic/roles/tester.md`] = roleText(
      'tester',
      WRITER,
      'You are the tester.',
    );
    const bare = planWorkerRoles({
      bridge: memBridge(files),
      cwd: CWD,
      agents: ['alpha', 'beta', 'gamma'],
      roles: { alpha: 'planner', beta: 'implementer', gamma: 'tester' },
    });
    expect(
      bare.assignments.map((entry) => [entry.role, entry.thinking]),
    ).toEqual([
      ['planner', 'medium'],
      ['implementer', 'medium'],
      ['tester', 'low'],
    ]);
  });

  it('refuses a contradictory role document by the resolver name, assigning nothing', () => {
    // `tools: [read, write]` under `filesystem: read` is the §40.3
    // contradiction: the run must refuse with the resolver's named reason,
    // never assign a role whose policy is self-contradictory.
    const files = twoRoleCwd();
    files[`${CWD}/.kubic/roles/planner.md`] = roleText(
      'planner',
      'tools: [read, write]\nfilesystem: read\nshell: false\nnetwork: none\ngit: false\ncredentials: none\n',
      'You claim to be read-only.',
    );
    const plan = planWorkerRoles({
      bridge: memBridge(files),
      cwd: CWD,
      agents: ['alpha', 'beta'],
      roles: TWO_ROLES.roles,
    });
    expect(plan.refused).toHaveLength(1);
    expect(plan.refused[0]?.name).toBe('planner');
    expect(plan.refused[0]?.reason).toContain("role 'planner'");
    expect(plan.refused[0]?.reason).toContain(
      "filesystem is 'read' but write tool 'write' is registered",
    );
    // Fail closed: the refused role's worker gets no assignment at all.
    expect(plan.assignments.map((entry) => entry.agentId)).toEqual(['beta']);
  });

  it('refuses a role document with no `## Prompt` section rather than composing an empty prompt', () => {
    const files = twoRoleCwd();
    files[`${CWD}/.kubic/roles/planner.md`] =
      `---\nrole: planner\n${READ_ONLY}---\n\n# planner\n\n## Responsibility\n\nPlan.\n`;
    const plan = planWorkerRoles({
      bridge: memBridge(files),
      cwd: CWD,
      agents: ['alpha'],
      roles: { alpha: 'planner' },
    });
    expect(plan.refused).toHaveLength(1);
    expect(plan.refused[0]?.reason).toContain("no '## Prompt' section");
    expect(plan.assignments).toEqual([]);
  });

  it('refuses when a worker maps to a role with no document, while an absent directory falls back to the presets', () => {
    // Two documents, three workers: the third is bound to a role name that is
    // neither a repo document nor a built-in. That is a configuration the
    // operator half-made, so it refuses by name — composing a prompt with no
    // role would silently ignore the documents that DO exist. A workspace
    // with no documents at all is a different case: the embedded presets
    // apply (pinned below), so the two must not be conflated.
    const plan = planWorkerRoles({
      bridge: memBridge(twoRoleCwd()),
      cwd: CWD,
      agents: ['alpha', 'beta', 'gamma'],
      roles: { alpha: 'planner', beta: 'implementer', gamma: 'archaeologist' },
    });
    expect(plan.assignments.map((entry) => entry.role)).toEqual([
      'planner',
      'implementer',
    ]);
    expect(plan.refused).toHaveLength(1);
    expect(plan.refused[0]?.name).toBe('archaeologist');
    expect(plan.refused[0]?.reason).toMatch(/unknown role 'archaeologist'/);
  });

  it('assigns the built-in presets when the workspace has no role documents (issue #203)', () => {
    // The five §12 roles ship WITH the binary: an absent `.kubic/roles/` no
    // longer means "no role". An unbound worker gets the default implementer
    // preset (issue #178), whose prompt and tool set come from the embedded
    // document — never from a repo-relative path.
    const plan = planWorkerRoles({
      bridge: memBridge({}),
      cwd: CWD,
      agents: ['alpha'],
    });
    expect(plan.refused).toEqual([]);
    expect(plan.assignments).toHaveLength(1);
    const assignment = plan.assignments[0];
    expect(assignment?.role).toBe('implementer');
    expect(assignment?.promptText).toContain('You are the implementer.');
    expect(assignment?.tools).toContain('write');
    expect(assignment?.tools).toContain('bash');
  });

  it('lets a repo document override its built-in preset, and only that one (issue #203)', () => {
    const plan = planWorkerRoles({
      bridge: memBridge({
        [`${CWD}/.kubic/roles/implementer.md`]: [
          '---',
          'role: implementer',
          'tools: [read, ls, find, grep]',
          'filesystem: read',
          'shell: false',
          'network: none',
          'git: false',
          'credentials: none',
          '---',
          '',
          '## Prompt',
          '',
          'You are the repo implementer.',
          '',
        ].join('\n'),
      }),
      cwd: CWD,
      agents: ['alpha', 'beta'],
      roles: { alpha: 'implementer', beta: 'planner' },
    });
    expect(plan.refused).toEqual([]);
    expect(plan.assignments.map((entry) => entry.role)).toEqual([
      'implementer',
      'planner',
    ]);
    // The override wins for its own name…
    expect(plan.assignments[0]?.promptText).toContain('repo implementer');
    expect([...(plan.assignments[0]?.tools ?? [])].sort()).toEqual([
      'find',
      'grep',
      'ls',
      'read',
    ]);
    // …and the untouched presets still come from the binary.
    expect(plan.assignments[1]?.promptText).toContain('You are the planner.');
  });

  it('withholds write/edit/bash for a read-only role by absence, never approval', () => {
    // §40: the role's resolved tool set is what the lane registers, so a
    // withheld tool is uncallable by construction — the guard's reason
    // names the absence, and no approval decider is consulted.
    const plan = planFor(['alpha'], { roles: { alpha: 'planner' } });
    const planner = plan.assignments[0];
    expect(planner).toBeDefined();
    const guard = createRoleToolGuard(
      planner?.role as string,
      planner?.tools as string[],
    );
    for (const tool of ['write', 'edit', 'bash']) {
      const verdict = guard({ toolCallId: 'call-1', toolName: tool, args: {} });
      expect(verdict).toEqual({
        block: {
          reason: expect.stringContaining('tool-absent'),
          terminate: false,
        },
      });
      expect(
        (verdict as { block: { reason: string } }).block.reason,
      ).not.toMatch(/approval/i);
    }
  });
});

// §58 enterprise policy on the manager side (issue #288): the workers' own
// `kubic run --role` refuses a role that declares a denied tool, so the
// manager's plan must refuse the same assignment up front — before a
// worktree or a process exists — instead of gating roles not at all.
describe('delegation-path role assignment under the enterprise tool policy (issue #288)', () => {
  const denyBash = resolveEffectivePolicy([
    { layer: 'enterprise', policy: { tools: { deny: ['bash'] } } },
  ]).policy;

  it('refuses the assignment of a role declaring a denied tool; the innocuous role stays assigned', () => {
    const plan = planWorkerRoles({
      bridge: memBridge(twoRoleCwd()),
      cwd: CWD,
      agents: ['alpha', 'beta'],
      roles: TWO_ROLES.roles,
      toolPolicy: denyBash,
    });
    // planner (read/ls/find/grep) passes a deny-only policy; the implementer
    // declares bash and is refused by name, its worker left unassigned.
    expect(plan.assignments.map((entry) => entry.role)).toEqual(['planner']);
    expect(plan.refused).toHaveLength(1);
    expect(plan.refused[0]?.name).toBe('implementer');
    expect(plan.refused[0]?.reason).toMatch(
      /role 'implementer'.*'bash' denied.*enterprise denial holds/,
    );
  });

  it('refuses nothing when the policy denies a tool no assigned role declares', () => {
    const plan = planWorkerRoles({
      bridge: memBridge(twoRoleCwd()),
      cwd: CWD,
      agents: ['alpha', 'beta'],
      roles: TWO_ROLES.roles,
      toolPolicy: resolveEffectivePolicy([
        { layer: 'enterprise', policy: { tools: { deny: ['git_push'] } } },
      ]).policy,
    });
    expect(plan.refused).toEqual([]);
    expect(plan.assignments.map((entry) => entry.role)).toEqual([
      'planner',
      'implementer',
    ]);
  });

  it('an allow list refuses a role tool outside it, and a policy with no tool gate leaves the plan alone', () => {
    const outside = planWorkerRoles({
      bridge: memBridge(twoRoleCwd()),
      cwd: CWD,
      agents: ['alpha', 'beta'],
      roles: TWO_ROLES.roles,
      toolPolicy: resolveEffectivePolicy([
        {
          layer: 'enterprise',
          policy: { tools: { allow: ['read', 'ls', 'find', 'grep'] } },
        },
      ]).policy,
    });
    expect(outside.assignments.map((entry) => entry.role)).toEqual(['planner']);
    expect(outside.refused.map((entry) => entry.name)).toEqual(['implementer']);
    const ungated = planWorkerRoles({
      bridge: memBridge(twoRoleCwd()),
      cwd: CWD,
      agents: ['alpha', 'beta'],
      roles: TWO_ROLES.roles,
      toolPolicy: resolveEffectivePolicy([
        { layer: 'enterprise', policy: { models: { allowed: ['faux/*'] } } },
      ]).policy,
    });
    expect(ungated.refused).toEqual([]);
    expect(ungated.assignments).toHaveLength(2);
  });

  it('judges a role AFTER the config [roles.<name>] layers: a layer narrowing the denied tool away keeps the assignment', () => {
    // `kubic run --role implementer` resolves the same layers, so a layer that
    // replaces the document's tool list with [read] passes the deny; the
    // manager must not refuse what the worker would accept.
    const layers = [
      {
        layer: 'project' as const,
        roles: { implementer: { tools: ['read'] } },
      },
    ];
    const layered = planWorkerRoles({
      bridge: memBridge(twoRoleCwd()),
      cwd: CWD,
      agents: ['alpha', 'beta'],
      roles: TWO_ROLES.roles,
      toolPolicy: denyBash,
      layers,
    });
    expect(layered.refused).toEqual([]);
    expect(layered.assignments.map((entry) => entry.role)).toEqual([
      'planner',
      'implementer',
    ]);
    expect(layered.assignments[1]?.tools).toEqual(['read']);
    // Control: without the layer the same policy refuses the implementer.
    const bare = planWorkerRoles({
      bridge: memBridge(twoRoleCwd()),
      cwd: CWD,
      agents: ['alpha', 'beta'],
      roles: TWO_ROLES.roles,
      toolPolicy: denyBash,
    });
    expect(bare.refused.map((entry) => entry.name)).toEqual(['implementer']);
  });

  it('loads every document under the same layers, so a layer that fixes a contradictory document is not refused', () => {
    // `tools: [read, write]` under `filesystem: read` contradicts (§40.3) on
    // its own; the config layer replaces the tool list, and `kubic run --role`
    // accepts the result — so must the manager's document load.
    const files = {
      [`${CWD}/.kubic/roles/planner.md`]: roleText(
        'planner',
        'tools: [read, write]\nfilesystem: read\nshell: false\nnetwork: none\ngit: false\ncredentials: none\n',
        'Plan it.',
      ),
    };
    const layers = [
      { layer: 'project' as const, roles: { planner: { tools: ['read'] } } },
    ];
    const layered = planWorkerRoles({
      bridge: memBridge(files),
      cwd: CWD,
      agents: ['alpha'],
      roles: { alpha: 'planner' },
      layers,
    });
    expect(layered.refused).toEqual([]);
    expect(layered.assignments.map((entry) => entry.tools)).toEqual([['read']]);
    // Control: the document alone is refused by name.
    const bare = planWorkerRoles({
      bridge: memBridge(files),
      cwd: CWD,
      agents: ['alpha'],
      roles: { alpha: 'planner' },
    });
    expect(bare.assignments).toEqual([]);
    expect(bare.refused[0]?.name).toBe('planner');
  });

  it('does not refuse the run over a denied role no worker is assigned to', () => {
    // One worker: only the planner is assigned. The implementer document
    // declares a denied tool but nobody runs it, so it must not refuse the
    // run (an enterprise deny gates grants, not the mere presence of a file).
    const plan = planWorkerRoles({
      bridge: memBridge(twoRoleCwd()),
      cwd: CWD,
      agents: ['alpha'],
      roles: { alpha: 'planner' },
      toolPolicy: denyBash,
    });
    expect(plan.refused).toEqual([]);
    expect(plan.assignments.map((entry) => entry.role)).toEqual(['planner']);
  });
});
