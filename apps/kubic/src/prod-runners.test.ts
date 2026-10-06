// Prod runner wiring for the analysis surfaces: the runners must read the
// user's working directory and the SAME installed policy `kubic run` and
// `kubic doctor` use — not a filesystem root, not an empty policy.
import { type ChildProcess, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeExport } from '../../../packages/eval/src/rl/fixtures.js';
import { createNodeFileBridge } from '../../../packages/exec/src/file-bridge.js';
import { FileJournalStore } from '../../../packages/exec/src/journal.js';
import {
  createGitSandbox,
  disposeAllGitSandboxes,
  type GitSandbox,
} from '../../../packages/exec/src/test-support/git-sandbox.js';
import { installedPolicyPosture } from '../../../packages/host/src/approvals.js';
import {
  NO_PROJECT_TRUST,
  ProjectTrustStore,
  projectTrustStorePath,
} from '../../../packages/host/src/config/trust-store.js';
import { approvalsSessionDir } from '../../../packages/host/src/orchestrator/approvals/worker-asks.js';
import {
  appendToLedger,
  auditLedgerDir,
  soloDecisionAudit,
} from '../../../packages/host/src/policy/audit-ledger.js';
import { defaultSessionsRoot } from '../../../packages/host/src/sessions-cli.js';
import { buildTrajectoryExport } from '../../../packages/trajectory/src/export.js';
import {
  type WorkerRow,
  writeWorkerRows,
} from '../../../packages/worker/src/lifecycle/rows.js';
import type { CliConfigResult } from './config-runtime.js';
import { loadCliConfig } from './config-runtime.js';
import { createProdRunners, prodTuiDeps } from './prod-runners.js';
import { tuiDepsWithDefaults } from './tui-run.js';

