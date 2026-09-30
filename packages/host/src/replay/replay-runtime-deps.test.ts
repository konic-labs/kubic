// Replay re-execution runs under the effective config (issue #114): the
// runtime projections `kubic run` threads into its lane (policyClasses,
// policySource, journalRetention — runtimeRunDeps) must reach the replay
// lane too, through the same seams: `runReplayCommand`'s run seam gains the
// deps parameter, `createProdReplayRun` forwards them to its runPrompt
// seam, and the re-execution installs the config-sourced policy. A
// config-sourced class must BLOCK a network-shaped command on
// re-execution — replay is governed by the config, not by whatever the
// binary's defaults happen to allow.
//
// Faux provider only: zero network, zero paid tokens. Tmp dirs throughout.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type CliConfigResult,
  runtimeRunDeps,
} from '../../../../apps/kubic/src/config-runtime.js';
import { runHeadlessPrompt } from '../../../../apps/kubic/src/headless-run.js';
import { SOLO_DEFAULTS } from '../../../agents/src/policy.js';
import { FakeExecutionEnv } from '../../../exec/src/env.js';
import { createNodeFileBridge } from '../../../exec/src/file-bridge.js';
import { buildTrajectoryExport } from '../../../trajectory/src/export.js';
import { parseTrajectoryExportJSON } from '../../../trajectory/src/schema.js';
import {
  attachSession,
  openSessionStore,
} from '../../../worker/src/lane/session-store.js';
import {
  BACKGROUND_CONTEXT,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type MutableModels,
} from '../../../worker/src/pi-boundary.js';
import { loadRuntimeConfig } from '../config/runtime.js';
import { NO_PROJECT_TRUST } from '../config/trust-store.js';
import {
  type ReplayRunRequest,
  type ReplayRuntimeDeps,
  runReplayCommand,
} from './replay.js';
import { createProdReplayRun } from './run-prod.js';

const roots: string[] = [];

function tmpRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

