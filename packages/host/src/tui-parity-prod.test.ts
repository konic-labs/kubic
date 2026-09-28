// Issue #113, prod path: `kubic tui` boots "the same solo lane" as
// `kubic run` — so the interactive surface must carry the same context the
// headless one does: skills discovery, `--role` documents, journal
// retention, and the runtime exclude rules. And its deferred-settlement
// footer must stop blaming a missing TTY (there is one). Faux provider
// only: zero network.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  bootTuiLane,
  runTuiCommand,
  type TuiRunDeps,
  TuiTurnRunner,
} from '../../../apps/kubic/src/tui-run.js';
import { FakeExecutionEnv } from '../../exec/src/env.js';
import { OperationKillRegistry } from '../../worker/src/lane/abort.js';
import { driveToSettled, type SoloLane } from '../../worker/src/lane/solo.js';
import {
  AgentHarness,
  BACKGROUND_CONTEXT,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  type MutableModels,
} from '../../worker/src/pi-boundary.js';

const made: string[] = [];

function tmpRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

function fauxModels(texts: string[]): MutableModels {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(texts.map((text) => fauxAssistantMessage(text)));
  return models;
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

function promptOf(spy: ReturnType<typeof vi.spyOn>): string {
  const calls = (spy as unknown as { mock: { calls: unknown[][] } }).mock.calls;
  const options = (calls.at(-1)?.[0] ?? undefined) as
    | { systemPrompt?: string }
    | undefined;
  expect(options?.systemPrompt).toBeTypeOf('string');
  return options?.systemPrompt as string;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe('skills reach the TUI lane (issue #113, §29.3)', () => {
  it("injects a discovered skill's block into the TUI system prompt", async () => {
    const home = tmpRoot('tui-skills-home-');
    writeSkill(join(home, '.agents', 'skills'), 'deploy-widget', 'Ship it');
    const createSpy = vi.spyOn(AgentHarness, 'create');
    const boot = await bootTuiLane(undefined, {
      sessionsRoot: tmpRoot('tui-skills-sessions-'),
      models: fauxModels(['done']),
      env: new FakeExecutionEnv({}),
      skills: { homeDir: home, trusted: true },
    });
    await boot.close?.();
    const prompt = promptOf(createSpy);
    expect(prompt).toContain('<skills>');
    expect(prompt).toContain('<name>deploy-widget</name>');
    // Appended, never a replacement: the assembled base survives.
    expect(prompt).toContain('cwd:');
  });

  it('suppresses discovery under --no-skills, and an explicit skill still applies', async () => {
    const home = tmpRoot('tui-skills-home-');
    const skillFile = writeSkill(
      join(home, '.agents', 'skills'),
      'deploy-widget',
      'Ship it',
    );
    const createSpy = vi.spyOn(AgentHarness, 'create');
    const suppressed = await bootTuiLane(undefined, {
      sessionsRoot: tmpRoot('tui-skills-sessions-'),
      models: fauxModels(['done']),
      env: new FakeExecutionEnv({}),
      skills: { homeDir: home, trusted: true },
      noSkills: true,
    });
    await suppressed.close?.();
    expect(promptOf(createSpy)).not.toContain('<skills>');

    const explicit = await bootTuiLane(undefined, {
      sessionsRoot: tmpRoot('tui-skills-sessions-'),
      models: fauxModels(['done']),
      env: new FakeExecutionEnv({}),
      skills: { homeDir: home, trusted: true },
      noSkills: true,
      // Explicit intent applies even under --no-skills (same rule as run).
      skillsList: [skillFile],
    });
    await explicit.close?.();
    const prompt = promptOf(createSpy);
    expect(prompt).toContain('<skills>');
    expect(prompt).toContain('<name>deploy-widget</name>');
  });
});

describe('role documents drive the TUI lane (issue #113, §12.1)', () => {
  it('replaces the solo prompt and narrows the tool set on --role', async () => {
    const cwd = tmpRoot('tui-roles-cwd-');
    writeRole(
      cwd,
      'reviewer',
      'tools: [read, ls, find, grep]\nfilesystem: read\nshell: false\nnetwork: none\ngit: false\ncredentials: none\n',
      'You are the reviewer. Report findings.',
    );
    const createSpy = vi.spyOn(AgentHarness, 'create');
    const boot = await bootTuiLane(undefined, {
      sessionsRoot: tmpRoot('tui-roles-sessions-'),
      models: fauxModels(['done']),
      env: new FakeExecutionEnv({}),
      role: 'reviewer',
      roles: { cwd },
    });
    await boot.close?.();
    const prompt = promptOf(createSpy);
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
    const cwd = tmpRoot('tui-roles-cwd-');
    await expect(
      bootTuiLane(undefined, {
        sessionsRoot: tmpRoot('tui-roles-sessions-'),
        models: fauxModels(['done']),
        env: new FakeExecutionEnv({}),
        role: 'no-such-role',
        roles: { cwd },
      }),
    ).rejects.toThrow(/no role document for 'no-such-role'/);
  });
});

describe('solo-lane projections reach the TUI lane (issue #133)', () => {
  // The same `runtimeLaneDeps` projection `kubic run` consumes: the TUI
  // lane must name itself and layer `--role` identically, or the shared
  // projection would have one consumer too many.
  it('names the lane from [agent].name in the assembled prompt metadata', async () => {
    const createSpy = vi.spyOn(AgentHarness, 'create');
    const boot = await bootTuiLane(undefined, {
      sessionsRoot: tmpRoot('tui-agent-sessions-'),
      models: fauxModels(['done']),
      env: new FakeExecutionEnv({}),
      agentId: 'kubic-tui',
    });
    await boot.close?.();
    expect(promptOf(createSpy)).toContain('agent=kubic-tui');

    // Unset: 'root' — the shipped attribution, unchanged.
    createSpy.mockClear();
    const bare = await bootTuiLane(undefined, {
      sessionsRoot: tmpRoot('tui-agent-bare-'),
      models: fauxModels(['done']),
      env: new FakeExecutionEnv({}),
    });
    await bare.close?.();
    expect(promptOf(createSpy)).toContain('agent=root');
  });

  it('layers [roles.<name>] tools under the role document on --role', async () => {
    const cwd = tmpRoot('tui-layers-cwd-');
    writeRole(
      cwd,
      'reviewer',
      'tools: [read, ls, find, grep]\nfilesystem: read\nshell: false\nnetwork: none\ngit: false\ncredentials: none\n',
      'You are the reviewer. Report findings.',
    );
    const createSpy = vi.spyOn(AgentHarness, 'create');
    const boot = await bootTuiLane(undefined, {
      sessionsRoot: tmpRoot('tui-layers-sessions-'),
      models: fauxModels(['done']),
      env: new FakeExecutionEnv({}),
      role: 'reviewer',
      roles: {
        cwd,
        layers: [
          { layer: 'project', roles: { reviewer: { tools: ['read'] } } },
        ],
      },
    });
    await boot.close?.();
    // The config layer's list replaces the document's broader one — the
    // same first-wins merge `kubic run` resolves through.
    const toolsLine = /^tools: (.*)$/m.exec(promptOf(createSpy))?.[1] ?? '';
    expect(toolsLine).toContain('read');
    expect(toolsLine).not.toContain('ls');
    expect(toolsLine).not.toContain('grep');
  });
});

describe('journal retention reaches the TUI store (issue #113, §42.4)', () => {
  it('constructs the session journal with the configured retention', async () => {
    const sessionsRoot = tmpRoot('tui-retention-');
    const boot = await bootTuiLane(undefined, {
      sessionsRoot,
      models: fauxModels(['done']),
      env: new FakeExecutionEnv({}),
      // The window must be wider than an append's own latency: index
      // appends are fsynced (issue #117), so the enforcement pass inside
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
      agentId: 'root',
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
      agentId: 'root',
      toolCallId: null,
      timestamp: Date.now(),
    });
    const paths = journal.entries().map((e) => e.path);
    expect(paths).toContain('fresh.txt');
    expect(paths).not.toContain('aged.txt');
    await boot.close?.();
  });
});

describe('kubic tui parses the parity flags (issue #113)', () => {
  function fakeTerminal() {
    const writes: string[] = [];
    const counts = { started: 0, stopped: 0 };
    let onInput: ((data: string) => void) | undefined;
    return {
      writes,
      counts,
      terminal: {
        start: (input: (data: string) => void) => {
          counts.started += 1;
          onInput = input;
        },
        stop: () => {
          counts.stopped += 1;
        },
        drainInput: () => Promise.resolve(),
        write: (data: string) => writes.push(data),
        get columns() {
          return 100;
        },
        get rows() {
          return 30;
        },
        get kittyProtocolActive() {
          return false;
        },
        moveBy: () => {},
        hideCursor: () => {},
        showCursor: () => {},
        clearLine: () => {},
        clearFromCursor: () => {},
        clearScreen: () => {},
        setTitle: () => {},
        setProgress: () => {},
      },
      feed: (data: string): void => {
        onInput?.(data);
      },
    };
  }

  async function waitFor(condition: () => boolean): Promise<void> {
    for (let i = 0; i < 200 && !condition(); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(condition()).toBe(true);
  }

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
    expect(await pending).toBe(0);
    expect(captured).toEqual({
      role: 'planner',
      noSkills: true,
      skillsList: ['/tmp/one.md', '/tmp/two.md'],
    });
  });
});

describe('TUI deferred-settlement footer is honest (issue #113)', () => {
  it('names the deferral instead of blaming a missing TTY', async () => {
    const mockDrive = vi.mocked(driveToSettled);
    mockDrive.mockResolvedValue({
      kind: 'waiting-deferred',
      operationId: 'op-1',
      deferred: {} as never,
    });
    const app = {
      applyLaneEntries: () => {},
      applyLaneEvent: () => {},
      setUsage: () => {},
    } as unknown as ConstructorParameters<typeof TuiTurnRunner>[0];
    const loop = {
      accept: async () => ({
        ok: true as const,
        value: { operationId: 'op-1', kind: 'run' as const, startedAt: 0 },
      }),
      lane: {} as never,
      requestAbort: async () => ({
        ok: true as const,
        value: { operationId: 'op-1', newlyRequested: true },
      }),
      findEntries: async () => [],
      events: { on: () => () => {} },
      kills: new OperationKillRegistry(),
      context: BACKGROUND_CONTEXT,
    } as unknown as ConstructorParameters<typeof TuiTurnRunner>[1];
    const runner = new TuiTurnRunner(app, loop, 'faux/test');
    const outcome = await runner.run('hello');
    expect(outcome.status).toBe('failed');
    expect(outcome.detail).toBeDefined();
    // The TUI HAS a TTY — the old message lied about the cause.
    expect(outcome.detail).not.toContain('TTY');
    expect(outcome.detail).toContain('deferred');
  });
});

// Keep the SoloLane import honest: the mock below replaces only
// driveToSettled so the deferred-footer test stays at the runner seam.
vi.mock('../../worker/src/lane/solo.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../worker/src/lane/solo.js')>();
  return {
    ...actual,
    driveToSettled: vi.fn(),
  };
});
void ({} as SoloLane | undefined);
