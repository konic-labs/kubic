// What reaches a worker child's env (issue #201). A worker starts behind the
// §3.8 allowlist (`packages/worker/src/lifecycle/env.ts`) and loads its OWN
// config from its own worktree, so the opt-ins the manager resolved must
// survive the allowlist — or the child runs a different approval route,
// thinking level and journal retention than the manager reports, and a
// committed `.kubic/config.toml` in the worktree makes it refuse and exit 1.
//
// Drives the real composition-root adapter against real git and a REAL child
// process: the fixture child dumps its cwd and the KUBIC_ env it received, and
// the test then loads the config exactly as that child would (its cwd, its
// env, a scratch home). The untrusted half is the same seam from the other
// side: a manager without a trust decision must hand its child none, so the
// child's own load refuses the project layer. No provider is dialled.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  configRefusalExit,
  loadCliConfig,
} from '../../../apps/kubic/src/config-runtime.js';
import { orchestrateDepsWithDefaults } from '../../../apps/kubic/src/orchestrate-run.js';
import type { Provenance } from '../../exec/src/env.js';
import { NodeExecutionEnv } from '../../exec/src/env.js';
import { ENV_ALLOWLIST } from '../../worker/src/lifecycle/env.js';
import { WorkerRegistry } from '../../worker/src/lifecycle/registry.js';
import { RUNTIME_ENV_OVERRIDES } from './config/runtime.js';
import { runOrchestrateCommand } from './orchestrate-cli.js';

const PROVENANCE: Provenance = {
  sessionId: 'worker-env-prod',
  agentId: 'manager',
  toolCallId: 'issue-201',
  turnId: 0,
  operation: 'orchestrate_worker_env_prod',
};

// The committed project config: `outOfScope` is the leaf no documented env
// override can touch, so it is the evidence that the PROJECT layer loaded at
// all; retention/model carry values the manager's env overrides over.
const PROJECT_CONFIG = `
[journal]
retentionDays = 3
outOfScope = ["vendor/**"]

[model]
provider = "faux"
id = "child"
`;

// The child dumps what it received; the assertions below re-load the config
// from exactly this cwd + env, so the fixture never re-implements the loader.
const FIXTURE = `
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const argv = process.argv.slice(2);
const index = argv.indexOf('-p');
const prompt = index === -1 ? '' : (argv[index + 1] ?? '');
const dumpDir = /DUMPDIR=(\\S+)/.exec(prompt);
if (dumpDir !== null) {
  const keys = [
    'KUBIC_TRUST_PROJECT',
    'KUBIC_APPROVALS_ROUTE',
    'KUBIC_MODEL_THINKING',
    'KUBIC_JOURNAL_RETENTION_DAYS',
  ];
  const env = {};
  for (const key of keys) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  const id = process.env.KUBIC_WORKER_ID ?? 'worker';
  writeFileSync(join(dumpDir[1], id + '.json'), JSON.stringify({
    cwd: process.cwd(),
    env,
  }));
}
process.stdout.write('KUBIC_WORKER_READY ' + (process.env.KUBIC_WORKER_ID ?? '') + '\\n');
const a = process.argv;
process.stdout.write(JSON.stringify({ ok: true, exitCode: 0, sessionId: a[a.indexOf('--session') + 1], status: 'completed', result: { summary: 'fixture done' } }) + String.fromCharCode(10));
process.exit(0);
`;

interface ChildDump {
  cwd: string;
  env: Record<string, string>;
}

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

