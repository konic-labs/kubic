// Honest-limits doctor checks (issue #58; §59.1, §78, §50).
// RED first: static §59.1 notices plus dynamic provider/dep/policy
// builders with honest messages; provider-down maps to exit 6; --json
// matches the #29 envelope shape. Faux-only: injected values, no I/O.
import { describe, expect, it } from 'vitest';
import type { DoctorCheck } from '../doctor.js';
import { runDoctorCommand } from '../doctor.js';
import { RUN_EXIT_PROVIDER_PROBE_FAILED } from '../run-cli.js';
import {
  buildLimitsJsonReport,
  collectLimitChecks,
  collectLimitChecksFromDeps,
  depsLimitCheck,
  LIMITS_DOCTOR_EXIT_FAIL,
  LIMITS_DOCTOR_EXIT_OK,
  LIMITS_DOCTOR_EXIT_PROVIDER,
  limitsDoctorExit,
  policyEnforceabilityCheck,
  providerAvailabilityCheck,
  staticLimitChecks,
} from './doctor-limits.js';

describe('static §59.1 limit notices (issue #58)', () => {
  it('covers every applicable limit with honest warn notices', () => {
    const checks = staticLimitChecks();
    const ids = checks.map((check) => check.id);
    expect(ids).toEqual([
      'limit:solo-no-isolation',
      'limit:worktrees-writers-only',
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
    expect(text).toMatch(/writers only/);
    expect(text).toMatch(/no .*injection.*prevention/i);
    expect(text).toMatch(/not enforcement/);
    expect(text).toMatch(/not a backup/);
    expect(text).toMatch(/no third-party.*MCP|no .*MCP/i);
  });
});

describe('doctor matrix (issue #58)', () => {
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

  it('unenforceable MCP request fails policy-mismatch as v1-unsupported', () => {
    const check = policyEnforceabilityCheck({
      route: 'ask-user',
      autoApprove: ['mcp:filesystem'],
    });
    expect(check.status).toBe('fail');
    expect(check.reason).toBe('policy-mismatch');
    expect(check.detail).toContain('mcp:filesystem');
    expect(check.detail).toMatch(/unsupported in v1/);
  });

  it('extension request fails the same honest way', () => {
    const check = policyEnforceabilityCheck({
      route: 'ask-user',
      autoApprove: ['extension:search'],
    });
    expect(check.status).toBe('fail');
    expect(check.reason).toBe('policy-mismatch');
  });

  it('config-level mcp key fails the same honest way', () => {
    const check = policyEnforceabilityCheck({
      route: 'ask-user',
      autoApprove: [],
      mcp: { servers: [] },
    });
    expect(check.status).toBe('fail');
    expect(check.detail).toMatch(/unsupported in v1/);
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

describe('§78 exit mapping (issue #58)', () => {
  function fail(reason: DoctorCheck['reason']): DoctorCheck {
    return {
      id: 'x',
      label: 'x',
      status: 'fail',
      reason,
      detail: 'x',
    };
  }

  it('provider failure exits 6, matching kubic run §78', () => {
    expect(LIMITS_DOCTOR_EXIT_PROVIDER).toBe(6);
    expect(LIMITS_DOCTOR_EXIT_PROVIDER).toBe(RUN_EXIT_PROVIDER_PROBE_FAILED);
    expect(limitsDoctorExit([fail('provider-down')])).toBe(6);
  });

  it('other failures exit 1 and clean exits 0', () => {
    expect(limitsDoctorExit([fail('policy-mismatch')])).toBe(
      LIMITS_DOCTOR_EXIT_FAIL,
    );
    expect(limitsDoctorExit([])).toBe(LIMITS_DOCTOR_EXIT_OK);
  });

  it('warn notices alone never flip the exit code', () => {
    expect(limitsDoctorExit(staticLimitChecks())).toBe(LIMITS_DOCTOR_EXIT_OK);
  });

  it('a clean run with warn notices exits 0 end-to-end', async () => {
    const lines: string[] = [];
    const code = await runDoctorCommand([], {
      out: (line: string) => lines.push(line),
      probeProviders: () => [{ id: 'local', reachable: true }],
      checkDeps: () => [{ id: 'node', ok: true }],
      loadPolicy: () => ({ route: 'ask-user', autoApprove: [] }),
    });
    expect(code).toBe(0);
    const text = lines.join('\n');
    expect(text).toContain('WARN limit:solo-no-isolation');
    expect(text).toContain('0 fail');
  });

  it('provider-down exits 6 end-to-end via runDoctorCommand (§78)', async () => {
    const lines: string[] = [];
    const code = await runDoctorCommand([], {
      out: (line: string) => lines.push(line),
      probeProviders: () => [{ id: 'local', reachable: false }],
      checkDeps: () => [{ id: 'node', ok: true }],
      loadPolicy: () => ({ route: 'ask-user', autoApprove: [] }),
    });
    expect(code).toBe(6);
    expect(code).toBe(RUN_EXIT_PROVIDER_PROBE_FAILED);
    expect(lines.join('\n')).toContain('provider-down');
  });
});

describe('limits --json shape §50/78 (issue #58)', () => {
  it('builds the {ok, exitCode, checks} envelope the doctor --json uses', async () => {
    const checks: DoctorCheck[] = [
      ...staticLimitChecks(),
      providerAvailabilityCheck([{ id: 'local', reachable: true }]),
    ];
    const report = buildLimitsJsonReport(checks);
    expect(report.ok).toBe(true);
    expect(report.exitCode).toBe(0);
    expect(report.checks).toBe(checks);
    expect(Object.keys(report).sort()).toEqual(['checks', 'exitCode', 'ok']);
  });

  it('matches the #29 doctor --json key shape check-for-check', async () => {
    const jsonLines: string[] = [];
    await runDoctorCommand(['--json'], {
      out: (line: string) => jsonLines.push(line),
      probeProviders: () => [{ id: 'local', reachable: true }],
      checkDeps: () => [{ id: 'node', ok: true }],
      loadPolicy: () => ({ route: 'ask-user', autoApprove: [] }),
    });
    const doctorReport = JSON.parse(jsonLines.join('\n')) as {
      ok: boolean;
      exitCode: number;
      checks: DoctorCheck[];
    };
    const limitsReport = buildLimitsJsonReport(doctorReport.checks);
    expect(Object.keys(limitsReport).sort()).toEqual(
      Object.keys(doctorReport).sort(),
    );
    expect(limitsReport.ok).toBe(doctorReport.ok);
  });
});

describe('collectLimitChecks (issue #58)', () => {
  it('aggregates static, provider, dep, and policy checks', () => {
    const checks = collectLimitChecks({
      providers: [{ id: 'local', reachable: true }],
      deps: [{ id: 'node', ok: true }],
      policy: { route: 'ask-user', autoApprove: [] },
    });
    const ids = checks.map((check) => check.id);
    expect(ids).toContain('limit:solo-no-isolation');
    expect(ids).toContain('limit:provider-availability');
    expect(ids).toContain('limit:deps-present');
    expect(ids).toContain('policy:enforceability');
  });

  it('never throws on throwing probes — it reports them', () => {
    const checks = collectLimitChecksFromDeps({
      probeProviders: () => {
        throw new Error('probe exploded');
      },
      checkDeps: () => [{ id: 'node', ok: true }],
      loadPolicy: () => ({ route: 'ask-user', autoApprove: [] }),
    });
    const provider = checks.find(
      (check) => check.id === 'limit:provider-availability',
    );
    expect(provider?.status).toBe('fail');
    expect(provider?.reason).toBe('provider-down');
    expect(provider?.detail).toBe('probe exploded');
    // The other sections still ran: one throwing probe is not a crash.
    expect(
      checks.find((check) => check.id === 'limit:deps-present')?.status,
    ).toBe('pass');
    expect(
      checks.find((check) => check.id === 'policy:enforceability')?.status,
    ).toBe('pass');
  });
});
