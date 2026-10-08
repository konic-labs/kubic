// Audit ledger (one record format, one file): approval decisions are
// emitted through emitAudit as OrgAuditRecords and read back by the same
// reader `kubic audit` uses.
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { REDACTED_SECRET } from '../../../core/src/secret-shapes.js';
import {
  createGitSandbox,
  disposeAllGitSandboxes,
  type GitSandbox,
} from '../../../exec/src/test-support/git-sandbox.js';
import type { AuditInput } from './audit.js';
import { runAuditCommand } from './audit-cli.js';
import {
  AUDIT_LEDGER_FILE,
  appendToLedger,
  auditLedgerDir,
  auditLedgerDirFor,
  auditSinksDoctorChecks,
  buildConfiguredSinks,
  credentialUseAudit,
  fullAccessEnabledAudit,
  isPrivilegedAuditWhat,
  PRIVILEGED_ACTION_KINDS,
  readAuditLedger,
  resolveRunBaseRevision,
  runStartAudit,
  setAuditSinks,
  soloDecisionAudit,
  undoRestoreAudit,
} from './audit-ledger.js';

const roots: string[] = [];
let driver: GitSandbox | undefined;
afterEach(() => {
  driver = undefined;
  disposeAllGitSandboxes();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

// The test's git driver: plain, never injected — production
// reaches git only through the injected spawn seam below.
function git(cwd: string, args: string[]): string {
  driver ??= createGitSandbox();
  return driver.git(args, { cwd });
}

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'audit-ledger-'));
  roots.push(root);
  return root;
}

