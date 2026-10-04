// kubic doctor (issue #29; §41.4, §50): providers, deps, policy
// mismatches, skip flag — with --json parity. Faux-only: probes are
// injected, never network.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { installedPolicyPosture } from './approvals.js';
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

describe('policy:detection-only and enterprise checks (issue #289)', () => {
  it('the default install names network=none as detection-only, exit stays 0', async () => {
    const lines: string[] = [];
    const code = await runDoctorCommand(
      { json: true },
      {
        ...cleanDeps((line: string) => lines.push(line)),
        installedPolicy: () =>
          installedPolicyPosture({ workspace: process.cwd() }),
      },
    );
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
    const code = await runDoctorCommand(
      { json: true },
      {
        ...cleanDeps((line: string) => lines.push(line)),
        installedPolicy: () =>
          installedPolicyPosture({ workspace: process.cwd() }),
        enterpriseChecks: () =>
          enterpriseDoctorChecks(policy, { syslogAvailable: true }),
      },
    );
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
    const code = await runDoctorCommand(
      { json: true },
      {
        ...cleanDeps((line: string) => lines.push(line)),
        enterpriseChecks: () => {
          throw new Error('policy disk gone');
        },
      },
    );
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
    const code = await runDoctorCommand(
      {},
      cleanDeps((line: string) => lines.push(line)),
    );
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
    const code = await runDoctorCommand(
      { json: true },
      cleanDeps((line: string) => jsonLines.push(line)),
    );
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
      // Issue #59 license identity rides the same command.
      'license:kubic',
      // Issue #58 honest-limits registration rides the same command.
      'limit:solo-no-isolation',
      'limit:worktrees-writers-only',
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

  it('provider-down fails distinct with exit 6 in text and --json (§78)', async () => {
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
    const textCode = await runDoctorCommand(
      {},
      deps((line: string) => textLines.push(line)),
    );
    expect(textCode).toBe(6);
    expect(textLines.join('\n')).toContain('provider-down');
    const jsonLines: string[] = [];
    const jsonCode = await runDoctorCommand(
      { json: true },
      deps((line: string) => jsonLines.push(line)),
    );
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
    const code = await runDoctorCommand({}, deps);
    expect(code).toBe(1);
    const text = lines.join('\n');
    expect(text).toContain('policy-mismatch');
    expect(text).toContain('bogus-cap');
  });

  it('--skip reports skipped checks and still passes clean', async () => {
    const lines: string[] = [];
    const code = await runDoctorCommand(
      { skip: ['policy:approvals'] },
      cleanDeps((line: string) => lines.push(line)),
    );
    expect(code).toBe(0);
    const text = lines.join('\n');
    expect(text).toContain('SKIP policy:approvals (skipped)');
    expect(text).toContain('1 skip');
  });

  it('unknown --skip id is a usage error', async () => {
    const lines: string[] = [];
    const code = await runDoctorCommand(
      { skip: ['nope:missing'] },
      cleanDeps((line: string) => lines.push(line)),
    );
    expect(code).toBe(2);
    expect(lines.join('\n')).toContain('unknown check');
  });

  it('main.ts-style wiring (assembled providers + node dep) passes clean', async () => {
    const dir = mkTmp('doctor-');
    // A provider must exist for a clean run: with zero providers the
    // honest-limits aggregate (issue #58) fails missing-provider.
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
    const code = await runDoctorCommand(
      {},
      {
        out: (line: string) => lines.push(line),
        probeProviders: () => providerProbesOf(assembled),
        checkDeps: () => [{ id: 'node', ok: true, detail: 'test runtime' }],
        loadPolicy: () => ({ route: 'ask-user', autoApprove: [] }),
      },
    );
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('0 fail');
  });

  it('throwing probe becomes a structured provider-down fail with exit 6', async () => {
    const lines: string[] = [];
    const deps = cleanDeps((line: string) => lines.push(line));
    deps.probeProviders = () => {
      throw new Error('probe exploded');
    };
    const code = await runDoctorCommand({}, deps);
    expect(code).toBe(6);
    const text = lines.join('\n');
    expect(text).toContain('FAIL');
    expect(text).toContain('probe exploded');
  });

  it('reports the MIT license as a passing check (issue #59)', async () => {
    const lines: string[] = [];
    const code = await runDoctorCommand(
      {},
      cleanDeps((line: string) => lines.push(line)),
    );
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('PASS license:kubic (ok)');
  });
});

describe('runDoctorCommand extension posture (issue #80)', () => {
  it('reports loaded/refused counts from the same trust checks', async () => {
    const lines: string[] = [];
    const deps = cleanDeps((line: string) => lines.push(line));
    deps.probeExtensions = () => ({
      ok: true,
      loaded: ['kubic/budget'],
      refusedCount: 2,
      detail:
        'loaded 1 (kubic/budget: budget: none configured), refused 2 (owned-path traversal, remote-flag use)',
    });
    const code = await runDoctorCommand({}, deps);
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain(
      'PASS extension:bundle (ok): loaded 1 (kubic/budget: budget: none configured), refused 2 (owned-path traversal, remote-flag use)',
    );
  });

  it('fails closed with exit 1 when the bundle dir is gone', async () => {
    const lines: string[] = [];
    const deps = cleanDeps((line: string) => lines.push(line));
    deps.probeExtensions = () => ({
      ok: false,
      loaded: [],
      refusedCount: 0,
      detail:
        'extension bundle dir missing: "skills/budget" not found (first-party bundle kubic/budget unavailable — refusing startup, not running bare)',
    });
    const code = await runDoctorCommand({}, deps);
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain(
      'FAIL extension:bundle (extension-posture): extension bundle dir missing',
    );
  });

  it('fails a hand-fed ok with zero refused tripwires (defense in depth)', async () => {
    const lines: string[] = [];
    const deps = cleanDeps((line: string) => lines.push(line));
    deps.probeExtensions = () => ({
      ok: true,
      loaded: ['kubic/budget'],
      refusedCount: 0,
      detail: 'loaded 1 (kubic/budget: budget: none configured), refused 0',
    });
    const code = await runDoctorCommand({}, deps);
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain(
      'FAIL extension:bundle (extension-posture)',
    );
  });

  it('fails a hand-fed ok with an empty loaded list', async () => {
    const lines: string[] = [];
    const deps = cleanDeps((line: string) => lines.push(line));
    deps.probeExtensions = () => ({
      ok: true,
      loaded: [],
      refusedCount: 2,
      detail: 'loaded 0, refused 2 (owned-path traversal, remote-flag use)',
    });
    const code = await runDoctorCommand({}, deps);
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain(
      'FAIL extension:bundle (extension-posture)',
    );
  });

  it('maps a throwing extension probe to a structured fail', async () => {
    const lines: string[] = [];
    const deps = cleanDeps((line: string) => lines.push(line));
    deps.probeExtensions = () => {
      throw new Error('bundle disk gone');
    };
    const code = await runDoctorCommand({}, deps);
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain(
      'FAIL extension:bundle (extension-posture): bundle disk gone',
    );
  });
});

describe('runDoctorCommand mutation hardening (issue #68)', () => {
  it('reports a listed-but-not-dialled provider without models as 0 registered', async () => {
    const lines: string[] = [];
    const deps = cleanDeps((line: string) => lines.push(line));
    deps.probeProviders = () => [{ id: 'local', reachable: true }];
    const code = await runDoctorCommand({}, deps);
    expect(code).toBe(0);
    // Issue #86 honesty: the default probe never dialled, and the line says
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
    const code = await runDoctorCommand({}, deps);
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
    const code = await runDoctorCommand({}, deps);
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
    const code = await runDoctorCommand({}, deps);
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
    const code = await runDoctorCommand({}, deps);
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain(
      'FAIL policy:approvals (policy-mismatch): policy disk gone',
    );
  });

  it('fails route=deny with entries that can never apply', async () => {
    const lines: string[] = [];
    const deps = cleanDeps((line: string) => lines.push(line));
    deps.loadPolicy = () => ({ route: 'deny', autoApprove: ['network'] });
    const code = await runDoctorCommand({}, deps);
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('route=deny ignores autoApprove');
  });

  it('passes route=deny with no entries to ignore', async () => {
    const lines: string[] = [];
    const deps = cleanDeps((line: string) => lines.push(line));
    deps.loadPolicy = () => ({ route: 'deny', autoApprove: [] });
    const code = await runDoctorCommand({}, deps);
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
    const code = await runDoctorCommand({}, deps);
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain(
      'PASS policy:approvals (ok): route=ask-user, 1 auto-approved',
    );
  });

  it('skips a comma list with whitespace around each id', async () => {
    const lines: string[] = [];
    const code = await runDoctorCommand(
      { skip: ['dep:node, policy:approvals'] },
      cleanDeps((line: string) => lines.push(line)),
    );
    expect(code).toBe(0);
    const text = lines.join('\n');
    expect(text).toContain('SKIP dep:node (skipped)');
    expect(text).toContain('SKIP policy:approvals (skipped)');
    expect(text).toContain('2 skip');
  });

  it('stringifies a non-Error probe failure instead of crashing', async () => {
    const lines: string[] = [];
    const deps = cleanDeps((line: string) => lines.push(line));
    deps.probeProviders = () => {
      throw 'string boom';
    };
    const code = await runDoctorCommand({}, deps);
    expect(code).toBe(6);
    expect(lines.join('\n')).toContain(
      'FAIL provider:probe (provider-down): string boom',
    );
  });
});