const roots: string[] = [];
let driver: GitSandbox | undefined;
afterEach(() => {
  driver = undefined;
  disposeAllGitSandboxes();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
  // The default sessions root lives under the temp HOME: runs and
  // retention tests seed it, so sweep it too (nothing in this file
  // carries a session across tests).
  rmSync(defaultSessionsRoot(), { recursive: true, force: true });
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
    // Shared sandbox driver (issue #420): the workers path reads git
    // state, so setup and production share one injected scrubbed view.
    driver ??= createGitSandbox({ injectProcessEnv: true });
    driver.git(args, { cwd });
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

describe('kubic doctor --session (prod wiring, issue #310)', () => {
  it('refuses a session id that cannot name a session directory', async () => {
    const { errs, r } = runners();
    expect(await r.doctor({ session: '../evil' }, noConfig)).toBe(2);
    expect(errs.join('\n')).toContain('invalid --session id');
  });
});

describe('kubic workers list resources (prod wiring, issue #248)', () => {
  let child: ChildProcess | undefined;
  afterEach(() => {
    try {
      child?.kill('SIGKILL');
    } catch {
      // Already gone.
    }
    child = undefined;
  });

  it('shows live rss/cpu for a sleeping fixture child plus settled consumption', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prod-resources-'));
    roots.push(dir);
    mkdirSync(join(dir, '.kubic', 'orchestrator'), { recursive: true });
    writeFileSync(join(dir, 'sleeper.js'), 'setInterval(() => {}, 500);\n');
    child = spawn(
      process.execPath,
      [join(dir, 'sleeper.js'), '--session', 'run-7-w7'],
      { detached: true, stdio: 'ignore' },
    );
    child.unref();
    const pid = child.pid ?? 0;
    expect(pid).toBeGreaterThan(1);
    // The run's own record carries the settled usage rollup (§68): a
    // hand-written durable state file, no mocks.
    writeFileSync(
      join(dir, '.kubic', 'orchestrator', 'run-7.json'),
      JSON.stringify({
        // Issue #285 (§71): the run's stored §71 bound rides the same
        // record the consumption comes from — no extra reads.
        budget: { shared: { maxToolCalls: 10, maxCostUsd: 0.5 } },
        records: [
          {
            agentId: 'w7',
            result: {
              metrics: {
                inputTokens: 1200,
                outputTokens: 300,
                toolCalls: 5,
                costUsd: 0.012,
              },
            },
          },
        ],
      }),
    );
    writeWorkerRows(
      createNodeFileBridge(join(dir, '.kubic', 'orchestrator')),
      'workers.json',
      [
        {
          workerId: 'w7',
          sessionId: 'run-7-w7',
          generation: 1,
          status: 'ready',
          agentStatus: 'running',
          startedAtMs: Date.now(),
          ageMs: 0,
          owner: 'orchestrate:run-7',
          pid,
        },
      ],
    );
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    const { lines, r } = runners();
    expect(await r.workers({ command: 'list' }, noConfig)).toBe(0);
    const text = lines.join('\n');
    expect(text).toMatch(/rss=\d+(\.\d+)?MB/);
    expect(text).toMatch(/cpu=\d+(\.\d+)?%/);
    expect(text).toContain('tok=1.5k');
    expect(text).toContain('cost=$0.012');
    // Issue #285: the BUDGET column burns the settled spend down from
    // the stored bound.
    expect(text).toContain('tools 5/10');
    expect(text).toContain('$0.012/$0.50');
    const json = runners();
    expect(
      await json.r.workers({ command: 'list', json: true }, noConfig),
    ).toBe(0);
    const doc = JSON.parse(json.lines.join('\n')) as Record<string, unknown>[];
    expect(doc[0]?.resourceUsage).toMatchObject({
      cpuPct: expect.any(Number),
    });
    expect(doc[0]?.consumption).toMatchObject({ costUsd: 0.012 });
    expect(doc[0]?.budget).toEqual({
      limits: { maxToolCalls: 10, maxCostUsd: 0.5 },
      usage: { tokens: 1500, costUsd: 0.012, toolCalls: 5 },
    });
  });
});

describe('kubic workers refuses owner-derived state paths (issue #437)', () => {
  function metricsFile(agentId: string): string {
    return JSON.stringify({
      records: [
        {
          agentId,
          result: {
            metrics: { inputTokens: 9999, toolCalls: 2, costUsd: 0.009 },
          },
        },
      ],
    });
  }

  function evilRepo(
    tag: string,
    owner: string,
  ): { dir: string; orchDir: string } {
    const dir = mkdtempSync(join(tmpdir(), tag));
    roots.push(dir);
    const orchDir = join(dir, '.kubic', 'orchestrator');
    mkdirSync(orchDir, { recursive: true });
    writeWorkerRows(createNodeFileBridge(orchDir), 'workers.json', [
      {
        workerId: 'w9',
        sessionId: 'run-9-w9',
        generation: 1,
        status: 'ready',
        agentStatus: 'running',
        startedAtMs: Date.now(),
        ageMs: 0,
        owner,
      },
    ]);
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    return { dir, orchDir };
  }

  it('list does not read a run state reached by `..` in the owner', async () => {
    const { dir } = evilRepo('prod-ownerescape-', 'orchestrate:../decoy');
    // The decoy a traversal would land on: reachable only from outside
    // the orchestrator dir.
    writeFileSync(join(dir, '.kubic', 'decoy.json'), metricsFile('w9'));
    const { lines, r } = runners();
    expect(await r.workers({ command: 'list' }, noConfig)).toBe(0);
    expect(lines.join('\n')).not.toContain('tok=');
  });

  it('inspect does not read it either', async () => {
    const { dir } = evilRepo('prod-ownerescape-', 'orchestrate:../decoy');
    writeFileSync(join(dir, '.kubic', 'decoy.json'), metricsFile('w9'));
    const { lines, r } = runners();
    expect(await r.workers({ command: 'inspect', id: 'w9' }, noConfig)).toBe(0);
    const text = lines.join('\n');
    expect(text).toContain('usage: accruing');
    expect(text).not.toContain('tok=');
  });

  it('terminate never consults the owner-derived state', async () => {
    evilRepo('prod-ownerescape-', 'orchestrate:../decoy');
    const { lines, errs, r } = runners();
    expect(await r.workers({ command: 'terminate', id: 'w9' }, noConfig)).toBe(
      1,
    );
    expect(lines.join('\n')).not.toContain('tok=');
    expect(errs.join('\n')).toMatch(/code=worker_not_running/);
  });

  it('refuses a run-state symlink pointing outside the run dir', async () => {
    const { dir, orchDir } = evilRepo(
      'prod-ownerescape-',
      'orchestrate:linked',
    );
    writeFileSync(join(dir, 'secret.json'), metricsFile('w9'));
    symlinkSync(join(dir, 'secret.json'), join(orchDir, 'linked.json'));
    const { lines, r } = runners();
    expect(await r.workers({ command: 'list' }, noConfig)).toBe(0);
    expect(lines.join('\n')).not.toContain('tok=');
  });
});

// Config `[session] retentionDays` reaches the runners that prune (issue
// #381: replaces the source-regex wiring pins with behaviour through
// createProdRunners — an aged session is pruned, an aged entry healed).
describe('kubic sessions/journal retention (prod wiring)', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;

  // A home global layer setting `[session] retentionDays` (the project
  // layer would need a trust grant first), loaded through the
  // composition root's own config seam.
  function configWithRetention(days: number): CliConfigResult {
    const home = mkdtempSync(join(tmpdir(), 'prod-ret-home-'));
    roots.push(home);
    mkdirSync(join(home, '.kubic'), { recursive: true });
    writeFileSync(
      join(home, '.kubic', 'config.toml'),
      `[session]\nretentionDays = ${days}\n`,
    );
    const cwd = mkdtempSync(join(tmpdir(), 'prod-ret-cwd-'));
    roots.push(cwd);
    const loaded = loadCliConfig({ cwd, home, env: {} });
    expect(loaded.error).toBeUndefined();
    return loaded;
  }

  // A session-state dir shaped like the prune plan reads it, aged by ageMs.
  function agedSession(root: string, id: string, ageMs: number): void {
    const dir = join(root, id);
    mkdirSync(join(dir, 'journal'), { recursive: true });
    writeFileSync(join(dir, 'journal', 'index.jsonl'), 'index!!');
    writeFileSync(join(dir, 'spans.jsonl'), 'spans');
    const secs = (Date.now() - ageMs) / 1000;
    utimesSync(dir, secs, secs);
  }

  it('sessions prune deletes an aged session under the configured window', async () => {
    const config = configWithRetention(30);
    // The runner reads the default sessions root (a temp HOME under test).
    const sroot = defaultSessionsRoot();
    mkdirSync(sroot, { recursive: true });
    agedSession(sroot, 'aged-381', 31 * DAY_MS);
    const { lines, r } = runners();
    expect(await r.sessions({ command: 'prune', yes: true }, config)).toBe(0);
    expect(existsSync(join(sroot, 'aged-381'))).toBe(false);
    expect(lines.join('\n')).toContain('pruned aged-381');
  });

  it('journal log heals aged entries under the same window', async () => {
    const config = configWithRetention(7);
    const sroot = defaultSessionsRoot();
    const journalDir = join(sroot, 'sess-381', 'journal');
    const store = new FileJournalStore(journalDir);
    store.append({
      path: 'aged.txt',
      op: 'write',
      before: 'old\n',
      after: 'older\n',
      bytesDelta: 0,
      sessionId: 'sess-381',
      agentId: 'root',
      toolCallId: 'call-aged',
      timestamp: Date.now() - 30 * DAY_MS,
    });
    store.append({
      path: 'fresh.txt',
      op: 'write',
      before: 'new\n',
      after: 'newer\n',
      bytesDelta: 0,
      sessionId: 'sess-381',
      agentId: 'root',
      toolCallId: 'call-fresh',
      timestamp: Date.now(),
    });
    const { lines, r } = runners();
    expect(
      await r.journal({ command: 'log', session: 'sess-381' }, config),
    ).toBe(0);
    const text = lines.join('\n');
    expect(text).toContain('fresh.txt');
    expect(text).not.toContain('aged.txt');
    expect(
      new FileJournalStore(journalDir).entries().map((entry) => entry.path),
    ).toEqual(['fresh.txt']);
  });
});

