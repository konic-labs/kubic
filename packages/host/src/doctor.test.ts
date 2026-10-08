// kubic doctor: providers, deps, policy
// mismatches, skip flag — with --json parity. Faux-only: probes are
// injected, never network.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileApprovalStore, installedPolicyPosture } from './approvals.js';
import type { DoctorDeps } from './doctor.js';
import { runDoctorCommand } from './doctor.js';
import { assembleModels, providerProbesOf } from './models-cli.js';
import {
  enterpriseDoctorChecks,
  resolveEffectivePolicy,
} from './policy/enterprise.js';

const made: string[] = [];

function mkTmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function cleanDeps(out: (line: string) => void): DoctorDeps {
  return {
    out,
    probeProviders: () => [
      { id: 'local', reachable: true, models: ['llama3'] },
    ],
    checkDeps: () => [{ id: 'node', ok: true, detail: 'v22.19.0' }],
    loadPolicy: () => ({ route: 'ask-user', autoApprove: [] }),
  };
}

describe('policy:detection-only and enterprise checks', () => {
  it('the default install names network=none as detection-only, exit stays 0', async () => {
    const lines: string[] = [];
    const code = (
      await runDoctorCommand(
        { json: true },
        {
          ...cleanDeps((line: string) => lines.push(line)),
          installedPolicy: () =>
            installedPolicyPosture({ workspace: process.cwd() }),
        },
      )
    ).exitCode;
    expect(code).toBe(0);
    const report = JSON.parse(lines.join('\n')) as {
      checks: Array<{
        id: string;
        status: string;
        reason: string;
        detail: string;
      }>;
    };
    const check = report.checks.find(
      (entry) => entry.id === 'policy:detection-only',
    );
    expect(check?.status).toBe('warn');
    expect(check?.reason).toBe('detection-only');
    expect(check?.detail).toContain('network=none');
    expect(check?.detail).toContain('lexical');
    expect(check?.detail).toContain('credentials=none');
  });

  it('emits no detection-only check without the installed-policy probe', async () => {
    const lines: string[] = [];
    await runDoctorCommand(
      { json: true },
      cleanDeps((line) => lines.push(line)),
    );
    const report = JSON.parse(lines.join('\n')) as {
      checks: Array<{ id: string }>;
    };
    expect(report.checks.map((check) => check.id)).not.toContain(
      'policy:detection-only',
    );
  });

  it('rides an unenforceable enterprise policy into the matrix and --json', async () => {
    const policy = resolveEffectivePolicy([
      {
        layer: 'enterprise',
        policy: {
          network: { mode: 'allowlist' },
          audit: { sinks: [{ kind: 'syslog', target: 'local0' }] },
        },
      },
    ]).policy;
    const lines: string[] = [];
    const code = (
      await runDoctorCommand(
        { json: true },
        {
          ...cleanDeps((line: string) => lines.push(line)),
          installedPolicy: () =>
            installedPolicyPosture({ workspace: process.cwd() }),
          enterpriseChecks: () =>
            enterpriseDoctorChecks(policy, { syslogAvailable: true }),
        },
      )
    ).exitCode;
    // The unenforceable allowlist (no domains) is a fail, so the exit flips.
    expect(code).toBe(1);
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
    expect(report.checks.map((entry) => entry.id)).toContain(
      'policy:detection-only',
    );
  });

  it('a throwing enterprise probe is a named fail, never a crash', async () => {
    const lines: string[] = [];
    const code = (
      await runDoctorCommand(
        { json: true },
        {
          ...cleanDeps((line: string) => lines.push(line)),
          enterpriseChecks: () => {
            throw new Error('policy disk gone');
          },
        },
      )
    ).exitCode;
    expect(code).toBe(1);
    const report = JSON.parse(lines.join('\n')) as {
      checks: Array<{
        id: string;
        status: string;
        reason: string;
        detail: string;
      }>;
    };
    const check = report.checks.find(
      (entry) => entry.id === 'policy:enterprise',
    );
    expect(check?.status).toBe('fail');
    expect(check?.reason).toBe('policy-mismatch');
    expect(check?.detail).toContain('policy disk gone');
  });
});

