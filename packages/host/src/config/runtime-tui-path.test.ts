// Config → live TUI path (issue #294): `kubic tui` spreads the SAME
// runtimeLaneDeps projection `kubic run` consumes into tuiDepsWithDefaults,
// which used to keep only the policy/journal keys — so `[agent].name` and
// the `[roles.<name>]` layers never reached bootTuiLane. These drive the
// production deps builder (tuiDepsWithDefaults) with the same fixtures as the
// #133 run tests (runtime-run-path.test.ts).
//
// Faux provider only: zero network, zero paid tokens.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  runtimeLaneDeps,
  runtimeModelPin,
} from '../../../../apps/kubic/src/config-runtime.js';
import {
  bootTuiLane,
  runTuiCommand,
  type TuiRunOptions,
  tuiDepsWithDefaults,
} from '../../../../apps/kubic/src/tui-run.js';
import { NodeExecutionEnv } from '../../../exec/src/env.js';
import { FileJournalStore } from '../../../exec/src/journal.js';
import { driveToSettled } from '../../../worker/src/lane/solo.js';
import {
  AgentHarness,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type MutableModels,
} from '../../../worker/src/pi-boundary.js';
import { runJournalCommand } from '../journal-cli.js';
import { auditLedgerDir, readAuditLedger } from '../policy/audit-ledger.js';
import { RUN_EXIT_PROVIDER_PROBE_FAILED } from '../run-cli.js';
import { loadRuntimeConfig, type RuntimeConfig } from './runtime.js';

const tempDirs: string[] = [];

function tmpRoot(prefix = 'kubic-294-tui-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

beforeEach(() => {
  vi.stubEnv('KUBIC_NO_NOTICE', '1');
  vi.stubEnv('KUBIC_WORKER_ID', undefined);
  vi.stubEnv('KUBIC_APPROVALS_DIR', undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const NO_SPLIT = { missing: [], checked: [], applicable: false };

function namedRuntime(
  workspace: string,
  toml: string,
  env: Record<string, string> = {},
): RuntimeConfig {
  return loadRuntimeConfig({
    bridge: {
      exists: (path: string): boolean =>
        path === `${workspace}/.kubic/config.toml`,
      readTextFile: (): string => toml,
    },
    home: '/nonexistent-home',
    cwd: workspace,
    enterprisePath: '/nonexistent/config.toml',
    projectTrusted: true,
    env,
  });
}

function laneFor(workspace: string, toml: string) {
  return runtimeLaneDeps({
    runtime: namedRuntime(workspace, toml),
    error: undefined,
    ignoreSplit: NO_SPLIT,
  });
}

// The prod boot, re-rooted onto temp state: whatever the deps builder
// forwards reaches the real bootTuiLane unchanged.
function rerooted(
  workspace: string,
  sessionsRoot: string,
  models: MutableModels,
): typeof bootTuiLane {
  return (sessionId?: string, options: TuiRunOptions = {}) =>
    bootTuiLane(sessionId, {
      ...options,
      sessionsRoot,
      models,
      env: new NodeExecutionEnv(workspace),
      skills: { homeDir: workspace, cwd: workspace, trusted: false },
      roles: { ...options.roles, cwd: workspace },
    });
}

describe('tuiDepsWithDefaults forwards the lane projection (issue #294)', () => {
  it('forwards agentId and roles to the boot', async () => {
    const layers = [
      {
        layer: 'project' as const,
        roles: { implementer: { tools: ['read'] } },
      },
    ];
    let seen: TuiRunOptions | undefined;
    const deps = tuiDepsWithDefaults(
      { out: () => {}, agentId: 'alice', roles: { layers } },
      async (_id, options) => {
        seen = options;
        return { sessionId: 's', model: 'faux/m' };
      },
    );
    await deps.bootLane(undefined, undefined, { role: 'implementer' });
    expect(seen?.agentId).toBe('alice');
    expect(seen?.roles).toEqual({ layers });
    expect(seen?.role).toBe('implementer');
  });

  it('attributes TUI journal entries to [agent].name, so diff --agent finds them', async () => {
    const sessionsRoot = tmpRoot();
    const workspace = tmpRoot('kubic-294-agent-');
    writeFileSync(join(workspace, 'note.txt'), 'v1\n');
    const lane = laneFor(workspace, '[agent]\nname = "foo"\n');
    expect(lane.agentId).toBe('foo');
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall('bash', { command: 'printf "v2\\n" > note.txt' }),
      ]),
      fauxAssistantMessage('mutated'),
    ]);
    const deps = tuiDepsWithDefaults(
      { out: () => {}, ...lane },
      rerooted(workspace, sessionsRoot, models),
    );
    const boot = await deps.bootLane();
    const loop = boot.loop;
    if (loop === undefined) throw new Error('the prod boot returned no loop');
    const admitted = await loop.accept('mutate note.txt', loop.context);
    if (!admitted.ok) throw new Error('prompt refused');
    await driveToSettled(loop.lane, admitted.value.operationId, loop.context);
    await boot.close?.();
    const entries = new FileJournalStore(
      join(sessionsRoot, boot.sessionId, 'journal'),
    ).entries();
    expect(entries.length).toBeGreaterThan(0);
    expect([...new Set(entries.map((entry) => entry.agentId))]).toEqual([
      'foo',
    ]);
    const named: string[] = [];
    expect(
      await runJournalCommand(
        { command: 'diff', agent: 'foo', session: boot.sessionId },
        { root: workspace, sessionsRoot, out: (line) => named.push(line) },
      ),
    ).toBe(0);
    expect(named.join('\n')).toContain('note.txt');
  });

  it('layers config [roles.implementer] tools under the document on kubic tui --role', async () => {
    const sessionsRoot = tmpRoot();
    const workspace = tmpRoot('kubic-294-roles-');
    mkdirSync(join(workspace, '.kubic', 'roles'), { recursive: true });
    writeFileSync(
      join(workspace, '.kubic', 'roles', 'implementer.md'),
      '---\nrole: implementer\ntools: [read, ls, write, bash]\n---\n## Prompt\n\nImplement the step.\n',
    );
    const lane = laneFor(workspace, '[roles.implementer]\ntools = ["read"]\n');
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage('done')]);
    const createSpy = vi.spyOn(AgentHarness, 'create');
    const deps = tuiDepsWithDefaults(
      { out: () => {}, ...lane },
      rerooted(workspace, sessionsRoot, models),
    );
    const boot = await deps.bootLane(undefined, undefined, {
      role: 'implementer',
    });
    await boot.close?.();
    const calls = (createSpy as unknown as { mock: { calls: unknown[][] } })
      .mock.calls;
    const prompt =
      (calls.at(-1)?.[0] as { systemPrompt?: string } | undefined)
        ?.systemPrompt ?? '';
    const toolsLine = /^tools: (.*)$/m.exec(prompt)?.[1] ?? '';
    expect(toolsLine).toContain('read');
    expect(toolsLine).not.toContain('write');
    expect(toolsLine).not.toContain('bash');
  });
});