describe('audit ledger', () => {
  it('solo decisions share the ledger and the format', () => {
    const root = repo();
    const dir = auditLedgerDir(root);
    appendToLedger(
      dir,
      soloDecisionAudit({
        sessionId: 's',
        toolName: 'bash',
        trigger: 'destructive-shell',
        workspace: root,
        approved: false,
        reason: 'user denied',
        posture: 'approvals',
      }),
    );
    expect(readAuditLedger(dir)).toMatchObject([
      { who: 'agent:root', result: 'deny', reason: 'user denied' },
    ]);
  });

  it('redacts a secret-shaped field instead of dropping the decision', () => {
    const root = repo();
    const dir = auditLedgerDir(root);
    const errors: string[] = [];
    const record = appendToLedger(
      dir,
      soloDecisionAudit({
        sessionId: 's',
        toolName: 'bash',
        trigger: 'credentials',
        workspace: root,
        approved: false,
        reason: 'denied: command echoed sk-live-abcdef1234567890',
        posture: 'approvals',
      }),
      (message) => errors.push(message),
    );
    expect(errors).toEqual([]);
    expect(record?.result).toBe('deny');
    const [stored] = readAuditLedger(dir);
    expect(stored?.reason).toContain('[redacted-secret]');
    expect(JSON.stringify(stored)).not.toContain('sk-live-abcdef1234567890');
  });

  // The live-value refusal is a substring match, so a short or
  // dummy key (`gw`, `solo`, `1`, or `ollama` for provider `ollama`) matched
  // the record's own provider name and the credential-use row was silently
  // dropped. Below the minimum length nothing is matched and the row lands.
  it('never drops a credential-use row over a short or provider-named live key', () => {
    const root = repo();
    const dir = auditLedgerDir(root);
    const errors: string[] = [];
    for (const [provider, key] of [
      ['ollama', 'ollama'],
      ['gw', 'gw'],
      ['solo', 'solo'],
      ['root', '1'],
    ] as const) {
      const record = appendToLedger(
        dir,
        credentialUseAudit({
          sessionId: 's',
          role: 'root',
          provider,
          ref: '$KEY',
          purpose: `model-request:${provider}`,
          workspace: root,
        }),
        (message) => errors.push(message),
        [key],
      );
      expect(record?.what).toBe(`credential:${provider}`);
    }
    expect(errors).toEqual([]);
    expect(readAuditLedger(dir).map((r) => r.what)).toEqual([
      'credential:ollama',
      'credential:gw',
      'credential:solo',
      'credential:root',
    ]);
  });

  it('still refuses a record carrying a live value of the minimum length, and only then', () => {
    const root = repo();
    const dir = auditLedgerDir(root);
    const input = (reason: string) =>
      soloDecisionAudit({
        sessionId: 's',
        toolName: 'bash',
        trigger: 'credentials',
        workspace: root,
        approved: false,
        reason,
        posture: 'approvals',
      });
    const errors: string[] = [];
    // 8 characters: matched, so the record is refused (and reported).
    expect(
      appendToLedger(
        dir,
        input('denied: echoed abcd1234'),
        (message) => errors.push(message),
        ['abcd1234'],
      ),
    ).toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('secret material');
    expect(readAuditLedger(dir)).toEqual([]);
    // 7 characters: below the minimum, so the same shape is written.
    expect(
      appendToLedger(
        dir,
        input('denied: echoed abcd123'),
        (message) => errors.push(message),
        ['abcd123'],
      )?.reason,
    ).toBe('denied: echoed abcd123');
    expect(errors).toHaveLength(1);
  });

  // The ledger must answer which worker (pid, generation) on
  // which base ran X, and at which thinking level — no hard-coded 0/unknown
  // for a field the run knows.
  describe('audit provenance fields', () => {
    it('records thinking and base on solo rows', () => {
      const input = soloDecisionAudit({
        sessionId: 's',
        toolName: 'bash',
        trigger: 'destructive-shell',
        workspace: '/w',
        model: 'faux/faux',
        thinking: 'high',
        base: 'def456',
        approved: true,
        by: 'user',
        posture: 'approvals',
      });
      expect(input.model.thinking).toBe('high');
      expect(input.workspace.base).toBe('def456');
    });

    it("resolves the run's base revision once, and says 'none' when git cannot", async () => {
      const sha = await resolveRunBaseRevision('/repo', async () => ({
        exitCode: 0,
        stdout: '  abc123\n',
      }));
      expect(sha).toBe('abc123');
      await expect(
        resolveRunBaseRevision('/repo', async () => ({
          exitCode: 128,
          stdout: 'fatal: not a git repository',
        })),
      ).resolves.toBe('none');
      await expect(
        resolveRunBaseRevision('/repo', async () => {
          throw new Error('spawn git ENOENT');
        }),
      ).resolves.toBe('none');
    });

    it('probes git in the workspace dir, not the spawn cwd', async () => {
      // A scratch repo (the workspace) and a bare non-repo dir (the spawn
      // cwd): the probe must report the workspace's HEAD even though the
      // spawning shell sits elsewhere.
      const workspace = mkdtempSync(join(tmpdir(), 'kubic-base-ws-'));
      roots.push(workspace);
      const elsewhere = mkdtempSync(join(tmpdir(), 'kubic-base-cwd-'));
      roots.push(elsewhere);
      git(workspace, ['init', '-b', 'main']);
      git(workspace, ['config', 'user.email', 'base@kubic.dev']);
      git(workspace, ['config', 'user.name', 'kubic base']);
      git(workspace, ['config', 'commit.gpgsign', 'false']);
      writeFileSync(join(workspace, 'base.txt'), 'base\n');
      git(workspace, ['add', 'base.txt']);
      git(workspace, ['commit', '-m', 'base']);
      const expected = git(workspace, ['rev-parse', 'HEAD']).trim();
      // The runner spawns from `elsewhere` the way an env shell pinned to
      // another dir would — the `-C` in argv is what reaches the workspace.
      const seen: string[][] = [];
      const sha = await resolveRunBaseRevision(workspace, async (cmd, args) => {
        seen.push([cmd, ...args]);
        try {
          const stdout = execFileSync(cmd, args, {
            cwd: elsewhere,
            encoding: 'utf8',
          });
          return { exitCode: 0, stdout };
        } catch (error) {
          const failure = error as { status?: number; stdout?: unknown };
          return {
            exitCode: failure.status ?? 128,
            stdout: String(failure.stdout ?? ''),
          };
        }
      });
      expect(seen).toEqual([['git', '-C', workspace, 'rev-parse', 'HEAD']]);
      expect(sha).toBe(expected);
    });

    it("no live-path record carries 'unknown' for a field whose data exists", () => {
      const solo = soloDecisionAudit({
        sessionId: 's',
        toolName: 'bash',
        trigger: 'destructive-shell',
        workspace: '/w',
        model: 'faux/faux',
        thinking: 'medium',
        base: 'abc123',
        approved: true,
        by: 'user',
        posture: 'approvals',
      });
      expect(JSON.stringify(solo)).not.toContain('unknown');
    });
  });

  it('resolves the ledger at the repo root from any subdirectory', () => {
    const root = repo();
    mkdirSync(join(root, '.git'));
    mkdirSync(join(root, 'src', 'deep'), { recursive: true });
    expect(auditLedgerDirFor(join(root, 'src', 'deep'))).toBe(
      auditLedgerDir(root),
    );
  });

  it('falls back to the directory itself outside a repository', () => {
    const dir = repo();
    expect(auditLedgerDirFor(dir)).toBe(auditLedgerDir(dir));
  });

  it('skips torn and foreign lines instead of inventing records', () => {
    const dir = auditLedgerDir(repo());
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, AUDIT_LEDGER_FILE),
      '{"type":"legacy-event","detail":"legacy"}\n{torn\n',
    );
    expect(readAuditLedger(dir)).toEqual([]);
  });

  // The run's start names the mode, so the audit
  // trail carries the autonomous combination the session records.
  describe('run-start audit row', () => {
    it('records the mode, the command and the explicit flag in the reason', () => {
      const record = runStartAudit({
        sessionId: 'sess-1',
        command: 'kubic run',
        runMode: 'autonomous',
        workspace: '/repo',
        posture: 'approvals',
        autonomous: true,
      });
      expect(record.what).toBe('run:start');
      expect(record.who).toBe('user:cli');
      expect(record.agent).toEqual({ session: 'sess-1', role: 'root' });
      expect(record.posture).toBe('approvals');
      expect(record.result).toBe('ok');
      expect(record.reason).toContain('autonomous');
      expect(record.reason).toContain('kubic run');
      expect(record.reason).toContain('--autonomous');
    });
  });

  describe('privileged-action audit rows', () => {
    it('defines the closed privileged-action set', () => {
      expect(PRIVILEGED_ACTION_KINDS).toEqual([
        'full-access-grant',
        'undo-restore',
      ]);
    });

    it('records an undo restore with restored paths and skip count', () => {
      const record = undoRestoreAudit({
        sessionId: 'sess',
        workspace: '/repo',
        base: 'abc123',
        restored: ['a.txt', 'b.txt'],
        skipped: 1,
      });
      expect(record.who).toBe('user:cli');
      expect(record.what).toBe('undo-restore');
      expect(record.result).toBe('error');
      expect(record.reason).toContain('2 file(s)');
      expect(record.reason).toContain('a.txt');
      expect(record.reason).toContain('1 skipped');
      const clean = undoRestoreAudit({
        sessionId: 'sess',
        workspace: '/repo',
        base: 'abc123',
        restored: ['a.txt'],
        skipped: 0,
      });
      expect(clean.result).toBe('ok');
    });
  });

  it('kubic audit reads the ledger records back, filtered by posture', async () => {
    const root = repo();
    const dir = auditLedgerDir(root);
    const decision = {
      sessionId: 's',
      toolName: 'bash',
      trigger: 'destructive-shell',
      workspace: root,
      approved: true,
    };
    appendToLedger(
      dir,
      soloDecisionAudit({ ...decision, posture: 'approvals' }),
    );
    appendToLedger(
      dir,
      soloDecisionAudit({ ...decision, posture: 'full-access' }),
    );
    const lines: string[] = [];
    const code = (
      await runAuditCommand(
        { posture: 'full-access', json: true },
        {
          loadRecords: () => readAuditLedger(dir),
          loadSecrets: () => [],
          out: (line) => lines.push(line),
          err: (line) => lines.push(line),
        },
      )
    ).exitCode;
    expect(code).toBe(0);
    const parsed = JSON.parse(lines.join('\n')) as { posture: string }[];
    expect(parsed.map((record) => record.posture)).toEqual(['full-access']);
  });
});

