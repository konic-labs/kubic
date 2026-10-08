// Config → live TUI path: `kubic tui` spreads the SAME
// runtimeLaneDeps projection `kubic run` consumes into tuiDepsWithDefaults,
// which keeps the `[agent].name` and `[roles.<name>]` layers, not only the
// policy/journal keys, so they reach bootTuiLane. These drive the
// production deps builder (tuiDepsWithDefaults) with the same fixtures as the
// Run tests (runtime-run-path.test.ts).
//
// Faux provider only: zero network, zero paid tokens.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXIT_PROVIDER } from '../../../../packages/core/src/cli/exit-codes.js';
import { NodeExecutionEnv } from '../../../../packages/exec/src/env.js';
import { FileJournalStore } from '../../../../packages/exec/src/journal.js';
import {
  loadRuntimeConfig,
  type RuntimeConfig,
} from '../../../../packages/host/src/config/runtime.js';
import { NO_PROJECT_TRUST } from '../../../../packages/host/src/config/trust-store.js';
import { runJournalCommand } from '../../../../packages/host/src/journal-cli.js';
import {
  auditLedgerDir,
  readAuditLedger,
} from '../../../../packages/host/src/policy/audit-ledger.js';
import { fauxToolUse } from '../../../../packages/worker/src/lane/test-harness.js';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type MutableModels,
} from '../../../../packages/worker/src/pi-boundary.js';
import { terminalRig } from '../../../../test/fake-terminal.js';
import { runtimeLaneDeps, runtimeModelPin } from '../config-runtime.js';
import {
  bootTuiLane,
  runTuiCommand,
  type TuiRunOptions,
  tuiDepsWithDefaults,
} from '../tui-run.js';

const tempDirs: string[] = [];