// The models/doctor wiring through createProdRunners (issue #381): a
// broken project models.json is reported exactly once, and the roles
// probe `kubic doctor` injects is visible in its report — the two
// behaviours the deleted source-regex pins stood in for.
describe('kubic models/doctor (prod wiring)', () => {
  it('prints a broken project models.json note exactly once', async () => {
    const root = mkdtempSync(join(tmpdir(), 'prod-models-note-'));
    roots.push(root);
    writeFileSync(join(root, 'models.json'), '{ not json');
    vi.stubEnv('KUBIC_TRUST_PROJECT', '1');
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    const config = loadCliConfig({
      cwd: root,
      home: root,
      env: { ...process.env, KUBIC_TRUST_PROJECT: '1' },
    });
    expect(config.error).toBeUndefined();
    const { lines, errs, r } = runners();
    expect(await r.models({}, config)).toBe(0);
    const notes = [...lines, ...errs].filter((line) =>
      line.includes('models.json ignored:'),
    );
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('models.json');
  });

  it('reports the roles probe: a contradictory role document fails by name', async () => {
    const root = mkdtempSync(join(tmpdir(), 'prod-doctor-roles-'));
    roots.push(root);
    mkdirSync(join(root, '.kubic', 'roles'), { recursive: true });
    writeFileSync(
      join(root, '.kubic', 'roles', 'liar.md'),
      '---\nrole: liar\ntools: [read, write]\nfilesystem: read\nshell: false\nnetwork: none\ngit: false\ncredentials: none\n---\n\n# liar\n\nGo.\n',
    );
    vi.stubEnv('KUBIC_TRUST_PROJECT', '1');
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    const config = loadCliConfig({
      cwd: root,
      home: root,
      env: { ...process.env, KUBIC_TRUST_PROJECT: '1' },
    });
    expect(config.error).toBeUndefined();
    const { lines, r } = runners();
    // A failing probe flips the exit code: the wiring carries the
    // refusal all the way to the process result, not just the report.
    expect(await r.doctor({ json: true }, config)).toBe(6);
    const report = JSON.parse(lines.join('\n')) as {
      checks: Array<{ id: string; status: string; detail?: string }>;
    };
    const liar = report.checks.find((entry) => entry.id === 'role:liar');
    expect(liar?.status).toBe('fail');
    expect(liar?.detail ?? '').toMatch(
      /filesystem is 'read' but write tool 'write'/,
    );
  });
});