describe('runDoctorCommand', () => {
  it('clean run passes with exit 0', async () => {
    const lines: string[] = [];
    const code = (
      await runDoctorCommand(
        {},
        cleanDeps((line: string) => lines.push(line)),
      )
    ).exitCode;
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('0 fail');
  });

  it('--json output parses and matches the text run check-for-check', async () => {
    const textLines: string[] = [];
    await runDoctorCommand(
      {},
      cleanDeps((line: string) => textLines.push(line)),
    );
    const jsonLines: string[] = [];
    const code = (
      await runDoctorCommand(
        { json: true },
        cleanDeps((line: string) => jsonLines.push(line)),
      )
    ).exitCode;
    expect(code).toBe(0);
    const report = JSON.parse(jsonLines.join('\n')) as {
      ok: boolean;
      exitCode: number;
      checks: Array<{ id: string; status: string; reason: string }>;
    };
    expect(report.ok).toBe(true);
    expect(report.exitCode).toBe(0);
    expect(report.checks.map((check) => check.id)).toEqual([
      'provider:local',
      'dep:node',
      'policy:approvals',
      // Private-state posture is part of the matrix.
      'state:permissions',
      // License identity rides the same command.
      'license:kubic',
      // Honest-limits registration rides the same command.
      'limit:solo-no-isolation',
      'limit:no-injection-prevention',
      'limit:policy-offer',
      'limit:journal-not-backup',
      'limit:no-third-party-mcp',
      'limit:provider-availability',
      'limit:deps-present',
      'policy:enforceability',
    ]);
    const text = textLines.join('\n');
    for (const check of report.checks) {
      expect(text).toContain(check.id);
      expect(text).toContain(check.status.toUpperCase());
    }
  });

  it('provider-down fails distinct with exit 6 in text and --json', async () => {
    const deps = (out: (line: string) => void): DoctorDeps => ({
      ...cleanDeps(out),
      probeProviders: () => [
        {
          id: 'local',
          reachable: false,
          detail: 'ECONNREFUSED 127.0.0.1:11434',
        },
      ],
    });
    const textLines: string[] = [];
    const textCode = (
      await runDoctorCommand(
        {},
        deps((line: string) => textLines.push(line)),
      )
    ).exitCode;
    expect(textCode).toBe(6);
    expect(textLines.join('\n')).toContain('provider-down');
    const jsonLines: string[] = [];
    const jsonCode = (
      await runDoctorCommand(
        { json: true },
        deps((line: string) => jsonLines.push(line)),
      )
    ).exitCode;
    expect(jsonCode).toBe(6);
    const report = JSON.parse(jsonLines.join('\n')) as {
      ok: boolean;
      checks: Array<{ id: string; status: string; reason: string }>;
    };
    expect(report.ok).toBe(false);
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        id: 'provider:local',
        status: 'fail',
        reason: 'provider-down',
      }),
    );
  });

  it('policy mismatch fails distinct naming the capability', async () => {
    const lines: string[] = [];
    const deps = cleanDeps((line: string) => lines.push(line));
    deps.loadPolicy = () => ({ route: 'ask-user', autoApprove: ['bogus-cap'] });
    const code = (await runDoctorCommand({}, deps)).exitCode;
    expect(code).toBe(1);
    const text = lines.join('\n');
    expect(text).toContain('policy-mismatch');
    expect(text).toContain('bogus-cap');
  });

  it('--skip reports skipped checks and still passes clean', async () => {
    const lines: string[] = [];
    const code = (
      await runDoctorCommand(
        { skip: ['policy:approvals'] },
        cleanDeps((line: string) => lines.push(line)),
      )
    ).exitCode;
    expect(code).toBe(0);
    const text = lines.join('\n');
    expect(text).toContain('SKIP policy:approvals (skipped)');
    expect(text).toContain('1 skip');
  });

  it('unknown --skip id is a usage error', async () => {
    const lines: string[] = [];
    const code = (
      await runDoctorCommand(
        { skip: ['nope:missing'] },
        cleanDeps((line: string) => lines.push(line)),
      )
    ).exitCode;
    expect(code).toBe(2);
    expect(lines.join('\n')).toContain('unknown check');
  });

  it('main.ts-style wiring (assembled providers + node dep) passes clean', async () => {
    const dir = mkTmp('doctor-');
    // A provider must exist for a clean run: with zero providers the
    // honest-limits aggregate fails missing-provider.
    writeFileSync(
      join(dir, 'models.json'),
      JSON.stringify({
        providers: [
          {
            id: 'local',
            baseUrl: 'http://127.0.0.1:11434',
            api: 'openai-completions',
            models: [{ id: 'llama3' }],
          },
        ],
      }),
    );
    const assembled = await assembleModels(
      dir,
      { KUBIC_TRUST_PROJECT: '1' },
      { home: dir },
    );
    const lines: string[] = [];
    const code = (
      await runDoctorCommand(
        {},
        {
          out: (line: string) => lines.push(line),
          probeProviders: () => providerProbesOf(assembled),
          checkDeps: () => [{ id: 'node', ok: true, detail: 'test runtime' }],
          loadPolicy: () => ({ route: 'ask-user', autoApprove: [] }),
        },
      )
    ).exitCode;
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('0 fail');
  });

  it('throwing probe becomes a structured provider-down fail with exit 6', async () => {
    const lines: string[] = [];
    const deps = cleanDeps((line: string) => lines.push(line));
    deps.probeProviders = () => {
      throw new Error('probe exploded');
    };
    const code = (await runDoctorCommand({}, deps)).exitCode;
    expect(code).toBe(6);
    const text = lines.join('\n');
    expect(text).toContain('FAIL');
    expect(text).toContain('probe exploded');
  });

  it('reports the MIT license as a passing check', async () => {
    const lines: string[] = [];
    const code = (
      await runDoctorCommand(
        {},
        cleanDeps((line: string) => lines.push(line)),
      )
    ).exitCode;
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('PASS license:kubic (ok)');
  });
});

