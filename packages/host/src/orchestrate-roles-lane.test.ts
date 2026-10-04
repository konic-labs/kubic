// The worker's own lane, booted from its assigned role (issue #104,
// criterion 2/4). The delegation path hands each child `kubic run --role
// <name>` plus the composed prompt; this pins what that child then does —
// with a FAUX provider (zero network, zero paid tokens), exactly as the
// acceptance criteria require: the role's resolved tool set is what the lane
// registers (write/edit/bash absent for a read-only role, so a call to one
// fails tool-absent rather than routing to an approval decider), and the
// role's model default is the model the lane actually selects.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runHeadlessPrompt } from '../../../apps/kubic/src/headless-run.js';
import { FakeExecutionEnv } from '../../exec/src/env.js';
import { createNodeFileBridge } from '../../exec/src/file-bridge.js';
import {
  attachSession,
  openSessionStore,
} from '../../worker/src/lane/session-store.js';
import { SOLO_PROMPT_SECTION } from '../../worker/src/lane/solo.js';
import { readSessionEntries } from '../../worker/src/lane/transcript.js';
import {
  BACKGROUND_CONTEXT,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  type MutableModels,
  SystemEntry,
} from '../../worker/src/pi-boundary.js';
import { createRoleToolGuard } from './roles/resolver.js';
import { ROLE_MODEL_DEFAULTS } from './roles/roles-data.js';
import { composeWorkerPrompt, planWorkerRoles } from './roles/worker-roles.js';

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
// The solo prompt the lane committed for this session (#400's reader): the
// run's own durable record of the bytes the model saw.
async function committedPrompt(
  root: string,
  sessionId: string,
): Promise<string> {
  const store = openSessionStore(root, createNodeFileBridge(root));
  const session = await attachSession(store, sessionId, BACKGROUND_CONTEXT);
  try {
    const entries = await readSessionEntries(
      session.storage,
      BACKGROUND_CONTEXT,
    );
    for (const entry of [...entries].reverse()) {
      if (!SystemEntry.is(entry)) continue;
      const messages = entry.model as unknown as
        | Array<{ sections?: Record<string, string | null> }>
        | undefined;
      const prompt = messages?.[0]?.sections?.[SOLO_PROMPT_SECTION];
      if (typeof prompt === 'string' && prompt !== '') return prompt;
    }
    return '';
  } finally {
    await session.release(BACKGROUND_CONTEXT);
  }
}

// The `tools:` line the assembled solo prompt carries is derived from the
// tool set the lane registered — it is the model-visible statement of
// §40.3's truth-telling rule, so reading it proves what was registered.
function toolsLineOf(prompt: string): string[] {
  const line = /^tools: (.*)$/m.exec(prompt)?.[1] ?? '';
  return line.split(',').map((name) => name.trim());
}

// The solo no-isolation notice is pinned by solo-notice-prod.test.ts; here it
// would only be stderr noise, so the documented opt-out silences it.
beforeEach(() => {
  vi.stubEnv('KUBIC_NO_NOTICE', '1');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
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

    const root = scratchRoot('roles-lane-sessions-');
    const result = await runHeadlessPrompt(
      composed,
      { role: plan.assignments[0]?.role },
      {
        sessionsRoot: root,
        models: fauxModels(['done']),
        env: new FakeExecutionEnv({}),
        roles: { cwd },
      },
    );
    expect(result.terminus).toBe('completed');
    const prompt = await committedPrompt(root, result.sessionId);
    const registered = toolsLineOf(prompt);
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
    const root = scratchRoot('roles-lane-sessions-');
    const result = await runHeadlessPrompt(
      'implement it',
      { role: 'implementer' },
      {
        sessionsRoot: root,
        models: fauxModels(['done']),
        env: new FakeExecutionEnv({}),
        roles: { cwd },
      },
    );
    expect(result.terminus).toBe('completed');
    const prompt = await committedPrompt(root, result.sessionId);
    const registered = toolsLineOf(prompt);
    for (const held of ['read', 'write', 'edit', 'bash']) {
      expect(registered).toContain(held);
    }
    // And the role's own prompt text is what the lane was seeded with.
    expect(prompt).toContain(
      'You are the implementer. Execute the plan inside your worktree.',
    );
  });

  it('the role\u2019s model default is the model the worker lane selects', async () => {
    // §12.1/§38.2: ROLE_MODEL_DEFAULTS is what the delegation path pins for
    // the child (via KUBIC_MODEL, which the child's composition root turns
    // into the explicit model selection). Here the lane is handed exactly
    // that pin, and the provider records the model it was actually called
    // with — so the value the orchestrate path sends is provably the one
    // the lane selects, not merely a pin that happened not to fail.
    const cwd = scratchRoot('roles-lane-');
    writeRole(
      cwd,
      'planner',
      READ_ONLY,
      'You are the planner. Produce ordered steps with file refs.',
    );
    const plan = planWorkerRoles({
      bridge: createNodeFileBridge(cwd),
      cwd,
      agents: ['alpha'],
    });
    const pin = plan.assignments[0]?.modelRef as string;
    const defaults = ROLE_MODEL_DEFAULTS.planner;
    expect(pin).toBe(`${defaults.provider}/${defaults.model}`);
    // A faux provider registered under the id the defaults name, serving the
    // model they name, so the pin resolves rather than failing closed.
    const faux = fauxProvider({
      provider: defaults.provider,
      models: [{ id: defaults.model }],
    });
    const models = createModels();
    models.setProvider(faux.provider);
    const called: string[] = [];
    faux.setResponses([
      (_context, _options, _state, model) => {
        called.push(`${model.provider}/${model.id}`);
        return fauxAssistantMessage('planned');
      },
    ]);
    const result = await runHeadlessPrompt(
      'plan it',
      { role: 'planner' },
      {
        sessionsRoot: scratchRoot('roles-lane-sessions-'),
        models,
        model: { provider: defaults.provider, id: defaults.model },
        env: new FakeExecutionEnv({}),
        roles: { cwd },
      },
    );
    expect(result.terminus).toBe('completed');
    expect(called).toEqual([pin]);
  });
});