// run/tui config projections through createProdRunners (issue #381): the
// `[journal] outOfScope` exclusion and the `[agent] name` attribution the
// deleted source-regex pins stood in for — observed in the journal the
// lane writes, not in the composition root's source text.
describe('kubic run projections (prod wiring)', () => {
  function trustedProjectConfig(toml: string): {
    config: CliConfigResult;
    project: string;
  } {
    const home = mkdtempSync(join(tmpdir(), 'prod-run-home-'));
    roots.push(home);
    const project = mkdtempSync(join(tmpdir(), 'prod-run-project-'));
    roots.push(project);
    mkdirSync(join(project, '.kubic'), { recursive: true });
    writeFileSync(join(project, '.kubic', 'config.toml'), toml);
    new ProjectTrustStore(projectTrustStorePath(home)).set(project, true);
    vi.stubEnv('KUBIC_TRUST_PROJECT', '1');
    const loaded = loadCliConfig({
      cwd: project,
      home,
      env: { ...process.env, KUBIC_TRUST_PROJECT: '1' },
    });
    expect(loaded.error).toBeUndefined();
    expect(loaded.runtime).toBeDefined();
    return { config: loaded, project };
  }

  function journalEntries(sessionId: string): Array<{
    path?: string;
    agentId?: string;
  }> {
    return new FileJournalStore(
      join(defaultSessionsRoot(), sessionId, 'journal'),
    ).entries() as Array<{ path?: string; agentId?: string }>;
  }

  // The `journal:<id>` ref the run envelope prints (no explicit --session
  // was passed, so the run created its own).
  function journalIdOf(lines: string[]): string {
    const match = lines.join('\n').match(/journal:([A-Za-z0-9_-]+)/);
    expect(match?.[1]).toBeDefined();
    return match?.[1] as string;
  }

  it('excludes a configured out-of-scope path from the run journal', async () => {
    const { config, project } = trustedProjectConfig(
      '[journal]\noutOfScope = ["vendor"]\n',
    );
    mkdirSync(join(project, 'vendor'), { recursive: true });
    vi.stubEnv('KUBIC_PROVIDER', 'faux');
    vi.stubEnv('KUBIC_NO_NOTICE', '1');
    vi.spyOn(process, 'cwd').mockReturnValue(project);
    const { lines, r } = runners();
    const code = await r.run(
      {
        prompt:
          'faux:tool bash {"command":"echo v2 > in-scope.txt && echo gen > vendor/out.js"}',
        json: true,
      },
      config,
    );
    expect(code).toBe(0);
    expect(existsSync(join(project, 'in-scope.txt'))).toBe(true);
    expect(existsSync(join(project, 'vendor', 'out.js'))).toBe(true);
    // Both files changed on disk; only the in-scope one was journaled.
    expect(
      journalEntries(journalIdOf(lines)).map((entry) => entry.path),
    ).toEqual(['in-scope.txt']);
  });

  it('attributes the run journal to the configured agent name', async () => {
    const { config, project } = trustedProjectConfig(
      '[agent]\nname = "alice"\n',
    );
    vi.stubEnv('KUBIC_PROVIDER', 'faux');
    vi.stubEnv('KUBIC_NO_NOTICE', '1');
    vi.spyOn(process, 'cwd').mockReturnValue(project);
    const { lines, r } = runners();
    const code = await r.run(
      {
        prompt: 'faux:tool bash {"command":"touch marker"}',
        json: true,
      },
      config,
    );
    expect(code).toBe(0);
    const entries = journalEntries(journalIdOf(lines));
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) expect(entry.agentId).toBe('alice');
  });
});

