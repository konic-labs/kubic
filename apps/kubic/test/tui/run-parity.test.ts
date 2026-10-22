// Prod path: `kubic tui` boots "the same lane" as
// `kubic run` — so the interactive surface must carry the same context the
// headless one does: skills discovery, `--role` documents, journal
// retention, and the runtime exclude rules. And its deferred-settlement
// footer must stop blaming a missing TTY (there is one). Faux provider
// only: zero network.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OperationKillRegistry } from '@kubic/agent/lane/abort';
import {
  BACKGROUND_CONTEXT,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  type MutableModels,
} from '@kubic/agent/pi-boundary';
import { FakeExecutionEnv } from '@kubic/exec/test-support/fake-env';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { terminalRig } from '../../../../test/fake-terminal.js';
import { tempDir } from '../../../../test/temp-dir.js';
import { bootTuiLane } from '../../src/tui/boot.js';
import type { TuiRunDeps } from '../../src/tui/options.js';
import { runTuiCommand } from '../../src/tui/run.js';
import { TuiTurnRunner } from '../../src/tui/turn-runner.js';
import type { TuiLaneBoot } from '../../src/tui/types.js';

// The model-visible system prompt of one request. The durable lane
// materializes the assembled prompt at REQUEST time (a positional prompt
// section, not a boot argument), so the faux provider's own request context
// is where it can be observed.
function systemTextOf(context: unknown): string {
  const messages = (
    context as {
      messages?: readonly {
        role?: unknown;
        content?: unknown;
        sections?: Record<string, unknown>;
      }[];
    }
  ).messages;
  const system = messages?.find((message) => message.role === 'system');
  if (system === undefined) return '';
  const parts: string[] = [];
  if (typeof system.content === 'string' && system.content !== '') {
    parts.push(system.content);
  } else if (Array.isArray(system.content)) {
    for (const part of system.content) {
      if (
        typeof part === 'object' &&
        part !== null &&
        (part as { type?: unknown }).type === 'text' &&
        typeof (part as { text?: unknown }).text === 'string'
      ) {
        parts.push((part as { text: string }).text);
      }
    }
  }
  // The durable request carries the positional prompt sections beside the
  // base system message; the assembled prompt (skills, role) is one of
  // them.
  for (const section of Object.values(system.sections ?? {})) {
    if (typeof section === 'string' && section !== '') parts.push(section);
  }
  return parts.join('\n\n');
}

function fauxModels(texts: string[], captured: string[] = []): MutableModels {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(
    texts.map((text) => (context: unknown) => {
      captured.push(systemTextOf(context));
      return fauxAssistantMessage(text);
    }),
  );
  return models;
}

// One settled turn, then the prompt that request carried.
async function promptOf(
  boot: TuiLaneBoot,
  captured: string[],
): Promise<string> {
  const outcome = await boot.loop?.runTurn('hi', {
    requestId: `parity-${captured.length}`,
    context: BACKGROUND_CONTEXT,
    whenBusy: 'reject',
  });
  expect(outcome?.kind).toBe('completed');
  return captured.at(-1) ?? '';
}

function writeSkill(root: string, name: string, description: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'SKILL.md');
  writeFileSync(
    file,
    `---\nname: ${name}\ndescription: ${description}\n---\n\nBody for ${name}.\n`,
  );
  return file;
}

