// The L-D34 opt-in lane through the production builders (issue #431):
// flag + faux drives spawn→collect→workspace→merge end-to-end against real
// git and a real child process, and an unreachable manager provider fails
// the run fast with `lane_provider_unreachable` instead of hanging it.
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createGitSandbox,
  disposeAllGitSandboxes,
  type GitSandbox,
} from '../../../packages/exec/src/test-support/git-sandbox.js';
import { LANE_WORKER_CHILD } from '../../../packages/exec/src/test-support/orchestrate-lane-fixtures.js';
import type { AssembledModels } from '../../../packages/host/src/models-cli.js';
import { runOrchestrateCommand } from '../../../packages/host/src/orchestrate-cli.js';
import { WorkerRegistry } from '../../../packages/worker/src/lifecycle/registry.js';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '../../../packages/worker/src/pi-boundary.js';
import { orchestrateDepsWithDefaults } from './orchestrate-run.js';

const scratchDirs: string[] = [];

function scratchRoot(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratchDirs.push(dir);
  return dir;
}

afterEach(() => {
  disposeAllGitSandboxes();
  vi.unstubAllEnvs();
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The test's git driver (issue #420, L-D37): one injected sandbox per
// test, so the setup spawns and the production git the run shells share
// the scrubbed view. The worker fixture cannot call this helper (it runs
// in a spawned child) — it self-scrubs and pins its commit identity
// instead (exec test-support).
let driver: GitSandbox | undefined;

function git(cwd: string, args: string[]): string {
  driver ??= createGitSandbox({
    prefix: 'kubic-lane-prod-',
    injectProcessEnv: true,
  });
  return driver.git(args, { cwd });
}

function initRepo(): string {
  const root = scratchRoot('kubic-lane-prod-');
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.email', 'lane@kubic.dev']);
  git(root, ['config', 'user.name', 'kubic lane']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(root, 'base.txt'), 'base\n');
  git(root, ['add', 'base.txt']);
  git(root, ['commit', '--no-verify', '-m', 'base']);
  return root;
}

function fixtureEntry(): { cmd: string; args: string[] } {
  const dir = scratchRoot('kubic-lane-prod-child-');
  const fixture = join(dir, 'worker-child.mjs');
  writeFileSync(fixture, LANE_WORKER_CHILD);
  return { cmd: process.execPath, args: [fixture] };
}

const toolTurn = (name: string, args: Record<string, string>) =>
  fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: 'toolUse' });

describe('prod manager lane behind the L-D34 opt-in (issue #431)', () => {
  it('an unreachable manager provider fails fast with lane_provider_unreachable', async () => {
    vi.stubEnv('KUBIC_TRUST_PROJECT', '1');
    const root = initRepo();
    // Deliberately unreachable (nothing listens on port 9): the lane must
    // name it, never hang inside durable retries.
    writeFileSync(
      join(root, 'models.json'),
      JSON.stringify({
        providers: [
          {
            id: 'evil',
            baseUrl: 'http://127.0.0.1:9/v1',
            api: 'openai-completions',
            apiKey: 'not-needed',
            models: [{ id: 'm' }],
          },
        ],
      }),
    );
    writeFileSync(join(root, '.git', 'info', 'exclude'), 'models.json\n');
    const errs: string[] = [];
    const deps = await orchestrateDepsWithDefaults({
      out: () => undefined,
      err: (line) => errs.push(line),
      debug: () => undefined,
      cwd: root,
      sessionsRoot: scratchRoot('kubic-lane-prod-sessions-'),
      registry: new WorkerRegistry(),
      workerEntry: fixtureEntry(),
      signals: { install: () => () => undefined, reraise: () => undefined },
      managerLane: true,
    });
    const startedAt = Date.now();
    const code = await runOrchestrateCommand(
      { prompt: 'ship alpha', agents: ['alpha'], session: 'lane-evil' },
      deps,
    );
    expect(code).toBe(1);
    expect(errs.join('\n')).toMatch(/lane_provider_unreachable/);
    // Failing fast is the point: minutes of retries would time this out.
    expect(Date.now() - startedAt).toBeLessThan(60_000);
  });

  it('flag + faux drives spawn to merge end-to-end through the prod builders', async () => {
    const root = initRepo();
    const faux = fauxProvider({
      provider: 'faux',
      models: [
        {
          id: 'echo',
          name: 'Faux echo (testing provider)',
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ],
    });
    const script = [
      toolTurn('spawn_agent', { role: 'implementer', task: 'do alpha' }),
      toolTurn('wait_for_agent', { agentId: 'worker-1' }),
      toolTurn('collect_result', { agentId: 'worker-1' }),
      toolTurn('workspace_diff', { agentId: 'worker-1' }),
      toolTurn('workspace_apply', { agentId: 'worker-1' }),
      toolTurn('workspace_merge', {}),
      fauxAssistantMessage('acceptance done'),
    ];
    faux.setResponses(script);
    const models = createModels();
    models.setProvider(faux.provider);
    const assembled: AssembledModels = {
      models,
      notes: [],
      providers: new Map([['faux', { origin: 'testing', usable: true }]]),
      sources: [],
      fallbackProviders: ['faux'],
      keyEnv: new Map(),
    };
    const lines: string[] = [];
    const deps = await orchestrateDepsWithDefaults({
      out: (line) => lines.push(line),
      err: () => undefined,
      debug: () => undefined,
      cwd: root,
      sessionsRoot: scratchRoot('kubic-lane-prod-sessions-'),
      registry: new WorkerRegistry(),
      workerEntry: fixtureEntry(),
      signals: { install: () => () => undefined, reraise: () => undefined },
      models: assembled,
      managerLane: true,
    });
    const code = await runOrchestrateCommand(
      {
        prompt: 'ship alpha',
        agents: ['alpha'],
        json: true,
        session: 'lane-accept',
        // The lane stages a real merge: auto-approve it (a headless
        // acceptance has no seat to ask).
        yes: true,
      },
      deps,
    );
    expect(code).toBe(0);
    // The worker's file merged onto the base branch for real.
    expect(readFileSync(join(root, 'work.txt'), 'utf8')).toBe(
      'lane acceptance\n',
    );
    const envelope = JSON.parse(lines[lines.length - 1] as string) as {
      workers: Array<{ agentId: string }>;
      mergeOrder: string[];
    };
    expect(envelope.mergeOrder).toContain('worker-1');
    expect(envelope.workers.map((entry) => entry.agentId)).toContain(
      'worker-1',
    );
    // The lane mark and the manager's final message persisted with the run.
    const state = JSON.parse(
      readFileSync(
        join(root, '.kubic', 'orchestrator', 'lane-accept.json'),
        'utf8',
      ),
    ) as { laneDriven?: boolean; managerSummary?: string; merged?: string[] };
    expect(state.laneDriven).toBe(true);
    expect(state.managerSummary).toBe('acceptance done');
    expect(state.merged).toContain('worker-1');
  });
});