// The clean wiring through createProdRunners (issue #381): a configured
// `[orchestrator] root` is the disposal root — a worktree under the
// custom root is listed by --dry-run and left in place.
describe('kubic clean (prod wiring)', () => {
  it('lists a retained worktree under the configured root on --dry-run', async () => {
    const sandbox = createGitSandbox({ injectProcessEnv: true });
    const root = sandbox.path;
    writeFileSync(join(root, 'base.txt'), 'base\n');
    sandbox.git(['add', '-A']);
    sandbox.git(['commit', '-qm', 'base']);
    const custom = join(root, '.kubic-custom', 'wt', 'worker-1');
    sandbox.git(['worktree', 'add', custom, '-b', 'kubic/worker-1']);
    mkdirSync(join(root, '.kubic'), { recursive: true });
    writeFileSync(
      join(root, '.kubic', 'config.toml'),
      '[orchestrator]\nroot = ".kubic-custom/wt"\n',
    );
    const home = mkdtempSync(join(tmpdir(), 'prod-clean-home-'));
    roots.push(home);
    new ProjectTrustStore(projectTrustStorePath(home)).set(root, true);
    vi.stubEnv('KUBIC_TRUST_PROJECT', '1');
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    const config = loadCliConfig({
      cwd: root,
      home,
      env: { ...process.env, KUBIC_TRUST_PROJECT: '1' },
    });
    expect(config.error).toBeUndefined();
    expect(config.runtime?.orchestrator.root).toBe('.kubic-custom/wt');
    const { lines, r } = runners();
    expect(await r.clean({ dryRun: true }, config)).toBe(0);
    expect(lines.join('\n')).toContain(`would remove worktree ${custom}`);
    // Dry-run mutates nothing: the worktree and its branch survive.
    expect(existsSync(custom)).toBe(true);
    expect(
      sandbox.git([
        'branch',
        '--list',
        'kubic/worker-1',
        '--format=%(refname:short)',
      ]),
    ).toContain('kubic/worker-1');
  });
});