describe('runDoctorCommand mutation hardening', () => {
  it('reports a listed-but-not-dialled provider without models as 0 registered', async () => {
    const lines: string[] = [];
    const deps = cleanDeps((line: string) => lines.push(line));
    deps.probeProviders = () => [{ id: 'local', reachable: true }];
    const code = (await runDoctorCommand({}, deps)).exitCode;
    expect(code).toBe(0);
    // Honesty: the default probe never dialled, and the line says
    // so — a fabricated "reachable" would be a claim nothing measured.
    expect(lines.join('\n')).toContain(
      'PASS provider:local (ok): listed, not dialled, 0 model(s) registered',
    );
  });

  it('prefers the probe detail over the default reachable text', async () => {
    const lines: string[] = [];
    const deps = cleanDeps((line: string) => lines.push(line));
    deps.probeProviders = () => [
      { id: 'local', reachable: true, detail: 'custom ok' },
    ];
    await runDoctorCommand({}, deps);
    expect(lines.join('\n')).toContain('PASS provider:local (ok): custom ok');
  });

  it('prints the unreachable detail verbatim on a provider-down fail', async () => {
    const lines: string[] = [];
    const deps = cleanDeps((line: string) => lines.push(line));
    deps.probeProviders = () => [
      {
        id: 'local',
        reachable: false,
        detail: 'ECONNREFUSED 127.0.0.1:11434',
      },
    ];
    const code = (await runDoctorCommand({}, deps)).exitCode;
    expect(code).toBe(6);
    expect(lines.join('\n')).toContain(
      'FAIL provider:local (provider-down): ECONNREFUSED 127.0.0.1:11434',
    );
  });

  it('defaults dep details to present/missing when the probe omits them', async () => {
    const lines: string[] = [];
    const deps = cleanDeps((line: string) => lines.push(line));
    deps.checkDeps = () => [
      { id: 'node', ok: true },
      { id: 'git', ok: false },
    ];
    const code = (await runDoctorCommand({}, deps)).exitCode;
    expect(code).toBe(1);
    const text = lines.join('\n');
    expect(text).toContain('PASS dep:node (ok): present');
    expect(text).toContain('FAIL dep:git (deps-missing): missing');
  });

  it('maps a throwing dep probe to a structured deps-missing fail', async () => {
    const lines: string[] = [];
    const deps = cleanDeps((line: string) => lines.push(line));
    deps.checkDeps = () => {
      throw new Error('deps exploded');
    };
    const code = (await runDoctorCommand({}, deps)).exitCode;
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain(
      'FAIL dep:check (deps-missing): deps exploded',
    );
  });

  it('maps a throwing policy loader to a policy-mismatch fail', async () => {
    const lines: string[] = [];
    const deps = cleanDeps((line: string) => lines.push(line));
    deps.loadPolicy = () => {
      throw new Error('policy disk gone');
    };
    const code = (await runDoctorCommand({}, deps)).exitCode;
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain(
      'FAIL policy:approvals (policy-mismatch): policy disk gone',
    );
  });

  it('fails route=deny with entries that can never apply', async () => {
    const lines: string[] = [];
    const deps = cleanDeps((line: string) => lines.push(line));
    deps.loadPolicy = () => ({ route: 'deny', autoApprove: ['network'] });
    const code = (await runDoctorCommand({}, deps)).exitCode;
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('route=deny ignores autoApprove');
  });

  it('passes route=deny with no entries to ignore', async () => {
    const lines: string[] = [];
    const deps = cleanDeps((line: string) => lines.push(line));
    deps.loadPolicy = () => ({ route: 'deny', autoApprove: [] });
    const code = (await runDoctorCommand({}, deps)).exitCode;
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain(
      'PASS policy:approvals (ok): route=deny, 0 auto-approved',
    );
  });

  it('accepts requires: capabilities as dynamic triggers', async () => {
    const lines: string[] = [];
    const deps = cleanDeps((line: string) => lines.push(line));
    deps.loadPolicy = () => ({
      route: 'ask-user',
      autoApprove: ['requires:exec'],
    });
    const code = (await runDoctorCommand({}, deps)).exitCode;
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain(
      'PASS policy:approvals (ok): route=ask-user, 1 auto-approved',
    );
  });

  it('skips a comma list with whitespace around each id', async () => {
    const lines: string[] = [];
    const code = (
      await runDoctorCommand(
        { skip: ['dep:node, policy:approvals'] },
        cleanDeps((line: string) => lines.push(line)),
      )
    ).exitCode;
    expect(code).toBe(0);
    const text = lines.join('\n');
    expect(text).toContain('SKIP dep:node (skipped)');
    expect(text).toContain('SKIP policy:approvals (skipped)');
    // Dep:node was the only dep, so skipping it empties the
    // section and the limit:deps-present aggregate reports skip too.
    expect(text).toContain('SKIP limit:deps-present (skipped)');
    expect(text).toContain('3 skip');
  });

  it('stringifies a non-Error probe failure instead of crashing', async () => {
    const lines: string[] = [];
    const deps = cleanDeps((line: string) => lines.push(line));
    deps.probeProviders = () => {
      throw 'string boom';
    };
    const code = (await runDoctorCommand({}, deps)).exitCode;
    expect(code).toBe(6);
    expect(lines.join('\n')).toContain(
      'FAIL provider:probe (provider-down): string boom',
    );
  });
});

