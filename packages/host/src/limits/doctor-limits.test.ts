// Honest-limits doctor checks.
// Static notices plus dynamic provider/dep/policy
// builders with honest messages; provider-down maps to exit 6; --json
// matches the envelope shape. Faux-only: injected values, no I/O.
import { describe, expect, it } from 'vitest';
import {
  EXIT_FAILED,
  EXIT_OK,
  EXIT_PROVIDER,
} from '../../../core/src/cli/exit-codes.js';
import { MCP_ARRIVAL_REQUIREMENTS } from '../config/stances.js';
import type { DoctorCheck } from '../doctor.js';
import { runDoctorCommand } from '../doctor.js';
import { mapTerminusToExitCode } from '../run-cli.js';
import {
  depsLimitCheck,
  limitsDoctorExit,
  policyEnforceabilityCheck,
  providerAvailabilityCheck,
  staticLimitChecks,
} from './doctor-limits.js';

describe('static limit notices', () => {
  it('covers every applicable limit with honest warn notices', () => {
    const checks = staticLimitChecks();
    const ids = checks.map((check) => check.id);
    expect(ids).toEqual([
      'limit:no-isolation',
      'limit:no-injection-prevention',
      'limit:policy-offer',
      'limit:journal-not-backup',
      'limit:no-third-party-mcp',
    ]);
    for (const check of checks) {
      // Informational only: warn never flips the doctor exit code.
      expect(check.status).toBe('warn');
      expect(check.reason).toBe('ok');
    }
  });

  it('states each limit as not-enforced, never as protection', () => {
    const text = staticLimitChecks()
      .map((check) => check.detail)
      .join('\n');
    expect(text).toMatch(/no isolation/);
    expect(text).toMatch(/no .*injection.*prevention/i);
    expect(text).toMatch(/not enforcement/);
    expect(text).toMatch(/not a backup/);
    expect(text).toMatch(/no third-party.*MCP|no .*MCP/i);
  });
});

describe('doctor matrix', () => {
  it('missing provider fails provider-down naming exit 6', () => {
    const check = providerAvailabilityCheck([
      { id: 'local', reachable: false },
    ]);
    expect(check.id).toBe('limit:provider-availability');
    expect(check.status).toBe('fail');
    expect(check.reason).toBe('provider-down');
    expect(check.detail).toContain('local');
    expect(check.detail).toContain('6');
  });

  it('no providers at all fails provider-down', () => {
    const check = providerAvailabilityCheck([]);
    expect(check.status).toBe('fail');
    expect(check.reason).toBe('provider-down');
  });

  it('reachable providers pass naming them', () => {
    const check = providerAvailabilityCheck([{ id: 'local', reachable: true }]);
    expect(check.status).toBe('pass');
    expect(check.detail).toContain('local');
  });

  it('missing dep fails deps-missing naming it', () => {
    const check = depsLimitCheck([
      { id: 'node', ok: true, detail: 'v22.19.0' },
      { id: 'git', ok: false, detail: 'not found' },
    ]);
    expect(check.status).toBe('fail');
    expect(check.reason).toBe('deps-missing');
    expect(check.detail).toContain('git');
  });

  it('unenforceable MCP request fails policy-mismatch as unsupported', () => {
    const check = policyEnforceabilityCheck({
      route: 'ask-user',
      autoApprove: ['mcp:filesystem'],
    });
    expect(check.status).toBe('fail');
    expect(check.reason).toBe('policy-mismatch');
    expect(check.detail).toContain('mcp:filesystem');
    expect(check.detail).toMatch(
      /unsupported: no third-party tools or MCP servers/,
    );
  });

  it('extension request fails the same honest way', () => {
    const check = policyEnforceabilityCheck({
      route: 'ask-user',
      autoApprove: ['extension:search'],
    });
    expect(check.status).toBe('fail');
    expect(check.reason).toBe('policy-mismatch');
  });

  it('config-level mcp refusal names the arrival requirements', () => {
    const check = policyEnforceabilityCheck({
      route: 'ask-user',
      autoApprove: [],
      mcp: { servers: [] },
    });
    expect(check.status).toBe('fail');
    for (const req of MCP_ARRIVAL_REQUIREMENTS) {
      expect(check.detail).toContain(req);
    }
  });

  it('config-level mcp key fails the same honest way', () => {
    const check = policyEnforceabilityCheck({
      route: 'ask-user',
      autoApprove: [],
      mcp: { servers: [] },
    });
    expect(check.status).toBe('fail');
    expect(check.detail).toMatch(/config key \[mcp\] is unsupported/);
  });

  it('invalid policy shape defers to policy:approvals without double-failing', () => {
    const check = policyEnforceabilityCheck({
      route: 'allow-everything',
      autoApprove: [],
    });
    expect(check.status).toBe('pass');
    expect(check.detail).toContain('policy:approvals');
  });

  it('clean policy passes as offer-only routing, not enforcement', () => {
    const check = policyEnforceabilityCheck({
      route: 'ask-user',
      autoApprove: [],
    });
    expect(check.status).toBe('pass');
    expect(check.detail).toMatch(/offer/);
  });
});