// The tui wiring through createProdRunners (issue #381): orchestrator
// mode outside a git repo is refused before the alt-screen opens, and
// the lane projection the interactive boot consumes names the configured
// agent — the tui third of the deleted lane-spread pin (the run third is
// behavioural above; the interactive lane itself boots only on a TTY).
describe('kubic tui (prod wiring)', () => {
  it('refuses orchestrator mode outside a git repo, naming solo', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'prod-tui-plain-'));
    roots.push(plain);
    vi.spyOn(process, 'cwd').mockReturnValue(plain);
    const { lines, errs, r } = runners();
    expect(await r.tui({ orchestrator: true }, noConfig)).toBe(5);
    expect([...lines, ...errs].join('\n')).toContain(
      'orchestrator mode needs a git repository',
    );
  });

  it('threads the configured agent id to the interactive lane deps', async () => {
    const home = mkdtempSync(join(tmpdir(), 'prod-tui-home-'));
    roots.push(home);
    const project = mkdtempSync(join(tmpdir(), 'prod-tui-project-'));
    roots.push(project);
    mkdirSync(join(project, '.kubic'), { recursive: true });
    writeFileSync(
      join(project, '.kubic', 'config.toml'),
      '[agent]\nname = "alice"\n',
    );
    new ProjectTrustStore(projectTrustStorePath(home)).set(project, true);
    const loaded = loadCliConfig({ cwd: project, home, env: {} });
    expect(loaded.error).toBeUndefined();
    expect(
      prodTuiDeps({ out: () => undefined, debug: () => undefined }, loaded)
        .agentId,
    ).toBe('alice');
  });

  // Issue #462: the first screen's version and trust row reach the run deps
  // through the real builders (a field the defaults drop stays green
  // otherwise).
  it('threads the version and the project trust to the first screen', () => {
    const home = mkdtempSync(join(tmpdir(), 'prod-tui-home-'));
    roots.push(home);
    const project = mkdtempSync(join(tmpdir(), 'prod-tui-project-'));
    roots.push(project);
    mkdirSync(join(project, '.kubic'), { recursive: true });
    writeFileSync(join(project, '.kubic', 'config.toml'), '[journal]\n');
    new ProjectTrustStore(projectTrustStorePath(home)).set(project, true);
    const loaded = loadCliConfig({ cwd: project, home, env: {} });
    const deps = tuiDepsWithDefaults(
      prodTuiDeps(
        {
          out: () => undefined,
          debug: () => undefined,
          version: () => '1.2.3',
        },
        loaded,
      ),
    );
    expect(deps.version).toBe('1.2.3');
    expect(deps.projectTrust).toBe('loaded');
    const bare = mkdtempSync(join(tmpdir(), 'prod-tui-bare-'));
    roots.push(bare);
    const none = tuiDepsWithDefaults(
      prodTuiDeps(
        { out: () => undefined, debug: () => undefined },
        loadCliConfig({ cwd: bare, home, env: {} }),
      ),
    );
    expect('projectTrust' in none).toBe(false);
    expect('version' in none).toBe(false);
  });
});

// One positive smoke per remaining runner key through createProdRunners
// (issue #381, acceptance "every key invoked"): each asserts an
// observable effect of the composed deps, never the composition source.
describe('remaining runners (prod wiring smokes)', () => {
  it('git status names the branch of the working repo', async () => {
    const sandbox = createGitSandbox({ injectProcessEnv: true });
    writeFileSync(join(sandbox.path, 'base.txt'), 'base\n');
    sandbox.git(['add', '-A']);
    sandbox.git(['commit', '-qm', 'base']);
    vi.spyOn(process, 'cwd').mockReturnValue(sandbox.path);
    const { lines, r } = runners();
    expect(await r.git({ command: 'status' }, noConfig)).toBe(0);
    expect(lines.join('\n')).toContain('branch main');
  });

  it('skills lists nothing discovered over an empty tree', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'prod-skills-'));
    roots.push(bare);
    vi.spyOn(process, 'cwd').mockReturnValue(bare);
    // The empty-discovery note is diagnostics (log.info), not stdout.
    const { lines, errs, r } = runners();
    expect(await r.skills({}, noConfig)).toBe(0);
    expect([...lines, ...errs].join('\n')).toContain('no skills discovered');
  });

  it('config prints the effective configuration as one JSON document', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'prod-config-'));
    roots.push(empty);
    const loaded = loadCliConfig({ cwd: empty, home: empty, env: {} });
    expect(loaded.error).toBeUndefined();
    const { lines, r } = runners();
    expect(await r.config({ json: true }, loaded)).toBe(0);
    const parsed = JSON.parse(lines.join('\n')) as { layers?: unknown };
    expect(parsed).toHaveProperty('layers');
  });

  it('trust --list reports an empty store by name', async () => {
    const home = mkdtempSync(join(tmpdir(), 'prod-trust-home-'));
    roots.push(home);
    const { lines, r } = runners();
    expect(
      await r.trust(
        { list: true },
        { ...noConfig, trust: { ...NO_PROJECT_TRUST, home } },
      ),
    ).toBe(0);
    expect(lines.join('\n')).toContain('no project trust decisions recorded');
  });

  it('cost reports no rows for a workspace with no usage', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'prod-cost-'));
    roots.push(ws);
    vi.spyOn(process, 'cwd').mockReturnValue(ws);
    const { lines, r } = runners();
    expect(await r.cost({}, noConfig)).toBe(0);
    expect(lines.join('\n')).toContain('no cost rows');
  });

  it('perf evaluates supplied samples against the named budget', async () => {
    const { lines, r } = runners();
    expect(await r.perf({ budget: 'spawn', samples: '5,6,7' }, noConfig)).toBe(
      0,
    );
    expect(lines.join('\n')).toMatch(/within/);
  });
});