function writeRole(
  cwd: string,
  name: string,
  frontmatter: string,
  body: string,
): void {
  const dir = join(cwd, '.kubic', 'roles');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${name}.md`),
    `---\nrole: ${name}\n${frontmatter}---\n\n# ${name}\n\n## Prompt\n\n${body}\n`,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('skills reach the TUI lane', () => {
  it("injects a discovered skill's block into the TUI system prompt", async () => {
    const home = tempDir('tui-skills-home-');
    writeSkill(join(home, '.agents', 'skills'), 'deploy-widget', 'Ship it');
    const captured: string[] = [];
    const boot = await bootTuiLane(undefined, {
      sessionsRoot: tempDir('tui-skills-sessions-'),
      models: fauxModels(['done'], captured),
      env: new FakeExecutionEnv({}),
      skills: { homeDir: home, trusted: true },
    });
    const prompt = await promptOf(boot, captured);
    await boot.close?.();
    expect(prompt).toContain('<skills>');
    expect(prompt).toContain('<name>deploy-widget</name>');
    // Appended, never a replacement: the assembled base survives.
    expect(prompt).toContain('cwd:');
  });

  it('suppresses discovery under --no-skills, and an explicit skill still applies', async () => {
    const home = tempDir('tui-skills-home-');
    const skillFile = writeSkill(
      join(home, '.agents', 'skills'),
      'deploy-widget',
      'Ship it',
    );
    const suppressedCaptured: string[] = [];
    const suppressed = await bootTuiLane(undefined, {
      sessionsRoot: tempDir('tui-skills-sessions-'),
      models: fauxModels(['done'], suppressedCaptured),
      env: new FakeExecutionEnv({}),
      skills: { homeDir: home, trusted: true },
      noSkills: true,
    });
    expect(await promptOf(suppressed, suppressedCaptured)).not.toContain(
      '<skills>',
    );
    await suppressed.close?.();

    const explicitCaptured: string[] = [];
    const explicit = await bootTuiLane(undefined, {
      sessionsRoot: tempDir('tui-skills-sessions-'),
      models: fauxModels(['done'], explicitCaptured),
      env: new FakeExecutionEnv({}),
      skills: { homeDir: home, trusted: true },
      noSkills: true,
      // Explicit intent applies even under --no-skills (same rule as run).
      skillsList: [skillFile],
    });
    const prompt = await promptOf(explicit, explicitCaptured);
    await explicit.close?.();
    expect(prompt).toContain('<skills>');
    expect(prompt).toContain('<name>deploy-widget</name>');
  });
});

describe('role documents drive the TUI lane', () => {
  it('replaces the prompt and narrows the tool set on --role', async () => {
    const cwd = tempDir('tui-roles-cwd-');
    writeRole(
      cwd,
      'reviewer',
      'tools: [read, ls, find, grep]\nfilesystem: read\nshell: false\nnetwork: none\ngit: false\ncredentials: none\n',
      'You are the reviewer. Report findings.',
    );
    const captured: string[] = [];
    const boot = await bootTuiLane(undefined, {
      sessionsRoot: tempDir('tui-roles-sessions-'),
      models: fauxModels(['done'], captured),
      env: new FakeExecutionEnv({}),
      role: 'reviewer',
      roles: { cwd, trusted: true },
    });
    const prompt = await promptOf(boot, captured);
    await boot.close?.();
    expect(prompt).toContain('You are the reviewer. Report findings.');
    expect(prompt).not.toContain(
      'You are a coding agent working in a terminal.',
    );
    const toolsLine = /^tools: (.*)$/m.exec(prompt)?.[1] ?? '';
    expect(toolsLine).toContain('read');
    expect(toolsLine).not.toContain('write');
    expect(toolsLine).not.toContain('bash');
  });

  it('fails closed on an unknown role with the named refusal', async () => {
    const cwd = tempDir('tui-roles-cwd-');
    await expect(
      bootTuiLane(undefined, {
        sessionsRoot: tempDir('tui-roles-sessions-'),
        models: fauxModels(['done']),
        env: new FakeExecutionEnv({}),
        role: 'no-such-role',
        roles: { cwd, trusted: true },
      }),
    ).rejects.toThrow(/no role document for 'no-such-role'/);
  });
});