// Session transcripts and journaled file content are private
// state; a group- or world-accessible state directory is named, warned
// about (never exit-flipping), and tightened by the next open.
describe('state permissions', () => {
  it('warns on a world-readable sessions root, and passes when private', async () => {
    const loose: string[] = [];
    const looseCode = (
      await runDoctorCommand(
        {},
        {
          ...cleanDeps((line: string) => loose.push(line)),
          probeStatePermissions: () => ({
            path: '/home/u/.kubic/sessions',
            mode: 0o755,
          }),
        },
      )
    ).exitCode;
    expect(looseCode).toBe(0);
    const text = loose.join('\n');
    expect(text).toContain('state:permissions');
    expect(text).toContain('WARN');
    expect(text).toMatch(/\/home\/u\/\.kubic\/sessions is 755 .*chmod 700/);

    const clean: string[] = [];
    const cleanCode = (
      await runDoctorCommand(
        { json: true },
        {
          ...cleanDeps((line: string) => clean.push(line)),
          probeStatePermissions: () => undefined,
        },
      )
    ).exitCode;
    expect(cleanCode).toBe(0);
    const report = JSON.parse(clean.join('\n')) as {
      checks: Array<{ id: string; status: string; detail: string }>;
    };
    const check = report.checks.find((c) => c.id === 'state:permissions');
    expect(check?.status).toBe('pass');
    expect(check?.detail).toMatch(/private \(0700\) or absent/);
  });
});