// One repo tracking a committed `.kubic/config.toml`, one real orchestrate
// run, and the child's own dump — read back with the child's cwd and env.
async function runOneWorker(session: string): Promise<ChildDump> {
  const root = scratchRoot('kubic-orch-env-');
  await gitOrThrow(root, ['init', '-b', 'main']);
  await gitOrThrow(root, ['config', 'user.email', 'env@kubic.dev']);
  await gitOrThrow(root, ['config', 'user.name', 'kubic env']);
  await gitOrThrow(root, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(root, 'base.txt'), 'base\n');
  mkdirSync(join(root, '.kubic'), { recursive: true });
  writeFileSync(join(root, '.kubic', 'config.toml'), PROJECT_CONFIG);
  await gitOrThrow(root, ['add', 'base.txt', '.kubic/config.toml']);
  await gitOrThrow(root, ['commit', '-m', 'base with project config']);
  const fixture = join(scratchRoot('kubic-orch-env-child-'), 'child.mjs');
  writeFileSync(fixture, FIXTURE);
  const dumpDir = scratchRoot('kubic-orch-env-dump-');
  const deps = await orchestrateDepsWithDefaults({
    out: () => undefined,
    err: () => undefined,
    cwd: root,
    sessionsRoot: scratchRoot('kubic-orch-env-sessions-'),
    registry: new WorkerRegistry(),
    workerEntry: { cmd: process.execPath, args: [fixture] },
  });
  await runOrchestrateCommand(
    {
      prompt: `worker env DUMPDIR=${dumpDir}`,
      agents: ['alpha'],
      yes: true,
      session,
    },
    deps,
  );
  return JSON.parse(
    readFileSync(join(dumpDir, 'alpha.json'), 'utf8'),
  ) as ChildDump;
}

// The child's own view: its worktree cwd, its env, a home with no trust store.
function childConfig(dump: ChildDump) {
  return loadCliConfig({
    cwd: dump.cwd,
    env: dump.env,
    home: scratchRoot('kubic-orch-env-home-'),
  });
}

describe('every documented runtime env override reaches the child (issue #201)', () => {
  it('keeps RUNTIME_ENV_OVERRIDES and the spawn allowlist from drifting apart', () => {
    expect(
      Object.values(RUNTIME_ENV_OVERRIDES).filter(
        (name) => !(ENV_ALLOWLIST as readonly string[]).includes(name),
      ),
    ).toEqual([]);
  });
});

describe("prod orchestrate path: a worker's own config load (issue #201)", () => {
  it('loads the committed project config and applies the manager env overrides', async () => {
    vi.stubEnv('KUBIC_TRUST_PROJECT', '1');
    vi.stubEnv('KUBIC_APPROVALS_ROUTE', 'deny');
    vi.stubEnv('KUBIC_MODEL_THINKING', 'high');
    vi.stubEnv('KUBIC_JOURNAL_RETENTION_DAYS', '7');
    const dump = await runOneWorker('envtrusted');
    // The child ran in its own worktree — the committed project config is in
    // it — and received the manager's trust opt-in plus the overrides.
    expect(existsSync(join(dump.cwd, '.kubic', 'config.toml'))).toBe(true);
    expect(dump.env.KUBIC_TRUST_PROJECT).toBe('1');
    expect(dump.env.KUBIC_APPROVALS_ROUTE).toBe('deny');
    expect(dump.env.KUBIC_MODEL_THINKING).toBe('high');
    expect(dump.env.KUBIC_JOURNAL_RETENTION_DAYS).toBe('7');
    // Loading exactly as the child does: no refusal, the PROJECT layer's own
    // leaves present, and the manager's env overrides in force above them.
    const result = childConfig(dump);
    expect(result.error).toBeUndefined();
    const runtime = result.runtime;
    expect(runtime).toBeDefined();
    expect(runtime?.projectTrusted).toBe(true);
    expect(runtime?.journal.outOfScope).toEqual(['vendor/**']);
    expect(runtime?.journal.retentionDays).toBe(7);
    expect(runtime?.sources['journal.retentionDays']).toBe('env');
    expect(runtime?.approvals.policy.route).toBe('deny');
    expect(runtime?.approvals.source).toBe('env');
    expect(runtime?.model).toMatchObject({
      provider: 'faux',
      id: 'child',
      thinking: 'high',
    });
  });

  it('refuses the project config for the child of an untrusted manager', async () => {
    // No export and no store decision: the manager must not mint one for its
    // child, or an untrusted run would let every worker load the project layer.
    delete process.env.KUBIC_TRUST_PROJECT;
    expect(process.env.KUBIC_TRUST_PROJECT).toBeUndefined();
    const dump = await runOneWorker('envuntrusted');
    expect(dump.env.KUBIC_TRUST_PROJECT).toBeUndefined();
    const result = childConfig(dump);
    expect(result.runtime).toBeUndefined();
    expect(result.error).toMatch(/project-local config refused pre-trust/);
    // The same refusal the child's `kubic run` turns into exit 1.
    expect(configRefusalExit(result, 'run')).toBe(1);
  });
});