describe('lane projections reach the TUI lane', () => {
  // The same `runtimeLaneDeps` projection `kubic run` consumes: the TUI
  // lane must name itself and layer `--role` identically, or the shared
  // projection would have one consumer too many.
  it('names the lane from [agent].name in the assembled prompt metadata', async () => {
    const captured: string[] = [];
    const boot = await bootTuiLane(undefined, {
      sessionsRoot: tempDir('tui-agent-sessions-'),
      models: fauxModels(['done'], captured),
      env: new FakeExecutionEnv({}),
      agentId: 'kubic-tui',
    });
    expect(await promptOf(boot, captured)).toContain('agent=kubic-tui');
    await boot.close?.();

    // Unset: 'root' — the shipped attribution, unchanged.
    const bareCaptured: string[] = [];
    const bare = await bootTuiLane(undefined, {
      sessionsRoot: tempDir('tui-agent-bare-'),
      models: fauxModels(['done'], bareCaptured),
      env: new FakeExecutionEnv({}),
    });
    expect(await promptOf(bare, bareCaptured)).toContain('agent=root');
    await bare.close?.();
  });

  // The role's `[roles.<name>].model` is the selection default
  // for BOTH boots (the shared projection), which is why the TUI resolves
  // the role BEFORE selectModel.
  it('a role model layer selects the pinned model on the TUI lane', async () => {
    const cwd = tempDir('tui-role-model-cwd-');
    writeRole(
      cwd,
      'reviewer',
      'tools: [read, ls, find, grep]\nfilesystem: read\nshell: false\nnetwork: none\ngit: false\ncredentials: none\n',
      'You are the reviewer. Report findings.',
    );
    const models = fauxModels(['done']);
    const alt = fauxProvider({
      provider: 'alt',
      models: [{ id: 'm1', contextWindow: 100000 }],
    });
    alt.setResponses([fauxAssistantMessage('from alt')]);
    models.setProvider(alt.provider);
    const boot = await bootTuiLane(undefined, {
      sessionsRoot: tempDir('tui-role-model-sessions-'),
      models,
      env: new FakeExecutionEnv({}),
      role: 'reviewer',
      roles: {
        cwd,
        trusted: true,
        layers: [
          { layer: 'project', roles: { reviewer: { model: 'alt/m1' } } },
        ],
      },
    });
    try {
      // The default pick would be faux/echo (first registered); the role's
      // layer pin is the selection default, so alt/m1 answers.
      expect(boot.model).toBe('alt/m1');
    } finally {
      await boot.close?.();
    }
  });

  it('layers [roles.<name>] tools under the role document on --role', async () => {
    const cwd = tempDir('tui-layers-cwd-');
    writeRole(
      cwd,
      'reviewer',
      'tools: [read, ls, find, grep]\nfilesystem: read\nshell: false\nnetwork: none\ngit: false\ncredentials: none\n',
      'You are the reviewer. Report findings.',
    );
    const captured: string[] = [];
    const boot = await bootTuiLane(undefined, {
      sessionsRoot: tempDir('tui-layers-sessions-'),
      models: fauxModels(['done'], captured),
      env: new FakeExecutionEnv({}),
      role: 'reviewer',
      roles: {
        cwd,
        trusted: true,
        layers: [
          { layer: 'project', roles: { reviewer: { tools: ['read'] } } },
        ],
      },
    });
    const prompt = await promptOf(boot, captured);
    await boot.close?.();
    // The config layer's list replaces the document's broader one — the
    // same first-wins merge `kubic run` resolves through.
    const toolsLine = /^tools: (.*)$/m.exec(prompt)?.[1] ?? '';
    expect(toolsLine).toContain('read');
    expect(toolsLine).not.toContain('ls');
    expect(toolsLine).not.toContain('grep');
  });
});

describe('journal retention reaches the TUI store', () => {
  it('constructs the session journal with the configured retention', async () => {
    const sessionsRoot = tempDir('tui-retention-');
    const boot = await bootTuiLane(undefined, {
      sessionsRoot,
      models: fauxModels(['done']),
      env: new FakeExecutionEnv({}),
      // The window must be wider than an append's own latency: index
      // appends are fsynced, so the enforcement pass inside
      // `append` can run a millisecond or more after the caller read
      // Date.now() — a 1ms window dropped the just-written fresh entry.
      journalRetention: { maxAgeMs: 60_000 },
    });
    const journal = boot.journal;
    expect(journal).toBeDefined();
    if (journal === undefined) return;
    // Seed an aged entry, then append a fresh one: enforcement on append
    // prunes the aged entry — proving the boot's store carries the policy.
    journal.append({
      path: 'aged.txt',
      op: 'write',
      before: null,
      after: 'old\n',
      bytesDelta: 1,
      sessionId: 's1',
      toolCallId: null,
      timestamp: Date.now() - 3_600_000,
    });
    journal.append({
      path: 'fresh.txt',
      op: 'write',
      before: null,
      after: 'new\n',
      bytesDelta: 1,
      sessionId: 's1',
      toolCallId: null,
      timestamp: Date.now(),
    });
    const paths = journal.entries().map((e) => e.path);
    expect(paths).toContain('fresh.txt');
    expect(paths).not.toContain('aged.txt');
    await boot.close?.();
  });
});

