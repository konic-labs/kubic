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

function planFor(agents: readonly string[]): WorkerRolesPlan {
  return planWorkerRoles({
    bridge: memBridge(twoRoleCwd()),
    cwd: CWD,
    agents,
  });
}

describe('delegation-path role assignment (issue #104, §12)', () => {
  it('assigns each worker a role from the fixed five, deterministically', () => {
    // The five roles are fixed (D11): the manager composes from them and
    // never invents a role at runtime. Assignment is a pure function of the
    // agent order, so a --resume replays the same role per worker.
    expect(roleForAgent(['alpha', 'beta'], 'alpha')).toBe('planner');
    expect(roleForAgent(['alpha', 'beta'], 'beta')).toBe('implementer');
    expect(roleForAgent(['alpha', 'beta'], 'ghost')).toBeUndefined();
    expect(roleForAgent(['a', 'b', 'c', 'd', 'e', 'f'], 'f')).toBe('planner');
  });

  it('gives two role-assigned workers different prompts composed of role text + their step', () => {
    const plan = planFor(['alpha', 'beta']);
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

  it('carries the role-resolved tool set and the role model default', () => {
    const plan = planFor(['alpha', 'beta']);
    const [planner, implementer] = plan.assignments;
    // §12.1/§40: the tool set is the resolver's own resolved set.
    expect(planner?.tools).toEqual(['find', 'grep', 'ls', 'read']);
    expect(implementer?.tools).toContain('write');
    // §12.1 model default travels as the existing model-pin ref.
    expect(planner?.modelRef).toBe('local/llama3');
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
    });
    expect(plan.refused).toHaveLength(1);
    expect(plan.refused[0]?.reason).toContain("no '## Prompt' section");
    expect(plan.assignments).toEqual([]);
  });

  it('refuses when a worker maps to a role with no document, while zero documents stay a no-op', () => {
    // Two documents, three workers: the third maps to a role whose file is
    // absent. That is a configuration the operator half-made, so it refuses
    // by name — composing a prompt with no role would silently ignore the
    // documents that DO exist. Zero documents is the untouched default
    // (pinned above), so the two cases must not be conflated.
    const plan = planWorkerRoles({
      bridge: memBridge(twoRoleCwd()),
      cwd: CWD,
      agents: ['alpha', 'beta', 'gamma'],
    });
    expect(plan.assignments.map((entry) => entry.role)).toEqual([
      'planner',
      'implementer',
    ]);
    expect(plan.refused).toHaveLength(1);
    expect(plan.refused[0]?.name).toBe('tester');
    expect(plan.refused[0]?.reason).toMatch(/no role document for 'tester'/);
  });

  it('assigns no role at all when the workspace has no role documents', () => {
    // An absent `.kubic/roles/` is the normal case (the solo default is
    // unaffected) — the delegation path then keeps the plan prompt.
    const plan = planWorkerRoles({
      bridge: memBridge({}),
      cwd: CWD,
      agents: ['alpha'],
    });
    expect(plan).toEqual({ assignments: [], refused: [] });
  });

  it('withholds write/edit/bash for a read-only role by absence, never approval', () => {
    // §40: the role's resolved tool set is what the lane registers, so a
    // withheld tool is uncallable by construction — the guard's reason
    // names the absence, and no approval decider is consulted.
    const plan = planFor(['alpha']);
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