// Two models on one provider: 'a' is the first-available pick, so a boot
// that ignores the pin lands on fx/a and the assertions below catch it.
function twoModels(): MutableModels {
  const faux = fauxProvider({
    provider: 'fx',
    models: [{ id: 'a' }, { id: 'b' }],
  });
  faux.setResponses([fauxAssistantMessage('done')]);
  const models = createModels();
  models.setProvider(faux.provider);
  return models;
}

function recordingTerminal() {
  const writes: string[] = [];
  const counts = { started: 0 };
  let handler: ((data: string) => void) | undefined;
  return {
    writes,
    counts,
    feed: (data: string) => handler?.(data),
    terminal: {
      start: (input: (data: string) => void) => {
        counts.started += 1;
        handler = input;
      },
      stop: () => {},
      drainInput: () => Promise.resolve(),
      write: (data: string) => writes.push(data),
      get columns(): number {
        return 100;
      },
      get rows(): number {
        return 30;
      },
      get kittyProtocolActive(): boolean {
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
  };
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !condition(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  expect(condition()).toBe(true);
}

describe('the TUI selects the pinned model (issue #295)', () => {
  beforeEach(() => {
    vi.stubEnv('KUBIC_PROVIDER', undefined);
  });

  function tuiWith(
    workspace: string,
    toml: string,
    env: Record<string, string> = {},
  ) {
    const cliConfig = {
      runtime: namedRuntime(workspace, toml, env),
      error: undefined,
      ignoreSplit: NO_SPLIT,
    };
    const lines: string[] = [];
    const errs: string[] = [];
    const fake = recordingTerminal();
    const deps = {
      ...tuiDepsWithDefaults(
        {
          out: (line: string) => lines.push(line),
          err: (line: string) => errs.push(line),
          model: runtimeModelPin(cliConfig),
          ...runtimeLaneDeps(cliConfig),
        },
        rerooted(workspace, tmpRoot(), twoModels()),
      ),
      createTerminal: () => fake.terminal,
    };
    return { deps, fake, lines, errs };
  }

  it('boots on the [model] pin and shows it in the header and status bar', async () => {
    const workspace = tmpRoot();
    const { deps, fake, lines } = tuiWith(
      workspace,
      '[model]\nprovider = "fx"\nid = "b"\n',
    );
    const exit = runTuiCommand({}, deps);
    await waitFor(() => fake.writes.join('').includes('fx/b'));
    fake.feed('\x1b');
    expect(await exit).toBe(0);
    const doc = lines.join('\n');
    // Header (`solo · fx/b`) and status bar both name the pinned model.
    expect(doc).toMatch(/solo · fx\/b/);
    expect(doc.match(/fx\/b/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(doc).not.toContain('fx/a');
  });

  it('KUBIC_MODEL overrides the config pin', async () => {
    const workspace = tmpRoot();
    const { deps, fake, lines } = tuiWith(
      workspace,
      '[model]\nprovider = "fx"\nid = "a"\n',
      { KUBIC_MODEL: 'fx/b' },
    );
    const exit = runTuiCommand({}, deps);
    await waitFor(() => fake.counts.started === 1);
    fake.feed('\x1b');
    expect(await exit).toBe(0);
    expect(lines.join('\n')).toContain('fx/b');
    expect(lines.join('\n')).not.toContain('fx/a');
  });

  it('a --role whose layer pins a model selects it; an explicit pin still wins', async () => {
    const workspace = tmpRoot();
    mkdirSync(join(workspace, '.kubic', 'roles'), { recursive: true });
    writeFileSync(
      join(workspace, '.kubic', 'roles', 'implementer.md'),
      '---\nrole: implementer\ntools: [read]\n---\n## Prompt\n\nImplement the step.\n',
    );
    const roleToml = '[roles.implementer]\nmodel = "fx/b"\n';
    const byRole = tuiWith(workspace, roleToml);
    const roleBoot = await byRole.deps.bootLane(undefined, undefined, {
      role: 'implementer',
    });
    await roleBoot.close?.();
    expect(roleBoot.model).toBe('fx/b');

    const pinned = tuiWith(
      workspace,
      `[model]\nprovider = "fx"\nid = "a"\n${roleToml}`,
    );
    const pinnedBoot = await pinned.deps.bootLane(undefined, undefined, {
      role: 'implementer',
    });
    await pinnedBoot.close?.();
    expect(pinnedBoot.model).toBe('fx/a');

    // The --model flag beats both.
    const flagged = await pinned.deps.bootLane(undefined, undefined, {
      role: 'implementer',
      model: { provider: 'fx', id: 'b' },
    });
    await flagged.close?.();
    expect(flagged.model).toBe('fx/b');
  });

  it('an unknown pinned model exits 6 with the reason, before the alt-screen', async () => {
    const workspace = tmpRoot();
    const { deps, fake, errs } = tuiWith(
      workspace,
      '[model]\nprovider = "fx"\nid = "zzz"\n',
    );
    expect(RUN_EXIT_PROVIDER_PROBE_FAILED).toBe(6);
    expect(await runTuiCommand({}, deps)).toBe(6);
    expect(errs.join('\n')).toContain("unknown model 'zzz'");
    expect(fake.counts.started).toBe(0);
  });

  it('a TUI-approved call writes an audit record with the model and session id', async () => {
    const workspace = tmpRoot();
    const faux = fauxProvider({
      provider: 'fx',
      models: [{ id: 'a' }, { id: 'b' }],
    });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('bash', { command: 'rm -rf gone' })]),
      fauxAssistantMessage('removed'),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const deps = tuiDepsWithDefaults(
      { out: () => {}, model: { provider: 'fx', id: 'b' } },
      rerooted(workspace, tmpRoot(), models),
    );
    const boot = await deps.bootLane(undefined, async () => ({
      approved: true,
      by: 'user',
    }));
    const loop = boot.loop;
    if (loop === undefined) throw new Error('the prod boot returned no loop');
    const admitted = await loop.accept('clean up', loop.context);
    if (!admitted.ok) throw new Error('prompt refused');
    await driveToSettled(loop.lane, admitted.value.operationId, loop.context);
    await boot.close?.();
    const records = readAuditLedger(auditLedgerDir(workspace));
    expect(records.length).toBeGreaterThan(0);
    const record = records.at(-1);
    expect(record?.model).toMatchObject({ provider: 'fx', id: 'b' });
    expect(record?.agent.session).toBe(boot.sessionId);
  });
});