// The orchestrate approval bound through createProdRunners (issue #381):
// with no injected seat and stdin not a TTY, the runner attaches no seat
// (the deleted orchestrate-run.ts source pin), so a worker's challenged
// call denies closed on the child's own bound with the named reason.
describe('kubic orchestrate approvals (prod wiring)', () => {
  const ASK_MODULE = fileURLToPath(
    new URL(
      '../../../packages/host/src/orchestrator/approvals/worker-asks.js',
      import.meta.url,
    ),
  );
  const ASK_BOUND = `
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
process.stdout.write('KUBIC_WORKER_READY ' + (process.env.KUBIC_WORKER_ID ?? '') + String.fromCharCode(10));
const dir = process.env.KUBIC_APPROVALS_DIR;
const verifyKey = process.env.KUBIC_APPROVALS_VERIFY_KEY;
const agentId = process.env.KUBIC_WORKER_ID ?? 'worker';
const { publishWorkerAsk, awaitWorkerAskAnswer } = await import(
  __ASK_MODULE_URL__,
);
const published = publishWorkerAsk(dir, {
  trigger: 'network',
  toolName: 'bash',
  args: { command: 'curl https://example.com/release.tgz' },
  justification: 'the plan step needs the release tarball',
  sessionId: process.env.KUBIC_WORKER_SESSION ?? 'unknown',
  agentId,
  role: 'worker',
  worktree: process.cwd(),
  provenance: { parentSessionId: process.env.KUBIC_ORCHESTRATOR_SESSION ?? 'unknown' },
});
const answer = await awaitWorkerAskAnswer(dir, published.request.key, {
  maxPendingMs: 100,
  pollMs: 10,
  verifyKey,
  nonce: published.nonce,
});
writeFileSync(
  join(dir, agentId + '.child.json'),
  JSON.stringify({ key: published.request.key, answer }),
);
process.exit(answer.approved ? 0 : 4);
`;
  const ASK_LOADER = `
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export async function resolve(specifier, context, next) {
  if (specifier.endsWith('.js')) {
    try {
      const base = specifier.startsWith('file://')
        ? specifier
        : specifier.startsWith('/')
          ? 'file://' + specifier
          : context.parentURL === undefined
            ? undefined
            : new URL(specifier, context.parentURL).href;
      if (base !== undefined) {
        const candidate = new URL(base.slice(0, -3) + '.ts');
        if (existsSync(fileURLToPath(candidate))) {
          return next(candidate.href, context);
        }
      }
    } catch { /* fall through */ }
  }
  return next(specifier, context);
}
`;

  it('a worker ask with no seat denies closed on the bound, exit 4', async () => {
    const sandbox = createGitSandbox({ injectProcessEnv: true });
    const root = sandbox.path;
    writeFileSync(join(root, 'base.txt'), 'base\n');
    sandbox.git(['add', '-A']);
    sandbox.git(['commit', '-qm', 'base']);
    const childDir = mkdtempSync(join(tmpdir(), 'prod-ask-child-'));
    roots.push(childDir);
    const fixture = join(childDir, 'worker-child.mjs');
    writeFileSync(
      fixture,
      ASK_BOUND.replace(
        '__ASK_MODULE_URL__',
        JSON.stringify(pathToFileURL(ASK_MODULE).href),
      ),
    );
    writeFileSync(join(childDir, 'loader-hook.mjs'), ASK_LOADER);
    writeFileSync(
      join(childDir, 'loader-register.mjs'),
      `import { register } from 'node:module';\nregister('./loader-hook.mjs', import.meta.url);\n`,
    );
    vi.stubEnv('KUBIC_PROVIDER', 'faux');
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    const { r, lines, errs } = runners();
    const started = Date.now();
    // No approvalsSeat injected and stdin is not a TTY under test, so
    // the runner's TTY default resolves to no seat: nothing answers.
    const code = await r.orchestrate(
      { prompt: 'do the work', session: 'orch-381', agents: ['worker-1'] },
      noConfig,
      {
        workerEntry: {
          cmd: process.execPath,
          args: [
            '--experimental-strip-types',
            '--import',
            join(childDir, 'loader-register.mjs'),
            fixture,
          ],
        },
      },
    );
    expect(code, [...lines, ...errs].join('\n')).toBe(4);
    expect(Date.now() - started).toBeLessThan(30_000);
    const evidence = JSON.parse(
      readFileSync(
        join(
          approvalsSessionDir(
            join(realpathSync(root), '.kubic', 'orchestrator'),
            'orch-381',
          ),
          'worker-1.child.json',
        ),
        'utf8',
      ),
    ) as { answer: { approved: boolean; code: string; reason: string } };
    expect(evidence.answer.approved).toBe(false);
    expect(evidence.answer.code).toBe('approval_timeout');
    expect(evidence.answer.reason).toMatch(/timed out after 100ms/);
  }, 60_000);
});