function tmpRoot(prefix = 'kubic-tui-path-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

beforeEach(() => {
  vi.stubEnv('KUBIC_NO_NOTICE', '1');
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
  cliModel?: { provider: string; id: string },
): RuntimeConfig {
  return loadRuntimeConfig({
    ...(cliModel === undefined ? {} : { cli: { model: cliModel } }),
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
    trust: NO_PROJECT_TRUST,
  });
}

// The model-visible system prompt of one request: the durable lane
// materializes the assembled prompt at REQUEST time, so the faux provider's
// own request context is where it can be observed.
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
  }
  for (const section of Object.values(system.sections ?? {})) {
    if (typeof section === 'string' && section !== '') parts.push(section);
  }
  return parts.join('\n\n');
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

describe('tuiDepsWithDefaults forwards the lane projection', () => {
  it('forwards agentId and roles to the boot', async () => {
    const layers = [
      {
        layer: 'project' as const,
        roles: { implementer: { tools: ['read'] } },
      },
    ];
    let seen: TuiRunOptions | undefined;
    const trustProject = () => true;
    const deps = tuiDepsWithDefaults(
      { out: () => {}, agentId: 'alice', roles: { layers, trustProject } },
      async (_id, options) => {
        seen = options;
        return { sessionId: 's', model: 'faux/m' };
      },
    );
    await deps.bootLane(undefined, undefined, { role: 'implementer' });
    expect(seen?.agentId).toBe('alice');
    // The trust check travels on the same `roles` projection.
    expect(seen?.roles?.layers).toEqual(layers);
    expect(seen?.roles?.trustProject).toBe(trustProject);
    expect(seen?.role).toBe('implementer');
  });

  it('attributes TUI journal entries to [agent].name', async () => {
    const sessionsRoot = tmpRoot();
    const workspace = tmpRoot('kubic-tui-agent-');
    writeFileSync(join(workspace, 'note.txt'), 'v1\n');
    const lane = laneFor(workspace, '[agent]\nname = "foo"\n');
    expect(lane.agentId).toBe('foo');
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxToolUse([
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
    const turn = await loop.runTurn('mutate note.txt', {
      requestId: 'journal-agent',
      context: loop.context,
      whenBusy: 'reject',
    });
    expect(turn.kind).toBe('completed');
    await boot.close?.();
    const entries = new FileJournalStore(
      join(sessionsRoot, boot.sessionId, 'journal'),
    ).entries();
    expect(entries.length).toBeGreaterThan(0);
    expect([...new Set(entries.map((entry) => entry.source))]).toEqual([
      'sweep',
    ]);
    const named: string[] = [];
    expect(
      (
        await runJournalCommand(
          { command: 'diff', session: boot.sessionId },
          { root: workspace, sessionsRoot, out: (line) => named.push(line) },
        )
      ).exitCode,
    ).toBe(0);
    expect(named.join('\n')).toContain('note.txt');
  });

  it('layers config [roles.implementer] tools under the document on kubic tui --role', async () => {
    const sessionsRoot = tmpRoot();
    const workspace = tmpRoot('kubic-tui-path-roles-');
    mkdirSync(join(workspace, '.kubic', 'roles'), { recursive: true });
    writeFileSync(
      join(workspace, '.kubic', 'roles', 'implementer.md'),
      '---\nrole: implementer\ntools: [read, ls, write, bash]\n---\n## Prompt\n\nImplement the step.\n',
    );
    const lane = laneFor(workspace, '[roles.implementer]\ntools = ["read"]\n');
    const captured: string[] = [];
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      (context: unknown) => {
        captured.push(systemTextOf(context));
        return fauxAssistantMessage('done');
      },
    ]);
    const deps = tuiDepsWithDefaults(
      { out: () => {}, ...lane },
      rerooted(workspace, sessionsRoot, models),
    );
    const boot = await deps.bootLane(undefined, undefined, {
      role: 'implementer',
    });
    const loop = boot.loop;
    if (loop === undefined) throw new Error('the prod boot returned no loop');
    await loop.runTurn('hi', {
      requestId: 'role-tools',
      context: loop.context,
      whenBusy: 'reject',
    });
    await boot.close?.();
    const toolsLine = /^tools: (.*)$/m.exec(captured.at(-1) ?? '')?.[1] ?? '';
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
  return terminalRig(100, 30);
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !condition(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  expect(condition()).toBe(true);
}

describe('the TUI selects the pinned model', () => {
  beforeEach(() => {
    vi.stubEnv('KUBIC_PROVIDER', undefined);
  });

  function tuiWith(
    workspace: string,
    toml: string,
    env: Record<string, string> = {},
    cliModel?: { provider: string; id: string },
  ) {
    const cliConfig = {
      runtime: namedRuntime(workspace, toml, env, cliModel),
      error: undefined,
      ignoreSplit: NO_SPLIT,
      trust: NO_PROJECT_TRUST,
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
      colorLevel: 'none' as const,
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
    fake.feed('\x04');
    expect((await exit).exitCode).toBe(0);
    const doc = lines.join('\n');
    // The first screen's provider row and the status line both name the
    // pinned model.
    expect(doc).toMatch(/provider {5}fx\/b/u);
    expect(doc).toMatch(/● fx\/b · /);
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
    fake.feed('\x04');
    expect((await exit).exitCode).toBe(0);
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

    // The --model flag beats both — as the `cli` layer of the config load
    // (dispatch pre-scans it), never as a boot flag patched over the
    // projected pin (a frozen enterprise pin must hold).
    const flagged = await tuiWith(
      workspace,
      `[model]\nprovider = "fx"\nid = "a"\n${roleToml}`,
      {},
      { provider: 'fx', id: 'b' },
    ).deps.bootLane(undefined, undefined, { role: 'implementer' });
    await flagged.close?.();
    expect(flagged.model).toBe('fx/b');
  });

  it('an unknown pinned model exits 6 with the reason, before the alt-screen', async () => {
    const workspace = tmpRoot();
    const { deps, fake, errs } = tuiWith(
      workspace,
      '[model]\nprovider = "fx"\nid = "zzz"\n',
    );
    expect(EXIT_PROVIDER).toBe(6);
    expect((await runTuiCommand({}, deps)).exitCode).toBe(6);
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
      fauxToolUse([fauxToolCall('bash', { command: 'rm -rf gone' })]),
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
    const turn = await loop.runTurn('clean up', {
      requestId: 'audit-model',
      context: loop.context,
      whenBusy: 'reject',
    });
    expect(turn.kind).toBe('completed');
    await boot.close?.();
    const records = readAuditLedger(auditLedgerDir(workspace));
    expect(records.length).toBeGreaterThan(0);
    const record = records.at(-1);
    expect(record?.model).toMatchObject({ provider: 'fx', id: 'b' });
    expect(record?.agent.session).toBe(boot.sessionId);
  });
});
