// Prod runner wiring for the analysis surfaces: the runners must read the
// user's working directory and the SAME installed policy `kubic run` and
// `kubic doctor` use — not a filesystem root, not an empty policy.
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeExport } from '../../../packages/eval/src/rl/fixtures.js';
import { createNodeFileBridge } from '../../../packages/exec/src/file-bridge.js';
import { installedPolicyPosture } from '../../../packages/host/src/approvals.js';
import { NO_PROJECT_TRUST } from '../../../packages/host/src/config/trust-store.js';
import {
  appendToLedger,
  auditLedgerDir,
  soloDecisionAudit,
} from '../../../packages/host/src/policy/audit-ledger.js';
import {
  type WorkerRow,
  writeWorkerRows,
} from '../../../packages/worker/src/lifecycle/rows.js';
import type { CliConfigResult } from './config-runtime.js';
import { loadCliConfig } from './config-runtime.js';
import { createProdRunners } from './prod-runners.js';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const noConfig: CliConfigResult = {
  runtime: undefined,
  error: undefined,
  ignoreSplit: { missing: [], checked: [], applicable: false },
  trust: NO_PROJECT_TRUST,
};

// The prod runners colour from the real stdout; NO_COLOR pins plain text
// whatever terminal the test runner has.
function runners(): {
  lines: string[];
  errs: string[];
  r: ReturnType<typeof createProdRunners>;
} {
  vi.stubEnv('NO_COLOR', '1');
  const lines: string[] = [];
  const errs: string[] = [];
  return {
    lines,
    errs,
    r: createProdRunners({
      out: (line) => lines.push(line),
      debug: (line) => errs.push(line),
    }),
  };
}

describe('kubic export (prod wiring)', () => {
  it('resolves a relative --trajectory against the working directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prod-export-'));
    roots.push(dir);
    writeFileSync(join(dir, 'rel.json'), JSON.stringify(makeExport()));
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    const { lines, errs, r } = runners();
    expect(await r.export({ trajectory: 'rel.json' }, noConfig)).toBe(0);
    expect(errs).toEqual([]);
    expect(lines.join('\n')).toMatch(/^schema: /);
  });
});

describe('kubic policy (prod wiring)', () => {
  it('agrees with the installed policy doctor reports and run enforces', async () => {
    const { allowlist } = installedPolicyPosture({ workspace: process.cwd() });
    expect(allowlist.length).toBeGreaterThan(0);
    for (const tool of allowlist) {
      const { lines, r } = runners();
      await r.policy({ tool }, noConfig);
      expect(lines).toEqual([`allow ${tool} (installed)`]);
    }
    const { lines, r } = runners();
    await r.policy({ tool: 'network_fetch' }, noConfig);
    expect(lines).toEqual(['deny network_fetch (installed)']);
  });

  it('fails closed with the named reason when the config load was refused', async () => {
    const { lines, errs, r } = runners();
    const code = await r.policy(
      { tool: 'bash' },
      {
        runtime: undefined,
        error: "layer 'enterprise': unknown key 'bogus_key'",
        ignoreSplit: { missing: [], checked: [], applicable: false },
        trust: NO_PROJECT_TRUST,
      },
    );
    expect(code).toBe(1);
    expect(lines).toEqual([]);
    expect(errs).toEqual([
      "error: layer 'enterprise': unknown key 'bogus_key'",
    ]);
  });
});

describe('kubic audit (prod wiring)', () => {
  it('reads the repo §60 ledger the approval layers write', async () => {
    const root = mkdtempSync(join(tmpdir(), 'prod-audit-'));
    roots.push(root);
    appendToLedger(
      auditLedgerDir(root),
      soloDecisionAudit({
        sessionId: 's',
        toolName: 'bash',
        trigger: 'destructive-shell',
        workspace: root,
        approved: true,
        posture: 'approvals',
      }),
    );
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    const { lines, r } = runners();
    await r.audit({ mode: 'solo', json: true }, noConfig);
    const records = JSON.parse(lines.join('\n')) as { mode: string }[];
    expect(records.map((record) => record.mode)).toEqual(['solo']);
    const text = runners();
    await text.r.audit({ mode: 'solo' }, noConfig);
    expect(text.lines).toHaveLength(1);
    expect(text.lines[0]).toMatch(/^WHEN +MODE/);
    expect(text.lines[0]).toMatch(/ solo +approvals /);
  });
});