describe('kubic tui parses the parity flags', () => {
  function fakeTerminal() {
    return terminalRig(100, 30);
  }

  async function waitFor(condition: () => boolean): Promise<void> {
    for (let i = 0; i < 200 && !condition(); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(condition()).toBe(true);
  }

  it('runs a --role turn behind the alt screen on the role lane', async () => {
    const cwd = tempDir('tui-roles-cwd-');
    writeRole(
      cwd,
      'reviewer',
      'tools: [read, ls, find, grep]\nfilesystem: read\nshell: false\nnetwork: none\ngit: false\ncredentials: none\n',
      'You are the reviewer. Report findings.',
    );
    const captured: string[] = [];
    const models = fauxModels(['findings reported'], captured);
    const sessionsRoot = tempDir('tui-roles-sessions-');
    const fake = fakeTerminal();
    const pending = runTuiCommand(
      { role: 'reviewer' },
      {
        out: () => {},
        createTerminal: () => fake.terminal,
        colorLevel: 'none',
        // The real lane boot, as the prod deps run it, on the faux model.
        bootLane: (sessionId, _answer, options) =>
          bootTuiLane(sessionId, {
            sessionsRoot,
            models,
            env: new FakeExecutionEnv({}),
            ...(options?.role === undefined ? {} : { role: options.role }),
            roles: { cwd, trusted: true },
          }),
      },
    );
    await waitFor(() => fake.counts.started === 1);
    // One key at a time: a multi-character feed reads as a paste.
    for (const ch of 'review this') fake.feed(ch);
    fake.feed('\r');
    for (
      let i = 0;
      i < 1000 && !fake.frame.includes('findings reported');
      i++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    expect(fake.frame).toContain('findings reported');
    // The turn the screen ran went out under the role's own prompt.
    expect(captured.at(-1)).toContain('You are the reviewer. Report findings.');
    expect(captured.at(-1)).not.toContain(
      'You are a coding agent working in a terminal.',
    );
    fake.feed('\x03');
    fake.feed('\x03');
    expect((await pending).exitCode).toBe(0);
  });

  it('passes --role, --skill and --no-skills to the boot', async () => {
    const lines: string[] = [];
    const fake = fakeTerminal();
    let captured:
      | { role?: string; noSkills?: boolean; skillsList?: string[] }
      | undefined;
    const deps: TuiRunDeps = {
      out: (line) => lines.push(line),
      createTerminal: () => fake.terminal,
      colorLevel: 'none',
      bootLane: async (
        sessionId?: string,
        _answer?: unknown,
        options?: { role?: string; noSkills?: boolean; skillsList?: string[] },
      ) => {
        captured = options;
        return { sessionId: sessionId ?? 's1', model: 'faux/test' };
      },
    };
    const pending = runTuiCommand(
      {
        role: 'planner',
        noSkills: true,
        skills: ['/tmp/one.md', '/tmp/two.md'],
      },
      deps,
    );
    await waitFor(() => fake.counts.started === 1);
    fake.feed('\x03');
    fake.feed('\x03');
    expect((await pending).exitCode).toBe(0);
    expect(captured).toEqual({
      role: 'planner',
      noSkills: true,
      skillsList: ['/tmp/one.md', '/tmp/two.md'],
    });
  });
});

describe('the TUI footer names the lane failure', () => {
  it('reports the failed turn message, never a TTY excuse', async () => {
    // The durable turn polls a deferred response inside generation, so
    // the runner's contract is simply: the lane's failure message reaches the
    // footer verbatim.
    const app = {
      applyLaneEntries: () => {},
      applyPresentation: () => {},
      presentationSeed: () => ({
        sessionId: 'sess-1',
        model: 'faux/faux-1',
        approvalsSkipped: false,
      }),
      setUsage: () => {},
    } as unknown as ConstructorParameters<typeof TuiTurnRunner>[0];
    const loop = {
      runTurn: async () => ({
        kind: 'failed' as const,
        reason: 'provider_transient' as const,
        error: 'the provider deferred the response and it never arrived',
      }),
      subscribe: async () => async () => {},
      entries: async () => [],
      abort: async () => {},
      forgetKills: () => {},
      killsKey: 'conversation',
      kills: new OperationKillRegistry(),
      context: BACKGROUND_CONTEXT,
    } as unknown as ConstructorParameters<typeof TuiTurnRunner>[1];
    const runner = new TuiTurnRunner(app, loop, 'faux/test');
    const outcome = await runner.run('hello');
    expect(outcome.status).toBe('failed');
    expect(outcome.detail).toBe(
      'the provider deferred the response and it never arrived',
    );
    // The TUI has a TTY, so a message blaming one would misstate the cause.
    expect(outcome.detail).not.toContain('TTY');
  });

  it("forgets a settled turn's kills, never an unsettled one's", async () => {
    // `forgetLaneKills` drains the conversation
    // key, so forgetting a failed turn would strip a still-live run's bash
    // process groups of their handles and a later quit could not kill them.
    let forgotten = 0;
    const loop = {
      runTurn: async () => ({
        kind: 'failed' as const,
        reason: 'provider_transient' as const,
        error: 'boom',
      }),
      subscribe: async () => async () => {},
      entries: async () => [],
      abort: async () => {},
      forgetKills: () => {
        forgotten += 1;
      },
      killsKey: 'conversation',
      kills: new OperationKillRegistry(),
      context: BACKGROUND_CONTEXT,
    } as unknown as ConstructorParameters<typeof TuiTurnRunner>[1];
    const app = {
      applyLaneEntries: () => {},
      applyPresentation: () => {},
      presentationSeed: () => ({
        sessionId: 'sess-1',
        model: 'faux/faux-1',
        approvalsSkipped: false,
      }),
      setUsage: () => {},
    } as unknown as ConstructorParameters<typeof TuiTurnRunner>[0];
    const runner = new TuiTurnRunner(app, loop, 'faux/test');
    expect((await runner.run('fails')).status).toBe('failed');
    expect(forgotten).toBe(0);
    // Control: a settled turn does forget — a kept background job outlives
    // Kubic and must not be signalled by the session close.
    loop.runTurn = async () => ({
      kind: 'completed' as const,
      submissionId: 'sub-1',
    });
    expect((await runner.run('settles')).status).toBe('completed');
    expect(forgotten).toBe(1);
  });

  it('names the busy refusal the durable turn reports', async () => {
    const app = {
      applyLaneEntries: () => {},
      applyPresentation: () => {},
      presentationSeed: () => ({
        sessionId: 'sess-1',
        model: 'faux/faux-1',
        approvalsSkipped: false,
      }),
      setUsage: () => {},
    } as unknown as ConstructorParameters<typeof TuiTurnRunner>[0];
    const loop = {
      runTurn: async () => ({
        kind: 'failed' as const,
        reason: 'busy' as const,
        error: 'conversation 1 is busy',
      }),
      subscribe: async () => async () => {},
      entries: async () => [],
      abort: async () => {},
      forgetKills: () => {},
      killsKey: 'conversation',
      kills: new OperationKillRegistry(),
      context: BACKGROUND_CONTEXT,
    } as unknown as ConstructorParameters<typeof TuiTurnRunner>[1];
    const runner = new TuiTurnRunner(app, loop, 'faux/test');
    const outcome = await runner.run('hello');
    expect(outcome.status).toBe('failed');
    expect(outcome.detail).toBe(
      'lane refused the prompt: conversation 1 is busy',
    );
  });
});
