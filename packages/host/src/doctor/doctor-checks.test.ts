// kubic doctor: providers, deps, policy
// mismatches, skip flag — with --json parity. Faux-only: probes are
// injected, never network.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { tempDir } from '../../../../test/temp-dir.js';
import {
  FileApprovalStore,
  installedPolicyPosture,
} from '../approvals/index.js';
import { runDoctorCommand } from './command.js';
import type { DoctorDeps, StatePermissionProbe } from './types.js';

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

// Session transcripts and journaled file content are private
// state; a group- or world-accessible state directory is named, warned
// about (never exit-flipping), and tightened by the next open.
describe('state permissions', () => {
  const run = async (probe: StatePermissionProbe | undefined) => {
    const lines: string[] = [];
    const code = (
      await runDoctorCommand(
        { json: true },
        {
          ...cleanDeps((line: string) => lines.push(line)),
          probeStatePermissions: () => probe,
        },
      )
    ).exitCode;
    const report = JSON.parse(lines.join('\n')) as {
      checks: Array<{ id: string; status: string; detail: string }>;
    };
    return {
      code,
      check: report.checks.find((c) => c.id === 'state:permissions'),
    };
  };

  it('names every loose entry it shows with the mode it should have', async () => {
    const { code, check } = await run({
      loose: [
        {
          path: '/home/u/.kubic/sessions/s1/journal',
          mode: 0o755,
          expected: 0o700,
        },
        {
          path: '/home/u/.kubic/sessions/s1/main.jsonl',
          mode: 0o644,
          expected: 0o600,
        },
      ],
      count: 5,
      checked: 40,
      truncated: false,
    });
    // A warn: informational, never exit-flipping.
    expect(code).toBe(0);
    expect(check?.status).toBe('warn');
    expect(check?.detail).toContain(
      '/home/u/.kubic/sessions/s1/journal is 755, expected 700',
    );
    expect(check?.detail).toContain(
      '/home/u/.kubic/sessions/s1/main.jsonl is 644, expected 600',
    );
    expect(check?.detail).toContain('(+3 more)');
    expect(check?.detail).toMatch(/chmod 700 a directory and 600 a file/);
  });

  it('passes a private state, and says when the walk stopped early', async () => {
    expect((await run(undefined)).check).toMatchObject({
      status: 'pass',
      detail: expect.stringMatching(
        /private \(0700 directories, 0600 files\) or absent$/,
      ),
    });
    expect(
      (await run({ loose: [], count: 0, checked: 4096, truncated: true })).check
        ?.detail,
    ).toMatch(/\(checked the first 4096 entries\)$/);
  });
});

// A non-empty journal.outOfScope removes the undo guarantee for those
// paths, so doctor names them where the other honest limits are.
describe('journal coverage', () => {
  it('warns with the excluded paths, and adds no check when nothing is excluded', async () => {
    const run = async (paths: string[]) => {
      const lines: string[] = [];
      const code = (
        await runDoctorCommand(
          { json: true },
          {
            ...cleanDeps((line: string) => lines.push(line)),
            probeJournalCoverage: () => ({
              outOfScope: paths,
              source: 'project',
            }),
          },
        )
      ).exitCode;
      const report = JSON.parse(lines.join('\n')) as {
        checks: Array<{ id: string; status: string; detail: string }>;
      };
      return {
        code,
        check: report.checks.find((c) => c.id === 'journal:out-of-scope'),
      };
    };
    const { code, check } = await run(['dist', 'src']);
    expect(code).toBe(0);
    expect(check?.status).toBe('warn');
    expect(check?.detail).toBe(
      'journal.outOfScope (project) leaves 2 path(s) out of the journal: dist, src — changes there are not journaled, and kubic undo cannot restore them',
    );
    expect((await run([])).check).toBeUndefined();
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
    // does not fail it.
    expect(
      checks.find((check) => check.id === 'limit:deps-present')?.status,
    ).not.toBe('fail');
  });

  it('the refused config still exits 1 without --skip', async () => {
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

  it('adds no checks without the probe (matrix unchanged)', async () => {
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
    const root = tempDir('kubic-doctor-session-');
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