describe('kubic audit from a subdirectory', () => {
  it('reads the ledger at the repo root, where orchestrate writes it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'prod-audit-sub-'));
    roots.push(root);
    mkdirSync(join(root, '.git'));
    mkdirSync(join(root, 'pkg'));
    appendToLedger(
      auditLedgerDir(root),
      soloDecisionAudit({
        sessionId: 's',
        toolName: 'bash',
        trigger: 'destructive-shell',
        workspace: root,
        approved: true,
        posture: 'approvals',
      }),
    );
    vi.spyOn(process, 'cwd').mockReturnValue(join(root, 'pkg'));
    const { lines, r } = runners();
    await r.audit({ json: true }, noConfig);
    expect(lines.join('\n')).toContain('"mode": "solo"');
  });
});

describe('kubic workers from a subdirectory (issue #281)', () => {
  const liveRow: WorkerRow = {
    workerId: 'w1',
    sessionId: 'sess',
    generation: 1,
    status: 'ready',
    agentStatus: 'running',
    startedAtMs: Date.now(),
    ageMs: 0,
    owner: 'orch:sess',
    // The test's own pid is alive, so the row reads live either way.
    pid: process.pid,
  };
  function writeRowsAt(repo: string): void {
    mkdirSync(join(repo, '.kubic', 'orchestrator'), { recursive: true });
    writeWorkerRows(
      createNodeFileBridge(join(repo, '.kubic', 'orchestrator')),
      'workers.json',
      [liveRow],
    );
  }

  it('lists rows orchestrate wrote at the repo root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'prod-workers-sub-'));
    roots.push(root);
    mkdirSync(join(root, '.git'));
    mkdirSync(join(root, 'a', 'b'), { recursive: true });
    writeRowsAt(root);
    vi.spyOn(process, 'cwd').mockReturnValue(join(root, 'a', 'b'));
    const { lines, r } = runners();
    await r.workers({ command: 'list', json: true }, noConfig);
    expect(lines.join('\n')).toContain('"workerId": "w1"');
  });

  it('outside git the cwd behaviour is unchanged', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prod-workers-nogit-'));
    roots.push(dir);
    writeRowsAt(dir);
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    const { lines, r } = runners();
    await r.workers({ command: 'list', json: true }, noConfig);
    expect(lines.join('\n')).toContain('"workerId": "w1"');
  });
});