describe('doctor probes run once and --skip clears aggregates', () => {
  function refusedConfigDeps(out: (line: string) => void): DoctorDeps {
    return {
      out,
      probeProviders: () => [
        { id: 'local', reachable: true, models: ['llama3'] },
      ],
      // A refused config: the per-item check is dep:config-load (fail).
      checkDeps: () => [{ id: 'config-load', ok: false, detail: 'refused' }],
      loadPolicy: () => ({ route: 'ask-user', autoApprove: [] }),
    };
  }

  type CheckRow = { id: string; status: string; reason: string };

  async function report(
    deps: DoctorDeps,
    skip: string[],
  ): Promise<{ code: number; checks: CheckRow[] }> {
    const lines: string[] = [];
    const code = (
      await runDoctorCommand(
        { json: true, skip },
        { ...deps, out: (line: string) => lines.push(line) },
      )
    ).exitCode;
    const parsed = JSON.parse(lines.join('\n')) as { checks: CheckRow[] };
    return { code, checks: parsed.checks };
  }

  it('calls each injected probe exactly once per doctor run', async () => {
    const lines: string[] = [];
    const base = refusedConfigDeps((line) => lines.push(line));
    const probeProviders = vi.fn(base.probeProviders);
    const checkDeps = vi.fn(base.checkDeps);
    const loadPolicy = vi.fn(base.loadPolicy);
    await runDoctorCommand(
      { json: true },
      { ...base, probeProviders, checkDeps, loadPolicy },
    );
    // One call feeds the per-item checks AND the limit aggregates — a
    // second call would double-bill expensive probes and let a flaky probe
    // answer differently twice.
    expect(probeProviders).toHaveBeenCalledTimes(1);
    expect(checkDeps).toHaveBeenCalledTimes(1);
    expect(loadPolicy).toHaveBeenCalledTimes(1);
  });

  it('--skip dep:config-load exits 0 and clears limit:deps-present', async () => {
    const { code, checks } = await report(
      refusedConfigDeps(() => undefined),
      ['dep:config-load'],
    );
    expect(code).toBe(0);
    expect(checks.find((check) => check.id === 'dep:config-load')?.status).toBe(
      'skip',
    );
    // The aggregate derives from the post-skip items: the skipped refusal
    // no longer fails it.
    expect(
      checks.find((check) => check.id === 'limit:deps-present')?.status,
    ).not.toBe('fail');
  });

  it('the refused config still exits 1 without --skip (regression)', async () => {
    const { code, checks } = await report(
      refusedConfigDeps(() => undefined),
      [],
    );
    expect(code).toBe(1);
    expect(checks.find((check) => check.id === 'dep:config-load')?.status).toBe(
      'fail',
    );
    expect(
      checks.find((check) => check.id === 'limit:deps-present')?.status,
    ).toBe('fail');
  });

  it('a throwing dep probe still fails both the item and the aggregate', async () => {
    const lines: string[] = [];
    const base = refusedConfigDeps((line) => lines.push(line));
    const { code, checks } = await report(
      {
        ...base,
        checkDeps: () => {
          throw new Error('deps exploded');
        },
      },
      [],
    );
    expect(code).toBe(1);
    expect(checks.find((check) => check.id === 'dep:check')?.status).toBe(
      'fail',
    );
    const aggregate = checks.find((check) => check.id === 'limit:deps-present');
    expect(aggregate?.status).toBe('fail');
    expect(aggregate?.reason).toBe('deps-missing');
    // One throwing probe is not a crash: the other sections still ran.
    expect(
      checks.find((check) => check.id === 'limit:provider-availability')
        ?.status,
    ).toBe('pass');
  });
});

describe('full-access sessions', () => {
  interface CheckView {
    id: string;
    status: string;
    reason: string;
    detail: string;
  }

  async function matrix(
    deps: Partial<DoctorDeps>,
  ): Promise<{ code: number; checks: CheckView[] }> {
    const lines: string[] = [];
    const code = (
      await runDoctorCommand(
        { json: true },
        { ...cleanDeps((line: string) => lines.push(line)), ...deps },
      )
    ).exitCode;
    const report = JSON.parse(lines.join('\n')) as { checks: CheckView[] };
    return { code, checks: report.checks };
  }

  it('warns once per live full-access session, naming the grant and the way off', async () => {
    const { code, checks } = await matrix({
      probeFullAccessSessions: () => [
        { sessionId: 'abc', enabledAt: 1700000000000, enabledBy: 'tester' },
      ],
    });
    // A warning never flips the exit: full access is operator intent,
    // doctor informs.
    expect(code).toBe(0);
    const check = checks.find(
      (entry) => entry.id === 'session:full-access:abc',
    );
    expect(check?.status).toBe('warn');
    expect(check?.reason).toBe('full-access');
    expect(check?.detail).toContain('session abc');
    expect(check?.detail).toContain('1700000000000');
    expect(check?.detail).toContain('tester');
    expect(check?.detail).toContain('switch approvals back on');
  });

  it('stays quiet when no session left enforcement', async () => {
    const { checks } = await matrix({ probeFullAccessSessions: () => [] });
    expect(
      checks.filter((entry) => entry.id.startsWith('session:full-access:')),
    ).toEqual([]);
  });

  it('adds no checks without the probe (legacy matrices unchanged)', async () => {
    const { checks } = await matrix({});
    expect(
      checks.filter((entry) => entry.id.startsWith('session:full-access:')),
    ).toEqual([]);
  });

  it('a throwing probe warns once instead of crashing the matrix', async () => {
    const { code, checks } = await matrix({
      probeFullAccessSessions: () => {
        throw new Error('store exploded');
      },
    });
    expect(code).toBe(0);
    const check = checks.find((entry) => entry.id === 'session:full-access');
    expect(check?.status).toBe('warn');
    expect(check?.detail).toContain('store exploded');
  });

  it('installedPolicy over a full-access session dir reports FULL ACCESS (doctor --session)', async () => {
    const root = mkTmp('kubic-doctor-session-');
    const dir = join(root, 'abc');
    mkdirSync(dir, { recursive: true });
    new FileApprovalStore(dir).savePosture({
      fullAccess: true,
      enabledAt: 1700000000000,
      enabledBy: 'tester',
    });
    const { checks } = await matrix({
      installedPolicy: () =>
        installedPolicyPosture({ workspace: root, sessionDir: dir }),
    });
    const installed = checks.find((entry) => entry.id === 'policy:installed');
    expect(installed?.detail).toContain('FULL ACCESS recorded');
  });
});

