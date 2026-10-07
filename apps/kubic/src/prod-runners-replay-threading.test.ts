// The live-replay runtime through the real builder:
// `createProdRunners().replay` must hand the lane the same `[session]`
// compaction policy and `[agent]` prompt section `kubic run` threads — the
// construction used to ride an untyped spread invisible to types and pinned by
// no test. Everything here is real (prod runner, tier validation, lockfile
// check, trajectory load, runProdReplay up to the lane) except the lane itself,
// captured at the `runHeadlessPrompt` seam: if the production spread is
// dropped, the captured deps miss the fields and this fails. Lane behavior
// under the fields is pinned for real elsewhere (the autoCompact threshold test
// in config-runtime.test.ts, the replay seam test in
// replay-runtime-deps.test.ts).
//
// Faux provider only (`KUBIC_PROVIDER=faux`): zero network, zero paid
// tokens. Temp dirs throughout.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadRuntimeConfig } from '../../../packages/host/src/config/runtime.js';
import { NO_PROJECT_TRUST } from '../../../packages/host/src/config/trust-store.js';
import { buildTrajectoryExport } from '../../../packages/trajectory/src/export.js';
import type { CliConfigResult } from './config-runtime.js';
import { runHeadlessPrompt } from './headless-run.js';
import { createProdRunners } from './prod-runners.js';

vi.mock('./headless-run.js', async (importOriginal) => ({
  ...(await importOriginal()),
  runHeadlessPrompt: vi.fn(),
}));

const tempDirs: string[] = [];

function tmpRoot(prefix = 'kubic-replay-threading-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

beforeEach(() => {
  vi.stubEnv('KUBIC_NO_NOTICE', '1');
  vi.stubEnv('KUBIC_PROVIDER', 'faux');
  vi.mocked(runHeadlessPrompt).mockResolvedValue({
    terminus: 'completed',
    summary: 'mocked',
    sessionId: 'sess-mock',
    journalRef: '',
    usageRef: '',
    trajectoryRef: '',
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const HOME = '/nonexistent-home';
const GLOBAL = `${HOME}/.kubic/config.toml`;
const PROMPT = `${HOME}/.kubic/PROMPT.md`;
const ENTERPRISE = '/nonexistent/enterprise.toml';

function cliConfig(files: Record<string, string>): CliConfigResult {
  const runtime = loadRuntimeConfig({
    bridge: {
      exists: (path: string): boolean => path in files,
      readTextFile: (path: string): string => files[path] as string,
    },
    home: HOME,
    cwd: '/nonexistent-cwd',
    enterprisePath: ENTERPRISE,
    projectTrusted: true,
    env: {},
  });
  return {
    runtime,
    error: undefined,
    ignoreSplit: { missing: [], checked: [], applicable: false },
    trust: NO_PROJECT_TRUST,
  };
}

function runners() {
  const lines: string[] = [];
  const errs: string[] = [];
  return {
    lines,
    r: createProdRunners({
      out: (line) => lines.push(line),
      debug: (line) => errs.push(line),
    }),
  };
}

describe('replay re-execution threads compaction and the prompt section', () => {
  it('the real builder hands both projections to the lane', async () => {
    const dir = tmpRoot();
    const worktree = tmpRoot('kubic-replay-threading-wt-');
    const trajectory = join(dir, 't.json');
    writeFileSync(
      trajectory,
      JSON.stringify(
        buildTrajectoryExport({
          task: { taskId: 'task-1', objective: 'say hi', role: 'writer' },
          identity: {
            sessionId: 'sess-1',
            agentId: 'agent-1',
            workerId: null,
          },
          model: {
            provider: 'faux',
            model: 'echo',
            thinking: null,
            escalations: [],
          },
          prompt: { text: 'say hi', constraints: [] },
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
            worktree,
            model: 'faux/echo',
          },
          environment: {
            capturedFrom: 'used',
            cwd: worktree,
            env: {},
          },
          worktree: {
            path: worktree,
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
            inputTokens: 1,
            outputTokens: 1,
            cachedTokens: 0,
            requests: 1,
            costUsd: 0,
            byModel: {},
          },
          result: {
            status: 'completed',
            summary: 'done',
            failureCategory: null,
            error: null,
          },
        }),
      ),
    );
    const lockfile = join(dir, 'pins.json');
    writeFileSync(lockfile, JSON.stringify({ models: { faux: ['echo'] } }));

    const { r } = runners();
    const code = await r.replay(
      {
        trajectory,
        tier: 'deterministic',
        model: 'faux/echo',
        lockfile,
        json: true,
      },
      cliConfig({
        [GLOBAL]:
          '[session]\nreserveTokens = 4000\nkeepRecentTokens = 200\n[agent]\nsystemPromptFile = "PROMPT.md"\n',
        [PROMPT]: 'Always answer in rhyme.\n',
      }),
    );
    expect(code).toBe(0);
    const calls = vi.mocked(runHeadlessPrompt).mock.calls;
    expect(calls).toHaveLength(1);
    const deps = calls[0]?.[2];
    expect(deps?.compaction).toEqual({
      reserveTokens: 4000,
      keepRecentTokens: 200,
    });
    expect(deps?.systemPromptSection).toBe('Always answer in rhyme.\n');
  });
});
