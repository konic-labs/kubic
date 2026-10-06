// Worker children resolve the MANAGER's models.json (issue #222). Drives the
// real composition-root adapter against real git and a REAL child process:
// the fixture child dumps its cwd and the models lookup env it received, and
// the test then assembles the catalog exactly as that child would (its cwd,
// its env) — the manager's untracked models.json must be found even though
// the worker's worktree does not contain it. No provider is dialled.
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Provenance } from '../../../packages/exec/src/env.js';
import { NodeExecutionEnv } from '../../../packages/exec/src/env.js';
import { assembleModels } from '../../../packages/host/src/models-cli.js';
import { runOrchestrateCommand } from '../../../packages/host/src/orchestrate-cli.js';
import { WorkerRegistry } from '../../../packages/worker/src/lifecycle/registry.js';
import { orchestrateDepsWithDefaults } from './orchestrate-run.js';

const PROVENANCE: Provenance = {
  sessionId: 'models-root-prod',
  agentId: 'manager',
  toolCallId: 'issue-222',
  turnId: 0,
  operation: 'orchestrate_models_root_prod',
};

const FIXTURE = `
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const argv = process.argv.slice(2);
const index = argv.indexOf('-p');
const prompt = index === -1 ? '' : (argv[index + 1] ?? '');
const dumpDir = /DUMPDIR=(\\S+)/.exec(prompt);
if (dumpDir !== null) {
  const id = process.env.KUBIC_WORKER_ID ?? 'worker';
  writeFileSync(join(dumpDir[1], id + '.json'), JSON.stringify({
    cwd: process.cwd(),
    root: process.env.KUBIC_MODELS_ROOT ?? null,
    trust: process.env.KUBIC_TRUST_PROJECT ?? null,
    hasModelsJson: existsSync(join(process.cwd(), 'models.json')),
  }));
}
process.stdout.write('KUBIC_WORKER_READY ' + (process.env.KUBIC_WORKER_ID ?? '') + '\\n');
const a = process.argv;
process.stdout.write(JSON.stringify({ ok: true, exitCode: 0, sessionId: a[a.indexOf('--session') + 1], status: 'completed', result: { summary: 'fixture done' } }) + String.fromCharCode(10));
process.exit(0);
`;

const scratchDirs: string[] = [];

function scratchRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function gitOrThrow(cwd: string, args: string[]): Promise<void> {
  const env = new NodeExecutionEnv(cwd);
  const done = await env.shell
    .spawn('git', args, { provenance: PROVENANCE })
    .wait();
  if (done.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${done.stderr}`);
  }
}

describe("prod orchestrate path: workers resolve the manager's models.json (issue #222)", () => {
  it('points each worker child at the manager root, so an untracked models.json resolves', async () => {
    vi.stubEnv('KUBIC_TRUST_PROJECT', '1');
    vi.stubEnv('KUBIC_MODELS_ROOT', '');
    const root = scratchRoot('kubic-orch-models-');
    await gitOrThrow(root, ['init', '-b', 'main']);
    await gitOrThrow(root, ['config', 'user.email', 'models@kubic.dev']);
    await gitOrThrow(root, ['config', 'user.name', 'kubic models']);
    await gitOrThrow(root, ['config', 'commit.gpgsign', 'false']);
    writeFileSync(join(root, 'base.txt'), 'base\n');
    await gitOrThrow(root, ['add', 'base.txt']);
    await gitOrThrow(root, ['commit', '-m', 'base']);
    // The provider config stays machine-local: untracked AND excluded, so
    // no worktree checkout ever contains it. The local endpoint is keyless
    // (a literal apiKey), so the issue #200 credential preflight has nothing
    // to deliver and this test keeps asserting the models-root propagation.
    writeFileSync(
      join(root, 'models.json'),
      JSON.stringify({
        providers: [
          {
            id: 'managers',
            baseUrl: 'http://127.0.0.1:1/v1',
            api: 'openai-completions',
            apiKey: 'not-needed',
            models: [{ id: 'm1' }],
          },
        ],
      }),
    );
    writeFileSync(join(root, '.git', 'info', 'exclude'), 'models.json\n');
    const fixture = join(scratchRoot('kubic-orch-models-child-'), 'child.mjs');
    writeFileSync(fixture, FIXTURE);
    const dumpDir = scratchRoot('kubic-orch-models-dump-');
    const deps = await orchestrateDepsWithDefaults({
      out: () => undefined,
      err: () => undefined,
      cwd: root,
      sessionsRoot: scratchRoot('kubic-orch-models-sessions-'),
      registry: new WorkerRegistry(),
      workerEntry: { cmd: process.execPath, args: [fixture] },
    });
    await runOrchestrateCommand(
      {
        prompt: `resolve models DUMPDIR=${dumpDir}`,
        agents: ['alpha'],
        yes: true,
        session: 'modelsroot',
      },
      deps,
    );
    const dump = JSON.parse(
      readFileSync(join(dumpDir, 'alpha.json'), 'utf8'),
    ) as {
      cwd: string;
      root: string | null;
      trust: string | null;
      hasModelsJson: boolean;
    };
    // The child ran in its own worktree, which lacks the untracked file…
    expect(realpathSync(dump.cwd)).not.toBe(realpathSync(root));
    expect(dump.hasModelsJson).toBe(false);
    // …and was told the manager's root plus the trust decision.
    expect(dump.root === null ? null : realpathSync(dump.root)).toBe(
      realpathSync(root),
    );
    expect(dump.trust).toBe('1');
    // Assembling as that child does resolves the manager's provider.
    const childCwd = existsSync(dump.cwd) ? dump.cwd : dumpDir;
    const assembled = await assembleModels(
      childCwd,
      {
        KUBIC_MODELS_ROOT: dump.root ?? '',
        KUBIC_TRUST_PROJECT: dump.trust ?? '',
      },
      { home: scratchRoot('kubic-orch-models-home-') },
    );
    expect(assembled.models.getProvider('managers')?.id).toBe('managers');
  });

  it('carries a store-granted trust decision to the child with no env export (issue #228)', async () => {
    // The operator did not export KUBIC_TRUST_PROJECT; the manager's trust
    // came from the durable store. The child's worktree path is not the key
    // that decision is recorded under, so the manager must synthesize the
    // env opt-in for the child — otherwise a committed config.toml would
    // refuse every worker.
    delete process.env.KUBIC_TRUST_PROJECT;
    expect(process.env.KUBIC_TRUST_PROJECT).toBeUndefined();
    vi.stubEnv('KUBIC_MODELS_ROOT', '');
    const root = scratchRoot('kubic-orch-trust-');
    await gitOrThrow(root, ['init', '-b', 'main']);
    await gitOrThrow(root, ['config', 'user.email', 'trust@kubic.dev']);
    await gitOrThrow(root, ['config', 'user.name', 'kubic trust']);
    await gitOrThrow(root, ['config', 'commit.gpgsign', 'false']);
    writeFileSync(join(root, 'base.txt'), 'base\n');
    await gitOrThrow(root, ['add', 'base.txt']);
    await gitOrThrow(root, ['commit', '-m', 'base']);
    const fixture = join(scratchRoot('kubic-orch-trust-child-'), 'child.mjs');
    writeFileSync(fixture, FIXTURE);
    const dumpDir = scratchRoot('kubic-orch-trust-dump-');
    const deps = await orchestrateDepsWithDefaults({
      out: () => undefined,
      err: () => undefined,
      cwd: root,
      sessionsRoot: scratchRoot('kubic-orch-trust-sessions-'),
      registry: new WorkerRegistry(),
      workerEntry: { cmd: process.execPath, args: [fixture] },
      // The store's per-root decision for the repo root the run loads.
      projectTrust: (path) => realpathSync(path) === realpathSync(root),
    });
    await runOrchestrateCommand(
      {
        prompt: `resolve trust DUMPDIR=${dumpDir}`,
        agents: ['alpha'],
        yes: true,
        session: 'trustproject',
      },
      deps,
    );
    const dump = JSON.parse(
      readFileSync(join(dumpDir, 'alpha.json'), 'utf8'),
    ) as { trust: string | null };
    expect(dump.trust).toBe('1');
  });
});
