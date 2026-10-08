// Replay re-execution runs under the effective config: the
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
import { SOLO_DEFAULTS } from '../../../../packages/agents/src/policy.js';
import { FakeExecutionEnv } from '../../../../packages/exec/src/env.js';
import { createNodeFileBridge } from '../../../../packages/exec/src/file-bridge.js';
import { loadRuntimeConfig } from '../../../../packages/host/src/config/runtime.js';
import { NO_PROJECT_TRUST } from '../../../../packages/host/src/config/trust-store.js';
import {
  type ReplayRunRequest,
  type ReplayRuntimeDeps,
  runReplayCommand,
} from '../../../../packages/host/src/replay/replay.js';
import { createProdReplayRun } from '../../../../packages/host/src/replay/run-prod.js';
import { buildTrajectoryExport } from '../../../../packages/trajectory/src/export.js';
import { parseTrajectoryExportJSON } from '../../../../packages/trajectory/src/schema.js';
import {
  attachSession,
  openSessionStore,
} from '../../../../packages/worker/src/lane/session-store.js';
import { fauxToolUse } from '../../../../packages/worker/src/lane/test-harness.js';
import {
  entriesToTranscript,
  readSessionEntries,
} from '../../../../packages/worker/src/lane/transcript.js';
import {
  BACKGROUND_CONTEXT,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type MutableModels,
} from '../../../../packages/worker/src/pi-boundary.js';
import { type CliConfigResult, runtimeRunDeps } from '../config-runtime.js';
import { runHeadlessPrompt } from '../headless-run.js';

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
    identity: { sessionId: 'sess-1', agentId: 'agent-1' },
    model: { provider: 'faux', model: 'm1', thinking: null, escalations: [] },
    prompt: { text: objective },
    resources: { skills: [] },
    actions: [],
    observations: [],
    state: { phase: 'done' },
    provenance: {
      sessionId: 'sess-1',
      agentId: 'agent-1',
      pid: null,
      worktree: '/repo',
      model: 'faux/m1',
    },
    environment: {
      capturedFrom: 'used',
      cwd: '/repo',
      env: {},
    },
    worktree: {
      path: '/repo',
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
    worktree: '/repo',
    lockfile: 'pins.json',
    roleConfig: null,
    role: null,
  };
}

const RUNTIME: ReplayRuntimeDeps = {
  policyClasses: { ...SOLO_DEFAULTS, shell: false },
  policySource: 'config',
  journalRetention: { maxAgeMs: 60_000 },
};

// The shape the composition root hands the projection: the
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

describe('replay re-execution consumes the effective config', () => {
  it('threads the runtime projections through the run seam', async () => {
    const root = tmpRoot('replay-deps-');
    const trajPath = join(root, 't.json');
    writeFileSync(trajPath, JSON.stringify(fixtureTrajectory()));
    const lockPath = join(root, 'pins.json');
    writeFileSync(lockPath, JSON.stringify({ models: { faux: ['m1'] } }));
    let captured: ReplayRuntimeDeps | undefined;
    const exit = (
      await runReplayCommand(
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
      )
    ).exitCode;
    expect(exit).toBe(0);
    expect(captured).toEqual(RUNTIME);
    expect(captured?.policySource).toBe('config');
  });

  it('forwards the runtime projections to the re-execution seam', async () => {
    let captured: ReplayRuntimeDeps | undefined;
    const run = createProdReplayRun({
      loadTrajectory: () => fixtureTrajectory(),
      runPrompt: async (_prompt, _model, _request, runtime) => {
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

  it('threads the compaction policy and prompt section to the re-execution seam', async () => {
    // The review caught these riding an untyped spread: the live tiers
    // compacted and augmented correctly at runtime, but no type named
    // the fields and no test pinned them. The composition root builds
    // this runtime from the same projections `kubic run` consumes, so
    // the config that governs a run governs its replay.
    let captured: ReplayRuntimeDeps | undefined;
    const run = createProdReplayRun({
      loadTrajectory: () => fixtureTrajectory(),
      runPrompt: async (_prompt, _model, _request, runtime) => {
        captured = runtime;
        return { terminus: 'completed', summary: 'replayed' };
      },
    });
    const result = await run(request(), {
      ...RUNTIME,
      compaction: { reserveTokens: 4000 },
      systemPromptSection: 'Be terse.\n',
    });
    expect(result.terminus).toBe('completed');
    expect(captured?.compaction).toEqual({ reserveTokens: 4000 });
    expect(captured?.systemPromptSection).toBe('Be terse.\n');
  });

  it('a config-sourced policy class blocks a network-shaped command on replay re-execution', async () => {
    // The effective config: an explicit [permissions] layer
    // makes the classes config-sourced. `shell = "read-only-allowlist"` is
    // the class that blocks network-shaped bash commands at the guard —
    // and `network = "full"` keeps the approval trigger out of the way
    // (detectTriggers fires `network` at 'none' and at the domain-less
    // 'allowlist' it enforces as 'none'). Under the documented
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
      // A tool round must say `toolUse`, or the tool never runs.
      fauxToolUse([
        fauxToolCall('bash', { command: 'curl https://example.com' }),
      ]),
      fauxAssistantMessage('did not fetch'),
    ]);
    let sessionId = '';
    const run = createProdReplayRun({
      loadTrajectory: (path) => parseTrajectoryExportJSON(readText(path)),
      runPrompt: async (prompt, _model, _request, runtime) => {
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
      // The durable transcript through the shared adapter: the
      // stored tool-result text is what the assertion reads.
      const transcript = JSON.stringify(
        entriesToTranscript(
          await readSessionEntries(session.storage, BACKGROUND_CONTEXT),
        ),
      );
      // The config class did the blocking (the read-only-allowlist guard),
      // and the default-path approval challenge must NOT be what fired.
      expect(transcript).toContain('network command blocked');
      expect(transcript).not.toContain('approval refused');
    } finally {
      await session.release(BACKGROUND_CONTEXT);
    }
  });
});

function readText(path: string): string {
  return createNodeFileBridge('/').readTextFile(path);
}