// Configured sink fan-out: appendToLedger fans out to the
// configured [[audit]] sinks plus the mandatory repo ledger. Faux-only: a
// fake transport captures syslog lines, never a socket.
describe('configured sink fan-out', () => {
  afterEach(() => {
    setAuditSinks([]);
  });

  function fakeLines(): { lines: string[]; send(line: string): void } {
    const lines: string[] = [];
    return {
      lines,
      send: (line: string): void => {
        lines.push(line);
      },
    };
  }

  function privilegedInput(): AuditInput {
    return undoRestoreAudit({
      sessionId: 'sess-1',
      workspace: '/repo',
      restored: ['a.txt'],
    });
  }

  it('isPrivilegedAuditWhat keeps decisions, run starts and the privileged kinds, drops the rest', () => {
    for (const what of [
      'tool:bash',
      'run:start',
      'posture:full-access',
      // The revoke half of a privileged
      // posture change reaches privileged sinks too.
      'posture:approvals',
      'undo-restore',
    ]) {
      expect(isPrivilegedAuditWhat(what)).toBe(true);
    }
    for (const what of ['credential:openai', 'merge:kubic/w-1']) {
      expect(isPrivilegedAuditWhat(what)).toBe(false);
    }
  });

  it('fans a decision out to syslog plus the repo ledger, MSG redacted', () => {
    const dir = auditLedgerDir(repo());
    mkdirSync(dir, { recursive: true });
    const fake = fakeLines();
    const built = buildConfiguredSinks(
      [{ sink: 'syslog', level: 'privileged' }],
      { syslogTransport: fake },
    );
    expect(built.problems).toEqual([]);
    setAuditSinks(built.sinks);
    const errors: string[] = [];
    const input = {
      ...privilegedInput(),
      reason: 'key sk-faux-test-key-0001 echoed',
    };
    const record = appendToLedger(dir, input, (message) => {
      errors.push(message);
    });
    expect(record).toBeDefined();
    expect(errors).toEqual([]);
    // The repo ledger stays mandatory: one row.
    expect(readAuditLedger(dir)).toHaveLength(1);
    // The syslog sink got exactly one line whose MSG is the REDACTED record.
    expect(fake.lines).toHaveLength(1);
    const msg = fake.lines[0]?.slice(fake.lines[0]?.indexOf('{') ?? 0) ?? '';
    expect(msg).not.toContain('sk-faux-test-key-0001');
    expect(msg).toContain(REDACTED_SECRET);
  });

  it('level=privileged drops non-privileged records from the sink, never the ledger', () => {
    const dir = auditLedgerDir(repo());
    mkdirSync(dir, { recursive: true });
    const fake = fakeLines();
    setAuditSinks(
      buildConfiguredSinks([{ sink: 'syslog', level: 'privileged' }], {
        syslogTransport: fake,
      }).sinks,
    );
    const errors: string[] = [];
    appendToLedger(
      dir,
      credentialUseAudit({
        sessionId: 'sess-1',
        role: 'implementer',
        provider: 'faux',
        ref: 'faux-key-ref',
        purpose: 'test read',
        workspace: '/repo',
      }),
      (message) => {
        errors.push(message);
      },
    );
    // Dropped from syslog…
    expect(fake.lines).toHaveLength(0);
    // …but the repo ledger keeps everything.
    expect(readAuditLedger(dir)).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  it('level=all keeps non-privileged records', () => {
    const dir = auditLedgerDir(repo());
    mkdirSync(dir, { recursive: true });
    const fake = fakeLines();
    setAuditSinks(
      buildConfiguredSinks([{ sink: 'syslog', level: 'all' }], {
        syslogTransport: fake,
      }).sinks,
    );
    appendToLedger(
      dir,
      credentialUseAudit({
        sessionId: 'sess-1',
        role: 'implementer',
        provider: 'faux',
        ref: 'faux-key-ref',
        purpose: 'test read',
        workspace: '/repo',
      }),
    );
    expect(fake.lines).toHaveLength(1);
    expect(readAuditLedger(dir)).toHaveLength(1);
  });

  it('a throwing sink surfaces once on stderr and never blocks the repo write', () => {
    const dir = auditLedgerDir(repo());
    mkdirSync(dir, { recursive: true });
    setAuditSinks(
      buildConfiguredSinks([{ sink: 'syslog', level: 'all' }], {
        syslogTransport: {
          send: (): void => {
            throw new Error('syslog down');
          },
        },
      }).sinks,
    );
    const errors: string[] = [];
    const onError = (message: string): void => {
      errors.push(message);
    };
    // Same failing sink twice: one stderr note per process, two repo rows.
    expect(appendToLedger(dir, privilegedInput(), onError)).toBeDefined();
    expect(appendToLedger(dir, privilegedInput(), onError)).toBeDefined();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('syslog down');
    expect(readAuditLedger(dir)).toHaveLength(2);
  });

  it('buildConfiguredSinks reports bad targets as problems, never throws', () => {
    const built = buildConfiguredSinks([
      { sink: 'syslog', level: 'privileged', target: 'loghost:notaport' },
      { sink: 'syslog', level: 'privileged', facility: 'carrier-pigeon' },
      { sink: 'file', level: 'all' },
    ]);
    expect(built.sinks).toEqual([]);
    expect(built.problems).toHaveLength(3);
    expect(built.problems[0]).toMatch(/audit\[1\]/);
  });

  it('buildConfiguredSinks builds file sinks at the exact target path', () => {
    const root = repo();
    const target = join(root, 'extra.jsonl');
    const built = buildConfiguredSinks([
      { sink: 'file', level: 'all', target },
    ]);
    expect(built.problems).toEqual([]);
    setAuditSinks(built.sinks);
    const dir = auditLedgerDir(root);
    mkdirSync(dir, { recursive: true });
    appendToLedger(dir, privilegedInput());
    expect(readAuditLedger(dir)).toHaveLength(1);
    const lines = readFileSync(target, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({
      what: 'undo-restore',
    });
  });
});

// Audit-sink doctor checks: `kubic doctor` lists the
// configured [[audit]] sinks with a reachability probe per sink, plus one
// failing check per sink that recorded a runtime failure.
describe('audit sink doctor checks', () => {
  const probes = {
    socketExists: (path: string): boolean => path === '/dev/log',
    udpAvailable: (): boolean => true,
  };

  it('returns no checks without configured tables', () => {
    expect(
      auditSinksDoctorChecks({
        tables: [],
        problems: [],
        snapshot: [],
        probes,
      }),
    ).toEqual([]);
  });

  it('passes a reachable unix syslog sink, naming target and level', () => {
    const checks = auditSinksDoctorChecks({
      tables: [{ sink: 'syslog', level: 'privileged', target: '/dev/log' }],
      problems: [],
      snapshot: [],
      probes,
    });
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({
      id: 'audit:sink:syslog-1',
      status: 'pass',
      reason: 'ok',
    });
    expect(checks[0]?.detail).toContain('/dev/log');
    expect(checks[0]?.detail).toContain('privileged');
  });

  it('fails a missing unix socket with a named check', () => {
    const checks = auditSinksDoctorChecks({
      tables: [
        { sink: 'syslog', level: 'all', target: '/nonexistent/syslog.sock' },
      ],
      problems: [],
      snapshot: [],
      probes,
    });
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({
      id: 'audit:sink:syslog-1',
      status: 'fail',
      reason: 'sink-unreachable',
    });
    expect(checks[0]?.detail).toContain('/nonexistent/syslog.sock');
  });

  it('fails a table that never built, naming the problem', () => {
    const checks = auditSinksDoctorChecks({
      tables: [
        { sink: 'syslog', level: 'privileged', target: 'loghost:notaport' },
      ],
      problems: ['audit[1]: invalid syslog target "loghost:notaport"'],
      snapshot: [],
      probes,
    });
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ status: 'fail' });
    expect(checks[0]?.detail).toContain('invalid syslog target');
  });

  it('fails a sink that recorded a runtime failure this process', () => {
    const checks = auditSinksDoctorChecks({
      tables: [{ sink: 'syslog', level: 'all' }],
      problems: [],
      snapshot: [
        {
          source: 'audit[1]',
          kind: 'syslog',
          name: 'syslog:local0',
          level: 'all' as const,
          failures: ['syslog down'],
        },
      ],
      probes,
    });
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({
      status: 'fail',
      reason: 'sink-unreachable',
    });
    expect(checks[0]?.detail).toContain('syslog down');
  });

  it('probes UDP availability, failing closed when dgram is down', () => {
    const tables = [{ sink: 'syslog', level: 'privileged', target: 'loghost' }];
    const pass = auditSinksDoctorChecks({
      tables,
      problems: [],
      snapshot: [],
      probes,
    });
    expect(pass[0]).toMatchObject({ status: 'pass' });
    expect(pass[0]?.detail).toContain('loghost:514');
    const fail = auditSinksDoctorChecks({
      tables,
      problems: [],
      snapshot: [],
      probes: { ...probes, udpAvailable: () => false },
    });
    expect(fail[0]).toMatchObject({
      status: 'fail',
      reason: 'sink-unreachable',
    });
  });
});

// The closed privileged-action set: every kind in PRIVILEGED_ACTION_KINDS
// maps to a builder whose `what` carries the kind — a kind without
// coverage, or coverage without a kind, fails here.
describe('privileged-action kinds map to whats', () => {
  const sessionId = 'sess-kinds';

  it.each([
    ['full-access-grant', 'posture:full-access'],
    ['undo-restore', 'undo-restore'],
  ] as const)('kind %s writes what %s', (kind, what) => {
    expect(PRIVILEGED_ACTION_KINDS).toContain(kind);
    switch (kind) {
      case 'full-access-grant':
        expect(
          fullAccessEnabledAudit({
            sessionId,
            command: 'kubic run',
            workspace: '/repo',
          }).what,
        ).toBe(what);
        break;
      case 'undo-restore':
        expect(
          undoRestoreAudit({
            sessionId,
            workspace: '/repo',
            restored: ['a.txt'],
            skipped: 0,
          }).what,
        ).toBe(what);
        break;
    }
  });

  it('the set is closed: no more and no fewer than the two kinds', () => {
    expect([...PRIVILEGED_ACTION_KINDS].sort()).toEqual(
      ['full-access-grant', 'undo-restore'].sort(),
    );
  });
});