describe('kubic workers inspect/terminate (prod wiring, issue #167)', () => {
  let child: ChildProcess | undefined;
  afterEach(() => {
    // A terminated fixture stays dead; a failed assertion must not leak it.
    try {
      child?.kill('SIGKILL');
    } catch {
      // Already gone.
    }
    child = undefined;
  });

  function git(cwd: string, args: string[]): void {
    const done = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (done.status !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${done.stderr}`);
    }
  }

  it('inspect finds the worktree by branch and reports honest facets', async () => {
    const root = mkdtempSync(join(tmpdir(), 'prod-inspect-'));
    roots.push(root);
    git(root, ['init', '-q']);
    git(root, ['checkout', '-q', '-b', 'kubic/run-1/alpha']);
    // §35 keeps runtime state out of the commit path, like a real repo.
    writeFileSync(join(root, '.gitignore'), '.kubic/\n');
    git(root, ['add', '.gitignore']);
    git(root, [
      '-c',
      'user.email=test@local',
      '-c',
      'user.name=test',
      'commit',
      '-qm',
      'init',
    ]);
    mkdirSync(join(root, '.kubic', 'orchestrator'), { recursive: true });
    writeWorkerRows(
      createNodeFileBridge(join(root, '.kubic', 'orchestrator')),
      'workers.json',
      [
        {
          workerId: 'alpha',
          sessionId: 'run-1-alpha',
          generation: 1,
          status: 'ready',
          agentStatus: 'running',
          startedAtMs: Date.now(),
          ageMs: 0,
          owner: 'orchestrate:run-1',
          pid: process.pid,
        },
      ],
    );
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    const { lines, r } = runners();
    expect(await r.workers({ command: 'inspect', id: 'alpha' }, noConfig)).toBe(
      0,
    );
    const text = lines.join('\n');
    expect(text).toContain('alpha');
    expect(text).toContain(`kubic/run-1/alpha, clean`);
    expect(text).toContain('budget: none recorded');
    expect(text).toContain(
      'usage: accruing (kubic cost --session run-1-alpha)',
    );
    expect(text).toContain('approvals: none pending');
  });

  it('terminate signals a live fixture group and refuses it once gone', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prod-terminate-'));
    roots.push(dir);
    mkdirSync(join(dir, '.kubic', 'orchestrator'), { recursive: true });
    // A detached sleeper whose command line names the worker session —
    // the pid-reuse guard's positive case, with no worker lane involved.
    // (A script file, not `node -e`: node parses `-e` trailing flags as
    // its own options and dies with `bad option`.)
    writeFileSync(join(dir, 'sleeper.js'), 'setInterval(() => {}, 500);\n');
    child = spawn(
      process.execPath,
      [join(dir, 'sleeper.js'), '--session', 'run-9-w9'],
      { detached: true, stdio: 'ignore' },
    );
    child.unref();
    const pid = child.pid ?? 0;
    expect(pid).toBeGreaterThan(1);
    const exited = new Promise<void>((resolve) => {
      child?.once('exit', () => resolve());
    });
    writeWorkerRows(
      createNodeFileBridge(join(dir, '.kubic', 'orchestrator')),
      'workers.json',
      [
        {
          workerId: 'w9',
          sessionId: 'run-9-w9',
          generation: 3,
          status: 'ready',
          agentStatus: 'running',
          startedAtMs: Date.now(),
          ageMs: 0,
          owner: 'orchestrate:run-9',
          pid,
        },
      ],
    );
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    const first = runners();
    expect(
      await first.r.workers({ command: 'terminate', id: 'w9' }, noConfig),
    ).toBe(0);
    expect(first.lines.join('\n')).toContain(`terminated worker 'w9'`);
    await exited;
    // The row still claims live but the pid is gone: refused, never
    // signalled blind (a second terminate is not a second kill).
    const second = runners();
    expect(
      await second.r.workers({ command: 'terminate', id: 'w9' }, noConfig),
    ).toBe(1);
    expect(second.lines).toEqual([]);
  });
});

describe('kubic doctor: enterprise policy and detection-only (issue #289)', () => {
  function providerFixture(root: string, port: number): void {
    writeFileSync(
      join(root, 'models.json'),
      JSON.stringify({
        providers: [
          {
            id: 'gw',
            baseUrl: `http://127.0.0.1:${port}/v1`,
            api: 'openai-completions',
            apiKeyEnv: 'GW_API_KEY',
            models: [{ id: 'm1' }],
          },
        ],
      }),
    );
  }

  it('the default install names the lexical classes and stays exit 0', async () => {
    const root = mkdtempSync(join(tmpdir(), 'prod-doctor-289-default-'));
    roots.push(root);
    providerFixture(root, 9102);
    vi.stubEnv('GW_API_KEY', 'sk-doctor-289-not-a-real-key');
    vi.stubEnv('KUBIC_MODEL', 'gw/m1');
    vi.stubEnv('KUBIC_TRUST_PROJECT', '1');
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    const config = loadCliConfig({
      cwd: root,
      home: root,
      env: {
        ...process.env,
        GW_API_KEY: 'sk-doctor-289-not-a-real-key',
        KUBIC_MODEL: 'gw/m1',
        KUBIC_TRUST_PROJECT: '1',
      },
    });
    const { lines, r } = runners();
    const code = await r.doctor({ json: true }, config);
    const report = JSON.parse(lines.join('\n')) as {
      checks: Array<{ id: string; status: string; detail: string }>;
    };
    const detection = report.checks.find(
      (entry) => entry.id === 'policy:detection-only',
    );
    expect(detection?.status).toBe('warn');
    expect(detection?.detail).toContain('network=none');
    // No `[policy]` section: the enterprise checks are not wired at all.
    expect(report.checks.map((entry) => entry.id)).not.toContain(
      'policy:enterprise-network',
    );
    expect(code).toBe(0);
  });

  it('reports the per-agent resource posture honestly (issue #163)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'prod-doctor-163-'));
    roots.push(root);
    providerFixture(root, 9104);
    vi.stubEnv('GW_API_KEY', 'sk-doctor-163-not-a-real-key');
    vi.stubEnv('KUBIC_MODEL', 'gw/m1');
    vi.stubEnv('KUBIC_TRUST_PROJECT', '1');
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    const config = loadCliConfig({
      cwd: root,
      home: root,
      env: {
        ...process.env,
        GW_API_KEY: 'sk-doctor-163-not-a-real-key',
        KUBIC_MODEL: 'gw/m1',
        KUBIC_TRUST_PROJECT: '1',
      },
    });
    const { lines, r } = runners();
    const code = await r.doctor({ json: true }, config);
    const report = JSON.parse(lines.join('\n')) as {
      checks: Array<{ id: string; status: string; detail: string }>;
    };
    const resources = report.checks.find(
      (entry) => entry.id === 'limit:resources',
    );
    // The prod builder wires the probe (this test fails if the spread is
    // dropped) — and the line never claims a cap a stock CLI run does not
    // apply.
    expect(resources).toBeDefined();
    expect(resources?.detail).toContain('enforced: wall clock');
    expect(resources?.detail).toContain('NOT enforced: memory');
    expect(resources?.detail).toContain('no CLI flag/config key');
    expect(code).toBe(0);
  });

  it('a configured [policy] runs the enterprise checks in --json', async () => {
    const root = mkdtempSync(join(tmpdir(), 'prod-doctor-289-policy-'));
    roots.push(root);
    providerFixture(root, 9103);
    mkdirSync(join(root, '.kubic'), { recursive: true });
    writeFileSync(
      join(root, '.kubic', 'config.toml'),
      '[policy]\nnetwork_policy = "proxy"\n',
    );
    vi.stubEnv('KUBIC_TRUST_PROJECT', '1');
    vi.stubEnv('GW_API_KEY', 'sk-doctor-289-not-a-real-key');
    vi.stubEnv('KUBIC_MODEL', 'gw/m1');
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    const config = loadCliConfig({
      cwd: root,
      home: root,
      env: {
        ...process.env,
        KUBIC_TRUST_PROJECT: '1',
        GW_API_KEY: 'sk-doctor-289-not-a-real-key',
        KUBIC_MODEL: 'gw/m1',
      },
    });
    const { lines, r } = runners();
    const code = await r.doctor({ json: true }, config);
    const report = JSON.parse(lines.join('\n')) as {
      checks: Array<{
        id: string;
        status: string;
        reason: string;
        detail: string;
      }>;
    };
    const network = report.checks.find(
      (entry) => entry.id === 'policy:enterprise-network',
    );
    expect(network?.status).toBe('fail');
    expect(network?.reason).toBe('policy-mismatch');
    expect(network?.detail).toContain('no domains');
    expect(report.checks.map((entry) => entry.id)).toContain(
      'policy:enterprise-enforceability',
    );
    // The unenforceable value flips the exit (fail, not warn).
    expect(code).toBe(1);
  });
});

