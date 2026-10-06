// The configured escalation ladder on `kubic tui` (issue #210; §38.4):
// a `/model` switch to an off-ladder model refuses by name with the live
// model untouched, an on-ladder climb switches, a down-step refuses
// one-way, and naming the live model still passes. Drives the real
// `bootTuiLane` through the production deps builder with faux providers:
// zero network, zero paid tokens.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NodeExecutionEnv } from '../../../packages/exec/src/env.js';
import { loadRuntimeConfig } from '../../../packages/host/src/config/runtime.js';
import { NO_PROJECT_TRUST } from '../../../packages/host/src/config/trust-store.js';
import { parseTrajectoryExportJSON } from '../../../packages/trajectory/src/schema.js';
import { createTuiApp } from '../../../packages/tui/src/tui-app.js';
import type { TurnFailureReason } from '../../../packages/worker/src/lane/turn.js';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  type MutableModels,
} from '../../../packages/worker/src/pi-boundary.js';
import { terminalRig } from '../../../test/fake-terminal.js';
import type { CliConfigResult } from './config-runtime.js';
import { prodTuiDeps } from './prod-runners.js';
import type { TuiLaneLoop } from './tui-run.js';
import {
  bootTuiLane,
  runTuiCommand,
  TuiTurnRunner,
  tuiDepsWithDefaults,
} from './tui-run.js';

const tempDirs: string[] = [];

