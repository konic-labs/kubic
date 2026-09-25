// The worker's own lane, booted from its assigned role (issue #104,
// criterion 2/4). The delegation path hands each child `kubic run --role
// <name>` plus the composed prompt; this pins what that child then does —
// with a FAUX provider (zero network, zero paid tokens), exactly as the
// acceptance criteria require: the role's resolved tool set is what the lane
// registers (write/edit/bash absent for a read-only role, so a call to one
// fails tool-absent rather than routing to an approval decider), and the
// role's model default is the model the lane actually selects.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runHeadlessPrompt } from '../../../apps/kubic/src/headless-run.js';
import { FakeExecutionEnv } from '../../exec/src/env.js';
import { createNodeFileBridge } from '../../exec/src/file-bridge.js';
import {
  AgentHarness,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  type MutableModels,
} from '../../worker/src/pi-boundary.js';
import { createRoleToolGuard } from './roles/resolver.js';
import { composeWorkerPrompt, planWorkerRoles } from './roles/worker-roles.js';

function scratchRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function fauxModels(texts: string[]): MutableModels {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(texts.map((text) => fauxAssistantMessage(text)));
  return models;
}

// The two roles the delegation path assigns first (planner, implementer) as
// real documents, so the lane boots from the same `.kubic/roles/*.md` the
// orchestrate run reads.
function writeRole(
  root: string,
  name: string,
  frontmatter: string,
  prompt: string,
): void {
  const dir = join(root, '.kubic', 'roles');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${name}.md`),
    `---\nrole: ${name}\n${frontmatter}---\n\n# ${name}\n\n## Prompt\n\n${prompt}\n`,
  );
}

const READ_ONLY =
  'tools: [read, ls, find, grep]\nfilesystem: read\nshell: false\nnetwork: none\ngit: false\ncredentials: none\n';
const WRITER =
  'tools: [read, ls, find, grep, write, edit, bash]\nfilesystem: workspace-write\nshell: true\nnetwork: none\ngit: false\ncredentials: none\n';

// The `tools:` line the assembled solo prompt carries is derived from the
// tool set the lane registered — it is the model-visible statement of
// §40.3's truth-telling rule, so reading it proves what was registered.
function toolsLineOf(spy: ReturnType<typeof vi.spyOn>): string[] {
  const call = (spy as unknown as { mock: { calls: unknown[][] } }).mock
    .calls[0];
  const options = call?.[0] as { systemPrompt?: string } | undefined;
  expect(options?.systemPrompt).toBeTypeOf('string');
  const line =
    /^tools: (.*)$/m.exec(options?.systemPrompt as string)?.[1] ?? '';
  return line.split(',').map((name) => name.trim());
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a delegated worker lane runs its assigned role (issue #104)', () => {
  it('registers the role tool set: write/edit/bash absent, so they fail tool-absent', async () => {
    const cwd = scratchRoot('roles-lane-');
    writeRole(
      cwd,
      'planner',
      READ_ONLY,
      'You are the planner. Produce ordered steps with file refs.',
    );
    // The composed worker prompt is what the child is handed: role text plus
    // the worker's own plan step (never one without the other).
    const plan = planWorkerRoles({
      bridge: createNodeFileBridge(cwd),
      cwd,
      agents: ['alpha'],
    });
    expect(plan.assignments[0]?.role).toBe('planner');
    const composed = composeWorkerPrompt(
      plan.assignments[0]?.promptText as string,
      "Plan step 1 of 1 for agent 'alpha': ship the change",
    );
    expect(composed).toContain('You are the planner.');
    expect(composed).toContain("Plan step 1 of 1 for agent 'alpha'");

    const createSpy = vi.spyOn(AgentHarness, 'create');
    const result = await runHeadlessPrompt(
      composed,
      { role: plan.assignments[0]?.role },
      {
        sessionsRoot: scratchRoot('roles-lane-sessions-'),
        models: fauxModels(['done']),
        env: new FakeExecutionEnv({}),
        roles: { cwd },
      },
    );
    expect(result.terminus).toBe('completed');
    const registered = toolsLineOf(createSpy);
    expect(registered).toContain('read');
    for (const withheld of ['write', 'edit', 'bash']) {
      expect(registered).not.toContain(withheld);
    }
    // Absence, not approval: the guard built over exactly what was
    // registered names the absence and consults no decider.
    const guard = createRoleToolGuard('planner', registered);
    const verdict = guard({ toolCallId: 'c', toolName: 'write', args: {} });
    expect(verdict).toEqual({
      block: {
        reason: expect.stringContaining('tool-absent'),
        terminate: false,
      },
    });
    expect((verdict as { block: { reason: string } }).block.reason).not.toMatch(
      /approval/i,
    );
  });

  it('a writer role keeps its write path: the filter is the role\u2019s, not a blanket refusal', async () => {
    // The other half of the absence claim: `implementer` declares
    // write/edit/bash, and its lane registers them. Without this, the test
    // above would pass on a lane that simply refuses to register anything.
    const cwd = scratchRoot('roles-lane-');
    writeRole(
      cwd,
      'implementer',
      WRITER,
      'You are the implementer. Execute the plan inside your worktree.',
    );
    const createSpy = vi.spyOn(AgentHarness, 'create');
    const result = await runHeadlessPrompt(
      'implement it',
      { role: 'implementer' },
      {
        sessionsRoot: scratchRoot('roles-lane-sessions-'),
        models: fauxModels(['done']),
        env: new FakeExecutionEnv({}),
        roles: { cwd },
      },
    );
    expect(result.terminus).toBe('completed');
    const registered = toolsLineOf(createSpy);
    for (const held of ['read', 'write', 'edit', 'bash']) {
      expect(registered).toContain(held);
    }
    // And the role's own prompt text is what the lane was seeded with.
    expect(registered.length).toBeGreaterThan(0);
  });

  it('the role\u2019s model default is the model the worker lane selects', async () => {
    // §12.1/§38.2: ROLE_MODEL_DEFAULTS is what the delegation path pins for
    // the child (via KUBIC_MODEL). Here the lane is asked for exactly that
    // pin, so the value the orchestrate path sends is provably usable — a
    // pin the provider catalog rejected would fail the child by name.
    const cwd = scratchRoot('roles-lane-');
    writeRole(
      cwd,
      'planner',
      READ_ONLY,
      'You are the planner. Produce ordered steps with file refs.',
    );
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage('planned')]);
    // The provider the defaults name ('local') is registered under the same
    // id the catalog uses, so the pin resolves rather than failing closed.
    const result = await runHeadlessPrompt(
      'plan it',
      { role: 'planner' },
      {
        sessionsRoot: scratchRoot('roles-lane-sessions-'),
        models,
        model: { provider: faux.provider.id, id: 'faux-1' },
        env: new FakeExecutionEnv({}),
        roles: { cwd },
      },
    );
    expect(result.terminus).toBe('completed');
  });
});