describe('exit mapping', () => {
  function fail(reason: DoctorCheck['reason']): DoctorCheck {
    return {
      id: 'x',
      label: 'x',
      status: 'fail',
      reason,
      detail: 'x',
    };
  }

  it('provider failure exits 6, matching kubic run', () => {
    expect(EXIT_PROVIDER).toBe(6);
    expect(limitsDoctorExit([fail('provider-down')])).toBe(
      mapTerminusToExitCode('provider_probe_failed'),
    );
    expect(limitsDoctorExit([fail('provider-down')])).toBe(6);
  });

  it('other failures exit 1 and clean exits 0', () => {
    expect(limitsDoctorExit([fail('policy-mismatch')])).toBe(EXIT_FAILED);
    expect(limitsDoctorExit([])).toBe(EXIT_OK);
  });

  it('warn notices alone never flip the exit code', () => {
    expect(limitsDoctorExit(staticLimitChecks())).toBe(EXIT_OK);
  });

  it('a clean run with warn notices exits 0 end-to-end', async () => {
    const lines: string[] = [];
    const code = (
      await runDoctorCommand(
        {},
        {
          out: (line: string) => lines.push(line),
          probeProviders: () => [{ id: 'local', reachable: true }],
          checkDeps: () => [{ id: 'node', ok: true }],
          loadPolicy: () => ({ route: 'ask-user', autoApprove: [] }),
        },
      )
    ).exitCode;
    expect(code).toBe(0);
    const text = lines.join('\n');
    expect(text).toContain('WARN limit:no-isolation');
    expect(text).toContain('0 fail');
  });

  it('provider-down exits 6 end-to-end via runDoctorCommand', async () => {
    const lines: string[] = [];
    const code = (
      await runDoctorCommand(
        {},
        {
          out: (line: string) => lines.push(line),
          probeProviders: () => [{ id: 'local', reachable: false }],
          checkDeps: () => [{ id: 'node', ok: true }],
          loadPolicy: () => ({ route: 'ask-user', autoApprove: [] }),
        },
      )
    ).exitCode;
    expect(code).toBe(6);
    expect(code).toBe(EXIT_PROVIDER);
    expect(lines.join('\n')).toContain('provider-down');
  });
});

describe('limits --json shape', () => {
  it('the doctor --json envelope has the ok, exitCode and checks keys', async () => {
    const jsonLines: string[] = [];
    await runDoctorCommand(
      { json: true },
      {
        out: (line: string) => jsonLines.push(line),
        probeProviders: () => [{ id: 'local', reachable: true }],
        checkDeps: () => [{ id: 'node', ok: true }],
        loadPolicy: () => ({ route: 'ask-user', autoApprove: [] }),
      },
    );
    const doctorReport = JSON.parse(jsonLines.join('\n')) as {
      ok: boolean;
      exitCode: number;
      checks: DoctorCheck[];
    };
    expect(Object.keys(doctorReport).sort()).toEqual([
      'checks',
      'exitCode',
      'ok',
    ]);
    expect(typeof doctorReport.ok).toBe('boolean');
  });
});