function tmpRoot(prefix = 'kubic-tui-escalation-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

beforeEach(() => {
  vi.stubEnv('KUBIC_NO_NOTICE', '1');
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function twoProviders(): MutableModels {
  const models = createModels();
  for (const entry of [
    { provider: 'local', models: ['a', 'b'] },
    { provider: 'anthropic', models: ['x'] },
  ]) {
    const faux = fauxProvider({
      provider: entry.provider,
      models: entry.models.map((id) => ({ id })),
    });
    faux.setResponses([fauxAssistantMessage('ok')]);
    models.setProvider(faux.provider);
  }
  return models;
}

// The prod boot, re-rooted onto temp state (mirrors tui-scoped-models):
// whatever the production deps builder forwards reaches bootTuiLane.
function rerooted(
  workspace: string,
  sessionsRoot: string,
  models: MutableModels,
): typeof bootTuiLane {
  return (
    sessionId?: string,
    options: Parameters<typeof bootTuiLane>[1] = {},
  ) =>
    bootTuiLane(sessionId, {
      ...options,
      sessionsRoot,
      models,
      env: new NodeExecutionEnv(workspace),
      skills: { homeDir: workspace, cwd: workspace, trusted: false },
      roles: { ...options.roles, cwd: workspace },
    });
}

const IO = { out: (): void => {}, debug: (): void => {} };

async function waitFor(
  condition: () => boolean,
  deadlineMs = 10_000,
): Promise<void> {
  // Deadline-based (issue #385): a generous deadline only fails a true
  // hang, never a slow scheduler.
  const start = Date.now();
  while (!condition() && Date.now() - start < deadlineMs) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  expect(condition()).toBe(true);
}

const PROJECT = '/nonexistent-cwd/.kubic/config.toml';

// The effective config exactly as the composition root wraps it (mirrors
// tui-scoped-models): a real `loadRuntimeConfig` over an in-memory project
// layer, so the ladder travels the production path — config file →
// runtimeLaneDeps → bootTuiLane — instead of being hand-injected.
function cliConfig(files: Record<string, string>): CliConfigResult {
  const runtime = loadRuntimeConfig({
    bridge: {
      exists: (path: string): boolean => path in files,
      readTextFile: (path: string): string => files[path] as string,
    },
    home: '/nonexistent-home',
    cwd: '/nonexistent-cwd',
    enterprisePath: '/etc/kubic-test/enterprise.toml',
    productPath: '/nonexistent/product.toml',
    projectTrusted: true,
    env: {},
  });
  if (runtime === undefined) throw new Error('refused test config');
  return {
    runtime,
    error: undefined,
    ignoreSplit: { missing: [], checked: [], applicable: false },
    trust: NO_PROJECT_TRUST,
  };
}

const LADDER =
  '[model]\nprovider = "local"\nid = "a"\n' +
  'escalate = ["local/a", "local/b"]\n';

describe('configured ladder on the TUI lane (issue #210)', () => {
  it('refuses an off-ladder switch, climbs on-ladder, refuses down-steps', async () => {
    const workspace = tmpRoot();
    const cfg = cliConfig({ [PROJECT]: LADDER });
    const deps = tuiDepsWithDefaults(
      prodTuiDeps(IO, cfg),
      rerooted(workspace, tmpRoot(), twoProviders()),
    );
    const boot = await deps.bootLane(undefined, undefined, {});
    const loop = boot.loop;
    if (loop?.switchModel === undefined) {
      throw new Error('the prod boot returned no switchable loop');
    }
    expect(boot.model).toBe('local/a');
    // Off-ladder: refused by name, live model untouched.
    await expect(
      loop.switchModel({ provider: 'anthropic', modelId: 'x' }, loop.context),
    ).rejects.toThrow(/escalation off-ladder refused/);
    expect(await loop.model?.(loop.context)).toBe('local/a');
    // On-ladder: the climb switches the live model.
    await expect(
      loop.switchModel({ provider: 'local', modelId: 'b' }, loop.context),
    ).resolves.toBe('local/b');
    // Down-step: one-way, refused with the live model untouched.
    await expect(
      loop.switchModel({ provider: 'local', modelId: 'a' }, loop.context),
    ).rejects.toThrow(/escalation is one-way/);
    expect(await loop.model?.(loop.context)).toBe('local/b');
    // Naming the live model is a no-op pass, not a refusal.
    await expect(
      loop.switchModel({ provider: 'local', modelId: 'b' }, loop.context),
    ).resolves.toBe('local/b');
    await boot.close?.();
  });

  it('climbs with an explicit reason on the /escalate path', async () => {
    const workspace = tmpRoot();
    const cfg = cliConfig({ [PROJECT]: LADDER });
    const deps = tuiDepsWithDefaults(
      prodTuiDeps(IO, cfg),
      rerooted(workspace, tmpRoot(), twoProviders()),
    );
    const boot = await deps.bootLane(undefined, undefined, {});
    const loop = boot.loop;
    if (loop?.switchModel === undefined) {
      throw new Error('the prod boot returned no switchable loop');
    }
    // The reason rides the same ladder gate as `/model` — the climb
    // resolves (the event naming it is slice 5's assertion).
    await expect(
      loop.switchModel(
        { provider: 'local', modelId: 'b' },
        loop.context,
        'for speed',
      ),
    ).resolves.toBe('local/b');
    await boot.close?.();
  });

  it('refuses the second climb past maxEscalations', async () => {
    const workspace = tmpRoot();
    const cfg = cliConfig({
      [PROJECT]:
        '[model]\nprovider = "local"\nid = "a"\n' +
        'escalate = ["local/a", "local/b", "anthropic/x"]\n' +
        'maxEscalations = 1\n',
    });
    const deps = tuiDepsWithDefaults(
      prodTuiDeps(IO, cfg),
      rerooted(workspace, tmpRoot(), twoProviders()),
    );
    const boot = await deps.bootLane(undefined, undefined, {});
    const loop = boot.loop;
    if (loop?.switchModel === undefined) {
      throw new Error('the prod boot returned no switchable loop');
    }
    await expect(
      loop.switchModel({ provider: 'local', modelId: 'b' }, loop.context),
    ).resolves.toBe('local/b');
    await expect(
      loop.switchModel({ provider: 'anthropic', modelId: 'x' }, loop.context),
    ).rejects.toThrow(/escalation bounded: 1 steps already \(max 1\)/);
    expect(await loop.model?.(loop.context)).toBe('local/b');
    await boot.close?.();
  });

  it('climbs once after N consecutive tool failures and never steps back', async () => {
    // Slice 4 (issue #210): the automatic trigger. Three turns settled
    // with tool-classified failures climb the lane one rung with
    // {from,to,reason} recorded; further failures never climb again.
    // Drives the real recordTurn (every TUI turn settles through it)
    // with synthesized failed records — the classification itself is
    // #209's pinned unit, this pins the trigger off it.
    const workspace = tmpRoot();
    const sessions = tmpRoot();
    const cfg = cliConfig({ [PROJECT]: LADDER });
    const deps = tuiDepsWithDefaults(
      prodTuiDeps(IO, cfg),
      rerooted(workspace, sessions, twoProviders()),
    );
    const boot = await deps.bootLane(undefined, undefined, {});
    const loop = boot.loop;
    if (loop?.recordTurn === undefined || loop.model === undefined) {
      throw new Error('the prod boot returned no recordable loop');
    }
    const failedTurn = (reason: TurnFailureReason) => ({
      prompt: 'do it',
      startedAt: Date.now(),
      outcome: { status: 'failed' as const },
      turn: { kind: 'failed' as const, reason },
    });
    expect(boot.model).toBe('local/a');
    await loop.recordTurn(failedTurn('tool_failed'));
    await loop.recordTurn(failedTurn('tool_timeout'));
    expect(await loop.model?.(loop.context)).toBe('local/a');
    await loop.recordTurn(failedTurn('tool_unavailable'));
    // The single auto climb fired: live model moved one rung.
    expect(await loop.model?.(loop.context)).toBe('local/b');
    // Two more failures: no second climb, never a step back.
    await loop.recordTurn(failedTurn('tool_failed'));
    await loop.recordTurn(failedTurn('tool_failed'));
    expect(await loop.model?.(loop.context)).toBe('local/b');
    // Slice 5: the exported trajectory carries exactly the one climb.
    const exported = parseTrajectoryExportJSON(
      readFileSync(join(sessions, boot.sessionId, 'trajectory.json'), 'utf8'),
    );
    expect(exported.model.escalations).toHaveLength(1);
    expect(exported.model.escalations[0]).toMatchObject({
      fromModel: 'local/a',
      toModel: 'local/b',
      reason: '3 consecutive tool failures',
    });
    await boot.close?.();
  });

  it('a completed turn breaks the failure streak', async () => {
    const workspace = tmpRoot();
    const sessions = tmpRoot();
    const cfg = cliConfig({ [PROJECT]: LADDER });
    const deps = tuiDepsWithDefaults(
      prodTuiDeps(IO, cfg),
      rerooted(workspace, sessions, twoProviders()),
    );
    const boot = await deps.bootLane(undefined, undefined, {});
    const loop = boot.loop;
    if (loop?.recordTurn === undefined || loop.model === undefined) {
      throw new Error('the prod boot returned no recordable loop');
    }
    const record = (
      status: 'completed' | 'failed',
      reason?: TurnFailureReason,
    ) => ({
      prompt: 'do it',
      startedAt: Date.now(),
      outcome: { status },
      ...(reason === undefined
        ? {}
        : { turn: { kind: 'failed' as const, reason } }),
    });
    await loop.recordTurn(record('failed', 'tool_failed'));
    await loop.recordTurn(record('failed', 'tool_failed'));
    await loop.recordTurn(record('completed'));
    await loop.recordTurn(record('failed', 'tool_failed'));
    await loop.recordTurn(record('failed', 'tool_failed'));
    // Only two in a row after the break: no climb.
    expect(await loop.model?.(loop.context)).toBe('local/a');
    await boot.close?.();
  });

  it('reports an explicit climb as a transcript row on the next drain', async () => {
    // Slice 5 (issue #210): the /model climb records the event and the
    // runner drain reports it as a transcript row — each climb once.
    // Full loop level: /model through runTuiCommand on a fake terminal.
    const workspace = tmpRoot();
    const cfg = cliConfig({ [PROJECT]: LADDER });
    const deps = tuiDepsWithDefaults(
      prodTuiDeps(IO, cfg),
      rerooted(workspace, tmpRoot(), twoProviders()),
    );
    const fake = terminalRig(100);
    const pending = runTuiCommand(
      {},
      { ...deps, createTerminal: () => fake.terminal, colorLevel: 'none' },
    );
    await waitFor(() => fake.counts.started === 1);
    fake.feed('\x15');
    for (const ch of '/model local/b') fake.feed(ch);
    fake.feed('\r');
    await waitFor(() =>
      fake.writes
        .join('')
        .includes('escalation: local/a → local/b (/model local/b)'),
    );
    fake.feed('\x03');
    fake.feed('\x03');
    expect(await pending).toBe(0);
  });

  it('the runner drain reports recorded climbs exactly once', async () => {
    // Slice 5 mechanics: a stub loop with one recorded climb drains a
    // single row onto the transcript; the second settled turn drains
    // nothing (the lane snapshot lifecycle owns notice cells after that
    // — the drain itself must not re-yield).
    const app = createTuiApp({
      sessionId: 's1',
      model: 'local/a',
      mode: 'solo',
      approvalsSkipped: false,
    });
    const rows = [
      'escalation: local/a → local/b (3 consecutive tool failures)',
    ];
    let drained = false;
    let yielded = 0;
    const loop = {
      subscribe: async () => async () => {},
      runTurn: async () => ({ kind: 'completed' }),
      entries: async () => [],
      forgetKills: () => {},
      drainEscalationRows: () => {
        if (drained) return [];
        drained = true;
        yielded += rows.length;
        return [...rows];
      },
    } as unknown as TuiLaneLoop;
    const runner = new TuiTurnRunner(app, loop, 'local/a');
    await runner.run('hi');
    expect(app.render(120).join('\n')).toContain(
      'escalation: local/a → local/b',
    );
    await runner.run('hi again');
    expect(yielded).toBe(1);
  });
});