// The replay third of the lane projection (issue #381): a deterministic
// re-execution runs the recorded objective through the lane under the
// config's projections — the journal it writes carries the configured
// agent id, exactly as `kubic run` attributes its own.
describe('kubic replay lane projection (prod wiring)', () => {
  it('attributes the re-executed lane journal to the configured agent', async () => {
    const { config, project } = (() => {
      const home = mkdtempSync(join(tmpdir(), 'prod-replay-home-'));
      roots.push(home);
      const plan = mkdtempSync(join(tmpdir(), 'prod-replay-project-'));
      roots.push(plan);
      mkdirSync(join(plan, '.kubic'), { recursive: true });
      writeFileSync(
        join(plan, '.kubic', 'config.toml'),
        '[agent]\nname = "alice"\n',
      );
      new ProjectTrustStore(projectTrustStorePath(home)).set(plan, true);
      mkdirSync(join(plan, '.kubic', 'roles'), { recursive: true });
      writeFileSync(
        join(plan, '.kubic', 'roles', 'writer.md'),
        '---\nrole: writer\ntools: [read, bash]\nfilesystem: workspace-write\nshell: true\nnetwork: none\ngit: false\ncredentials: none\n---\n\n# writer\n\n## Prompt\n\nWrite.\n',
      );
      const loaded = loadCliConfig({
        cwd: plan,
        home,
        env: { ...process.env, KUBIC_TRUST_PROJECT: '1' },
      });
      expect(loaded.error).toBeUndefined();
      return { config: loaded, project: plan };
    })();
    const dir = mkdtempSync(join(tmpdir(), 'prod-replay-traj-'));
    roots.push(dir);
    const trajectory = join(dir, 't.json');
    writeFileSync(
      trajectory,
      JSON.stringify(
        buildTrajectoryExport({
          task: {
            taskId: 'task-1',
            objective: 'faux:tool bash {"command":"touch replay-marker"}',
            role: 'writer',
          },
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
          prompt: { text: 'touch the marker', constraints: [] },
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
            model: 'faux/echo',
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
    vi.stubEnv('KUBIC_PROVIDER', 'faux');
    vi.stubEnv('KUBIC_NO_NOTICE', '1');
    vi.stubEnv('KUBIC_TRUST_PROJECT', '1');
    vi.spyOn(process, 'cwd').mockReturnValue(project);
    const { lines, errs, r } = runners();
    const code = await r.replay(
      { trajectory, tier: 'deterministic', model: 'faux/echo', lockfile },
      config,
    );
    expect(code, [...lines, ...errs].join('\n')).toBe(0);
    expect(existsSync(join(project, 'replay-marker'))).toBe(true);
    // The re-executed lane journaled under the config's agent id — scan
    // the default sessions root for the marker entry (the replay mints
    // its own session, so the id is discovered, not assumed).
    const { readdirSync } = await import('node:fs');
    const found: Array<{ path?: string; agentId?: string }> = [];
    for (const id of readdirSync(defaultSessionsRoot())) {
      const journalDir = join(defaultSessionsRoot(), id, 'journal');
      if (!existsSync(join(journalDir, 'index.jsonl'))) continue;
      for (const entry of new FileJournalStore(journalDir).entries() as Array<{
        path?: string;
        agentId?: string;
      }>) {
        if (entry.path === 'replay-marker') found.push(entry);
      }
    }
    expect(found.length).toBeGreaterThan(0);
    for (const entry of found) expect(entry.agentId).toBe('alice');
  });
});
