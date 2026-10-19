// kubic doctor: providers, deps, policy
// mismatches, skip flag — with --json parity. Faux-only: probes are
// injected, never network.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../../test/temp-dir.js';
import { installedPolicyPosture } from '../approvals/index.js';
import { assembleModels, providerProbesOf } from '../models/index.js';
import {
  enterpriseDoctorChecks,
  resolveEffectivePolicy,
} from '../policy/index.js';
import { runDoctorCommand } from './command.js';
import type { ContextRoomProbe, DoctorDeps } from './types.js';

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
    // An unenforced network_policy is a fail, so the exit flips.
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
    expect(network?.detail).toContain('network_policy is not enforced');
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
      // Which platform the shell guards cover.
      'platform:shell',
      // License identity rides the same command.
      'license:kubic',
      // Honest-limits registration rides the same command.
      'limit:no-isolation',
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

  it('says which platform the shell guards cover, and that Windows is refused', async () => {
    const reportFor = async (platform: string) => {
      const lines: string[] = [];
      const code = (
        await runDoctorCommand(
          { json: true },
          { ...cleanDeps((line: string) => lines.push(line)), platform },
        )
      ).exitCode;
      const report = JSON.parse(lines.join('\n')) as {
        checks: Array<{ id: string; status: string; reason: string }>;
      };
      return {
        code,
        check: report.checks.find((check) => check.id === 'platform:shell'),
      };
    };
    expect(await reportFor('linux')).toMatchObject({
      code: 0,
      check: { status: 'pass', reason: 'ok' },
    });
    // A warn: the platform is reported, never a failed exit.
    expect(await reportFor('win32')).toMatchObject({
      code: 0,
      check: { status: 'warn', reason: 'unsupported-platform' },
    });
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

  it('warns, naming the contextWindow key, for a defaulted model window; exit stays 0', async () => {
    const lines: string[] = [];
    const deps: DoctorDeps = {
      ...cleanDeps((line: string) => lines.push(line)),
      probeModelWindows: () => [
        { provider: 'local', model: 'llama3', contextWindow: 8192 },
      ],
    };
    const code = (await runDoctorCommand({ json: true }, deps)).exitCode;
    expect(code).toBe(0);
    const report = JSON.parse(lines.join('\n')) as {
      ok: boolean;
      checks: Array<{
        id: string;
        status: string;
        reason: string;
        detail: string;
      }>;
    };
    expect(report.ok).toBe(true);
    const window = report.checks.find(
      (check) => check.id === 'models-window:local/llama3',
    );
    expect(window).toMatchObject({ status: 'warn', reason: 'window-default' });
    expect(window?.detail).toContain('contextWindow');
    expect(window?.detail).toContain('8192');
  });

  // The room check measures the models the user can configure: the models in
  // models.json and the default model the configuration pins. A built-in model
  // is never in its scope, so a probe with nothing configurable has no check.
  describe('context-room (the models the user can configure)', () => {
    const roomReport = async (probe: ContextRoomProbe | undefined) => {
      const lines: string[] = [];
      const deps: DoctorDeps = {
        ...cleanDeps((line: string) => lines.push(line)),
        ...(probe === undefined ? {} : { probeContextRoom: () => probe }),
      };
      const code = (await runDoctorCommand({ json: true }, deps)).exitCode;
      const report = JSON.parse(lines.join('\n')) as {
        ok: boolean;
        checks: Array<{
          id: string;
          status: string;
          reason: string;
          detail: string;
        }>;
      };
      const room = report.checks.find((check) => check.id === 'context-room');
      return { code, ok: report.ok, room };
    };

    it('warns for a custom model below the floor, with the contextWindow fix; exit stays 0', async () => {
      const { code, ok, room } = await roomReport({
        customModels: [
          { provider: 'local', model: 'tiny', contextWindow: 8192 },
        ],
      });
      expect(code).toBe(0);
      expect(ok).toBe(true);
      expect(room).toMatchObject({ status: 'warn', reason: 'room-short' });
      expect(room?.detail).toContain('local/tiny');
      expect(room?.detail).toContain('every turn or two');
      expect(room?.detail).toContain(
        'set "contextWindow" in models.json for local/tiny',
      );
      expect(room?.detail).not.toContain('default model');
    });

    it('warns for a small-window default model, with the choose-a-model fix', async () => {
      const { room } = await roomReport({
        customModels: [],
        defaultModel: {
          provider: 'openai',
          model: 'gpt-4',
          contextWindow: 8192,
        },
      });
      expect(room).toMatchObject({ status: 'warn', reason: 'room-short' });
      expect(room?.detail).toContain('openai/gpt-4');
      expect(room?.detail).toContain('choose one with a larger window');
      expect(room?.detail).toContain('kubic setup');
      expect(room?.detail).toContain('[policy] denied_tools');
      expect(room?.detail).not.toContain('models.json');
    });

    it('has no check when nothing the user can configure is in scope', async () => {
      expect((await roomReport(undefined)).room).toBeUndefined();
      expect((await roomReport({ customModels: [] })).room).toBeUndefined();
    });

    it('measures a default model that is also a custom model once, with the contextWindow fix', async () => {
      const tiny = { provider: 'local', model: 'tiny', contextWindow: 8192 };
      const { room } = await roomReport({
        customModels: [tiny],
        defaultModel: tiny,
      });
      expect(room?.detail).toContain('set "contextWindow" in models.json');
      expect(room?.detail).not.toContain('choose one with a larger window');
    });

    it('passes when every model in scope keeps the floor', async () => {
      const { room } = await roomReport({
        customModels: [
          { provider: 'local', model: 'roomy', contextWindow: 16384 },
        ],
      });
      expect(room?.status).toBe('pass');
    });

    it('treats the 4096 floor as a boundary: 4095 tokens of room warns, 4096 does not', async () => {
      // A window of 13718 leaves 4095 estimated tokens of room, and 13720 leaves
      // 4096 (reserve 3429 / 3430, kept window 2572, system entry 2822, summary 800).
      const below = await roomReport({
        customModels: [
          { provider: 'local', model: 'edge', contextWindow: 13718 },
        ],
      });
      expect(below.room).toMatchObject({ status: 'warn' });
      expect(below.room?.detail).toContain('about 4095 tokens of room');
      const floor = await roomReport({
        customModels: [
          { provider: 'local', model: 'edge', contextWindow: 13720 },
        ],
      });
      expect(floor.room?.status).toBe('pass');
    });
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
    const dir = tempDir('doctor-');
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

describe('runDoctorCommand exact output', () => {
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