describe('kubic doctor: worker credential posture (issue #200)', () => {
  it('lists the provider each role gets credentials for, names only', async () => {
    const root = mkdtempSync(join(tmpdir(), 'prod-doctor-creds-'));
    roots.push(root);
    mkdirSync(join(root, '.kubic', 'roles'), { recursive: true });
    writeFileSync(
      join(root, '.kubic', 'roles', 'planner.md'),
      [
        '---',
        'role: planner',
        'tools: [read, ls, find, grep]',
        'filesystem: read',
        'shell: false',
        'network: none',
        'git: false',
        'credentials: none',
        '---',
        '',
        '# planner',
        '',
        '## Prompt',
        '',
        'You are the planner.',
        '',
      ].join('\n'),
    );
    // The default delegation set is two implementers (issue #178): the
    // posture describes the roles a bare `kubic orchestrate` assigns.
    writeFileSync(
      join(root, '.kubic', 'roles', 'implementer.md'),
      '---\nrole: implementer\ntools: [read, ls, find, grep, write, edit, bash]\nfilesystem: workspace-write\nshell: true\nnetwork: none\ngit: false\ncredentials: none\n---\n\n# implementer\n\n## Prompt\n\nBuild it.\n',
    );
    writeFileSync(
      join(root, 'models.json'),
      JSON.stringify({
        providers: [
          {
            id: 'gw',
            baseUrl: 'http://127.0.0.1:9100/v1',
            api: 'openai-completions',
            apiKeyEnv: 'GW_API_KEY',
            models: [{ id: 'm1' }],
          },
        ],
      }),
    );
    vi.stubEnv('KUBIC_TRUST_PROJECT', '1');
    vi.stubEnv('KUBIC_MODEL', 'gw/m1');
    vi.stubEnv('GW_API_KEY', 'sk-doctor-200-not-a-real-key');
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    const config = loadCliConfig({
      cwd: root,
      home: root,
      env: {
        ...process.env,
        KUBIC_TRUST_PROJECT: '1',
        KUBIC_MODEL: 'gw/m1',
        GW_API_KEY: 'sk-doctor-200-not-a-real-key',
      },
    });
    const { lines, r } = runners();
    expect(await r.doctor({ json: true }, config)).toBe(0);
    const report = JSON.parse(lines.join('\n')) as {
      checks: { id: string; status: string; detail: string }[];
    };
    const check = report.checks.find((entry) =>
      entry.id.endsWith('credentials:roles'),
    );
    expect(check?.status).toBe('pass');
    expect(check?.detail).toBe('implementer→gw');
    expect(check?.detail).not.toContain('sk-doctor-200-not-a-real-key');
  });

  it('fails by provider name when the worker credential cannot be delivered', async () => {
    const root = mkdtempSync(join(tmpdir(), 'prod-doctor-creds-miss-'));
    roots.push(root);
    mkdirSync(join(root, '.kubic', 'roles'), { recursive: true });
    writeFileSync(
      join(root, '.kubic', 'roles', 'planner.md'),
      '---\nrole: planner\ntools: [read, ls, find, grep]\nfilesystem: read\nshell: false\nnetwork: none\ngit: false\ncredentials: none\n---\n\n# planner\n\n## Prompt\n\nYou are the planner.\n',
    );
    writeFileSync(
      join(root, '.kubic', 'roles', 'implementer.md'),
      '---\nrole: implementer\ntools: [read, ls, find, grep, write, edit, bash]\nfilesystem: workspace-write\nshell: true\nnetwork: none\ngit: false\ncredentials: none\n---\n\n# implementer\n\n## Prompt\n\nBuild it.\n',
    );
    writeFileSync(
      join(root, 'models.json'),
      JSON.stringify({
        providers: [
          {
            id: 'gw',
            baseUrl: 'http://127.0.0.1:9101/v1',
            api: 'openai-completions',
            apiKeyEnv: 'GW_API_KEY',
            models: [{ id: 'm1' }],
          },
        ],
      }),
    );
    vi.stubEnv('KUBIC_TRUST_PROJECT', '1');
    vi.stubEnv('KUBIC_MODEL', 'gw/m1');
    const config = loadCliConfig({
      cwd: root,
      home: root,
      env: { ...process.env, KUBIC_TRUST_PROJECT: '1', KUBIC_MODEL: 'gw/m1' },
    });
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    const { lines, r } = runners();
    const code = await r.doctor({ json: true }, config);
    const report = JSON.parse(lines.join('\n')) as {
      checks: { id: string; status: string; detail: string }[];
    };
    const check = report.checks.find((entry) =>
      entry.id.endsWith('credentials:roles'),
    );
    expect(check?.status).toBe('fail');
    expect(check?.detail).toContain("provider 'gw'");
    // The failing dependency check flips doctor's exit (the orchestrate
    // preflight is the path that exits 6; doctor's dep matrix exits 1).
    expect(code).not.toBe(0);
  });
});
