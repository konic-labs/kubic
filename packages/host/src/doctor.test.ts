// kubic doctor (issue #29; §41.4, §50): providers, deps, policy
// mismatches, skip flag — with --json parity. Faux-only: probes are
// injected, never network.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DoctorDeps } from './doctor.js';
import { runDoctorCommand } from './doctor.js';
import { assembleModels } from './models-cli.js';

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

describe('runDoctorCommand', () => {
  it('clean run passes with exit 0', async () => {
    const lines: string[] = [];
    const code = await runDoctorCommand(
      [],
      cleanDeps((line: string) => lines.push(line)),
    );
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('0 fail');
  });

  it('--json output parses and matches the text run check-for-check', async () => {
    const textLines: string[] = [];
    await runDoctorCommand(
      [],
      cleanDeps((line: string) => textLines.push(line)),
    );
    const jsonLines: string[] = [];
    const code = await runDoctorCommand(
      ['--json'],
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
      [],
      deps((line: string) => textLines.push(line)),
    );
    expect(textCode).toBe(6);
    expect(textLines.join('\n')).toContain('provider-down');
    const jsonLines: string[] = [];
    const jsonCode = await runDoctorCommand(
      ['--json'],
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
    const code = await runDoctorCommand([], deps);
    expect(code).toBe(1);
    const text = lines.join('\n');
    expect(text).toContain('policy-mismatch');
    expect(text).toContain('bogus-cap');
  });

  it('--skip reports skipped checks and still passes clean', async () => {
    const lines: string[] = [];
    const code = await runDoctorCommand(
      ['--skip', 'policy:approvals'],
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
      ['--skip', 'nope:missing'],
      cleanDeps((line: string) => lines.push(line)),
    );
    expect(code).toBe(2);
    expect(lines.join('\n')).toContain('unknown check');
  });

  it('main.ts-style wiring (assembled providers + node dep) passes clean', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'doctor-'));
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
    const assembled = assembleModels(dir);
    const lines: string[] = [];
    const code = await runDoctorCommand([], {
      out: (line: string) => lines.push(line),
      probeProviders: () =>
        assembled.models.getProviders().map((provider) => ({
          id: provider.id,
          reachable: true,
          models: assembled.models
            .getModels(provider.id)
            .map((model) => model.id),
        })),
      checkDeps: () => [{ id: 'node', ok: true, detail: 'test runtime' }],
      loadPolicy: () => ({ route: 'ask-user', autoApprove: [] }),
    });
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('0 fail');
  });

  it('throwing probe becomes a structured provider-down fail with exit 6', async () => {
    const lines: string[] = [];
    const deps = cleanDeps((line: string) => lines.push(line));
    deps.probeProviders = () => {
      throw new Error('probe exploded');
    };
    const code = await runDoctorCommand([], deps);
    expect(code).toBe(6);
    const text = lines.join('\n');
    expect(text).toContain('FAIL');
    expect(text).toContain('probe exploded');
  });

  it('reports the MIT license as a passing check (issue #59)', async () => {
    const lines: string[] = [];
    const code = await runDoctorCommand(
      [],
      cleanDeps((line: string) => lines.push(line)),
    );
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('PASS license:kubic (ok)');
  });
});