// The solo no-isolation notice is pinned by solo-notice-prod.test.ts; here it
// is only stderr noise from the re-execution, silenced via its opt-out.
beforeEach(() => {
  vi.stubEnv('KUBIC_NO_NOTICE', '1');
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function fixtureTrajectory(objective = 'Fix the widget') {
  return buildTrajectoryExport({
    task: { taskId: 'task-1', objective, role: 'writer' },
    identity: { sessionId: 'sess-1', agentId: 'agent-1', workerId: null },
    model: { provider: 'faux', model: 'm1', thinking: null, escalations: [] },
    prompt: { text: objective, constraints: [] },
    resources: { skills: [], promptTemplates: [] },
    transfer: null,
    actions: [],
    observations: [],
    state: { phase: 'done', snapshot: null },
    provenance: {
      sessionId: 'sess-1',
      agentId: 'agent-1',
      pid: null,
      generation: 1,
      worktree: '/repo/.kubic/wt/agent-1',
      model: 'faux/m1',
    },
    environment: {
      capturedFrom: 'used',
      cwd: '/repo/.kubic/wt/agent-1',
      env: {},
    },
    worktree: {
      path: '/repo/.kubic/wt/agent-1',
      baseRevision: 'abc123',
      branch: null,
    },
    diff: { filesChanged: [], files: [] },
    approvals: [],
    timestamps: {
      startedAt: '2026-09-23T10:00:00.000Z',
      endedAt: '2026-09-23T10:01:00.000Z',
    },
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      cachedTokens: 0,
      requests: 1,
      costUsd: 0.01,
      byModel: {},
    },
    result: {
      status: 'completed',
      summary: 'done',
      failureCategory: null,
      error: null,
    },
  });
}

function request(): ReplayRunRequest {
  return {
    tier: 'deterministic',
    trajectory: 't.json',
    model: 'faux/m1',
    worktree: '/repo/.kubic/wt/agent-1',
    lockfile: 'pins.json',
    roleConfig: null,
  };
}

const RUNTIME: ReplayRuntimeDeps = {
  policyClasses: { ...SOLO_DEFAULTS, shell: false },
  policySource: 'config',
  journalRetention: { maxAgeMs: 60_000 },
};

// The shape the composition root hands the projection (issue #86): the
// load's own result wrapped as the CLI's config result.
function cliResult(runtime: unknown): CliConfigResult {
  return {
    runtime: runtime as CliConfigResult['runtime'],
    error: undefined,
    ignoreSplit: { missing: [], checked: [], applicable: false },
    trust: NO_PROJECT_TRUST,
  };
}

function configured(text: string) {
  return {
    bridge: {
      exists: (path: string): boolean =>
        path === '/nonexistent-cwd/.kubic/config.toml',
      readTextFile: (): string => text,
    },
    home: '/nonexistent-home',
    cwd: '/nonexistent-cwd',
    enterprisePath: '/nonexistent/enterprise.toml',
    projectTrusted: true,
    env: {},
  };
}

describe('replay re-execution consumes the effective config (issue #114)', () => {
  it('threads the runtime projections through the run seam', async () => {
    const root = tmpRoot('replay-deps-');
    const trajPath = join(root, 't.json');
    writeFileSync(trajPath, JSON.stringify(fixtureTrajectory()));
    const lockPath = join(root, 'pins.json');
    writeFileSync(lockPath, JSON.stringify({ models: { faux: ['m1'] } }));
    let captured: ReplayRuntimeDeps | undefined;
    const exit = await runReplayCommand(
      {
        trajectory: trajPath,
        tier: 'deterministic',
        model: 'faux/m1',
        lockfile: lockPath,
      },
      {
        out: () => {},
        err: () => {},
        run: async (_request, runtime) => {
          captured = runtime;
          return { terminus: 'completed', summary: 'replayed' };
        },
      },
      RUNTIME,
    );
    expect(exit).toBe(0);
    expect(captured).toEqual(RUNTIME);
    expect(captured?.policySource).toBe('config');
  });

  it('forwards the runtime projections to the re-execution seam', async () => {
    let captured: ReplayRuntimeDeps | undefined;
    const run = createProdReplayRun({
      loadTrajectory: () => fixtureTrajectory(),
      runPrompt: async (_prompt, _model, runtime) => {
        captured = runtime;
        return { terminus: 'completed', summary: 'replayed' };
      },
    });
    const result = await run(request(), RUNTIME);
    expect(result.terminus).toBe('completed');
    expect(captured).toEqual(RUNTIME);
    expect(captured?.policySource).toBe('config');
    expect(captured?.journalRetention).toEqual({ maxAgeMs: 60_000 });
  });

  it('a config-sourced policy class blocks a network-shaped command on replay re-execution', async () => {
    // The effective config (issue #90): an explicit [permissions] layer
    // makes the classes config-sourced. `shell = "read-only-allowlist"` is
    // the class that blocks network-shaped bash commands at the guard —
    // and `network = "full"` keeps the approval trigger out of the way
    // (detectTriggers fires `network` at 'none' and at the domain-less
    // 'allowlist' it enforces as 'none', issue #166). Under the documented
    // DEFAULTS the same call instead dies on the approval challenge
    // ('approval refused: network'), so the guard-shaped block is the proof
    // the CONFIG classes are installed on the re-execution.
    const loaded = loadRuntimeConfig(
      configured(
        '[permissions]\nnetwork = "full"\nshell = "read-only-allowlist"\n',
      ),
    );
    const deps = runtimeRunDeps(cliResult(loaded));
    expect(deps.policySource).toBe('config');
    expect(deps.policyClasses?.shell).toBe('read-only-allowlist');

    const root = tmpRoot('replay-block-');
    const trajPath = join(root, 't.json');
    writeFileSync(trajPath, JSON.stringify(fixtureTrajectory('fetch it')));
    const faux = fauxProvider();
    const models: MutableModels = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall('bash', { command: 'curl https://example.com' }),
      ]),
      fauxAssistantMessage('did not fetch'),
    ]);
    let sessionId = '';
    const run = createProdReplayRun({
      loadTrajectory: (path) => parseTrajectoryExportJSON(readText(path)),
      runPrompt: async (prompt, _model, runtime) => {
        const result = await runHeadlessPrompt(
          prompt,
          {},
          {
            sessionsRoot: root,
            models,
            env: new FakeExecutionEnv({}),
            ...runtime,
          },
        );
        sessionId = result.sessionId;
        return { terminus: result.terminus, summary: result.summary };
      },
    });
    const result = await run({ ...request(), trajectory: trajPath }, deps);
    expect(result.terminus, result.summary).toBe('completed');
    expect(result.summary).toContain('did not fetch');

    const store = openSessionStore(root, createNodeFileBridge(root));
    const session = await attachSession(store, sessionId, BACKGROUND_CONTEXT);
    try {
      const entries = await session.findEntries(undefined, BACKGROUND_CONTEXT);
      const transcript = JSON.stringify(entries);
      // The config class did the blocking (the read-only-allowlist guard),
      // and the default-path approval challenge must NOT be what fired.
      expect(transcript).toContain('network command blocked');
      expect(transcript).not.toContain('approval refused');
    } finally {
      await session.close(BACKGROUND_CONTEXT);
    }
  });
});

function readText(path: string): string {
  return createNodeFileBridge('/').readTextFile(path);
}