describe('audit sink checks', () => {
  function reportOf(lines: string[]): Array<{
    id: string;
    status: string;
    reason: string;
    detail: string;
  }> {
    return (
      JSON.parse(lines.join('\n')) as {
        checks: Array<{
          id: string;
          status: string;
          reason: string;
          detail: string;
        }>;
      }
    ).checks;
  }

  it('lists the injected sink checks, absent without the probe', async () => {
    const withProbe: string[] = [];
    await runDoctorCommand(
      { json: true },
      {
        ...cleanDeps((line: string) => withProbe.push(line)),
        probeAuditSinks: () => [
          {
            id: 'audit:sink:syslog-1',
            label: 'audit sink syslog',
            status: 'pass',
            reason: 'ok',
            detail: 'audit[1] syslog unix:/dev/log (privileged)',
          },
        ],
      },
    );
    expect(
      reportOf(withProbe).find((entry) => entry.id === 'audit:sink:syslog-1')
        ?.status,
    ).toBe('pass');
    const withoutProbe: string[] = [];
    await runDoctorCommand(
      { json: true },
      { ...cleanDeps((line: string) => withoutProbe.push(line)) },
    );
    expect(
      reportOf(withoutProbe).some((entry) => entry.id.startsWith('audit:')),
    ).toBe(false);
  });

  it('a throwing sink probe becomes one named failing check', async () => {
    const lines: string[] = [];
    await runDoctorCommand(
      { json: true },
      {
        ...cleanDeps((line: string) => lines.push(line)),
        probeAuditSinks: () => {
          throw new Error('sink probe blew up');
        },
      },
    );
    const check = reportOf(lines).find((entry) => entry.id === 'audit:sinks');
    expect(check?.status).toBe('fail');
    expect(check?.reason).toBe('sink-unreachable');
    expect(check?.detail).toContain('sink probe blew up');
  });
});

// The grouped summary on an interactive terminal, the full
// report behind --verbose, and the full report everywhere else.
describe('doctor rendering modes', () => {
  it('prints the grouped summary when the output is fancy', async () => {
    const lines: string[] = [];
    const code = (
      await runDoctorCommand(
        {},
        { ...cleanDeps((line: string) => lines.push(line)), fancy: true },
      )
    ).exitCode;
    expect(code).toBe(0);
    expect(lines[0]).toMatch(/^■ kubic doctor · \d+ checks/);
    expect(lines.some((line) => line.startsWith('PASS '))).toBe(false);
    expect(lines.at(-1)).toContain('kubic doctor --verbose');
  });

  it('prints every check in full with --verbose', async () => {
    const lines: string[] = [];
    await runDoctorCommand(
      { verbose: true },
      { ...cleanDeps((line: string) => lines.push(line)), fancy: true },
    );
    expect(lines.some((line) => line.startsWith('PASS '))).toBe(true);
    expect(lines[0]).not.toMatch(/^■/);
  });

  it('keeps the full report off a terminal', async () => {
    const lines: string[] = [];
    await runDoctorCommand(
      {},
      cleanDeps((line: string) => lines.push(line)),
    );
    expect(lines.some((line) => line.startsWith('PASS '))).toBe(true);
    expect(lines.some((line) => line.startsWith('■'))).toBe(false);
  });
});
