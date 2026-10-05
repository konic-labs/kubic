// One §60 audit ledger per repo (issue #279; §60, design-drift item 21).
// Before this issue the solo writer used the raw cwd while `kubic audit` walked
// up to the nearest `.git`: a run from <repo>/sub wrote <repo>/sub/.kubic/…
// (untracked, and never read), every worker child wrote a mislabelled
// mode=solo record into its own worktree (lost at cleanup), and an unreadable
// ledger was reported as "no audit records".
//
// Fixture repos only (real git, hermetic global config); every temp dir and
// file mode is restored in afterEach. No network, no model.
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureRuntimeExcludeRules } from '../../exec/src/runtime-exclude.js';
import { installSoloPolicy } from './approvals.js';
import { runAuditCommand } from './policy/audit-cli.js';
import {
  AUDIT_LEDGER_FILE,
  auditLedgerDir,
  auditLedgerDirFor,
  readAuditLedger,
  resolveRepoRuntimeRoot,
} from './policy/audit-ledger.js';

const made: string[] = [];
const chmodded: string[] = [];

function tmpRoot(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `kubic-279-${prefix}`)));
  made.push(dir);
  return dir;
}

afterEach(() => {
  for (const path of chmodded.splice(0)) {
    try {
      chmodSync(path, 0o644);
    } catch {
      // Already gone.
    }
  }
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};

function git(cwd: string, args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args],
    { cwd, env: GIT_ENV, encoding: 'utf8' },
  );
}

function fixtureRepo(): { repo: string; sub: string } {
  const repo = tmpRoot('repo-');
  git(repo, ['init', '-q', '-b', 'main']);
  const sub = join(repo, 'sub');
  mkdirSync(sub);
  writeFileSync(join(sub, 'a.txt'), 'a\n');
  git(repo, ['add', 'sub/a.txt']);
  git(repo, ['commit', '-q', '-m', 'init']);
  // `kubic run` ships the runtime rules before booting (dispatch).
  ensureRuntimeExcludeRules({ cwd: repo });
  return { repo, sub };
}

const DESTRUCTIVE = {
  toolName: 'bash',
  args: { command: 'rm -rf build' },
  toolCallId: 'c1',
};

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    deps: {
      out: (line: string) => out.push(line),
      err: (line: string) => err.push(line),
    },
  };
}

describe('resolveRepoRuntimeRoot (issue #279)', () => {
  it('names the main checkout from a subdirectory, a linked worktree, and outside git', () => {
    const { repo, sub } = fixtureRepo();
    expect(resolveRepoRuntimeRoot(sub)).toBe(repo);
    const wt = join(repo, '.kubic', 'wt', 'worker-1');
    git(repo, ['worktree', 'add', '-q', '-b', 'kubic/worker-1', wt]);
    expect(resolveRepoRuntimeRoot(wt)).toBe(repo);
    const loose = tmpRoot('loose-');
    expect(resolveRepoRuntimeRoot(loose)).toBe(loose);
  });
});

describe('solo decisions land in the repo ledger (issue #279)', () => {
  it('a run from <repo>/sub appends to <repo>/.kubic/…/audit.jsonl and creates nothing under sub', async () => {
    const { repo, sub } = fixtureRepo();
    const installed = installSoloPolicy({
      workspace: sub,
      sessionDir: tmpRoot('session-'),
    });
    expect((await installed.ask(DESTRUCTIVE)).approved).toBe(false);
    const records = readAuditLedger(auditLedgerDir(repo));
    expect(records).toHaveLength(1);
    expect(records[0]?.mode).toBe('solo');
    expect(existsSync(join(sub, '.kubic'))).toBe(false);
    expect(git(repo, ['status', '--porcelain'])).toBe('');
  });

  it('kubic audit --mode solo lists it from the root and from sub', async () => {
    const { repo, sub } = fixtureRepo();
    const installed = installSoloPolicy({
      workspace: sub,
      sessionDir: tmpRoot('session-'),
    });
    await installed.ask(DESTRUCTIVE);
    for (const cwd of [repo, sub]) {
      const io = capture();
      const code = await runAuditCommand(
        { mode: 'solo', json: true },
        {
          ...io.deps,
          loadRecords: () => readAuditLedger(auditLedgerDirFor(cwd)),
        },
      );
      expect(code).toBe(0);
      expect(JSON.parse(io.out.join('\n'))).toHaveLength(1);
    }
  });
});

describe('orchestrated worker children (issue #279)', () => {
  function workerFixture() {
    const { repo } = fixtureRepo();
    const wt = join(repo, '.kubic', 'wt', 'worker-1');
    git(repo, ['worktree', 'add', '-q', '-b', 'kubic/worker-1', wt]);
    return { repo, wt };
  }

  const worker = { workerId: 'worker-1', orchestratorSession: 'orch-279' };

  it('a local decision appears once in the main ledger with mode orchestrator, nothing in the worktree', async () => {
    const { repo, wt } = workerFixture();
    const installed = installSoloPolicy({
      workspace: wt,
      sessionDir: tmpRoot('session-'),
      route: 'deny',
      orchestratedWorker: worker,
    });
    expect((await installed.ask(DESTRUCTIVE)).approved).toBe(false);
    const records = readAuditLedger(auditLedgerDir(repo));
    expect(records).toHaveLength(1);
    expect(records[0]?.mode).toBe('orchestrator');
    expect(records[0]?.who).toBe('agent:worker-1');
    expect(JSON.stringify(records[0])).toContain('orch-279');
    expect(existsSync(join(wt, '.kubic', 'orchestrator'))).toBe(false);
  });

  it('a decision answered through the manager seat is left to the manager record', async () => {
    const { repo, wt } = workerFixture();
    const installed = installSoloPolicy({
      workspace: wt,
      sessionDir: tmpRoot('session-'),
      orchestratedWorker: worker,
      answer: async () => ({ approved: true, by: 'user' }),
    });
    expect((await installed.ask(DESTRUCTIVE)).approved).toBe(true);
    // The manager's worker-asks ledger append is the one record.
    expect(readAuditLedger(auditLedgerDir(repo))).toEqual([]);
    expect(existsSync(join(wt, '.kubic', 'orchestrator'))).toBe(false);
  });
});

describe('solo provenance fields (issue #282)', () => {
  it('records the thinking level and the base revision the run captured at start', async () => {
    const { repo, sub } = fixtureRepo();
    const base = git(repo, ['rev-parse', 'HEAD']).trim();
    let thinking = 'high';
    const installed = installSoloPolicy({
      workspace: sub,
      sessionDir: tmpRoot('session-'),
      thinking: () => thinking,
      base,
    });
    await installed.ask(DESTRUCTIVE);
    // A mid-run thinking change is read at record time, like the model.
    thinking = 'low';
    await installed.ask({ ...DESTRUCTIVE, toolCallId: 'c2' });
    const records = readAuditLedger(auditLedgerDir(repo));
    expect(records).toHaveLength(2);
    expect(records[0]?.model.thinking).toBe('high');
    expect(records[1]?.model.thinking).toBe('low');
    for (const record of records) {
      expect(record?.workspace.base).toBe(base);
    }
  });

  it('accepts a static thinking level', async () => {
    const { repo } = fixtureRepo();
    const installed = installSoloPolicy({
      workspace: repo,
      sessionDir: tmpRoot('session-'),
      thinking: 'medium',
      base: 'none',
    });
    await installed.ask(DESTRUCTIVE);
    const [record] = readAuditLedger(auditLedgerDir(repo));
    expect(record?.model.thinking).toBe('medium');
    expect(record?.workspace.base).toBe('none');
  });
});

describe('an unreadable ledger is an error, not an empty trail (issue #279)', () => {
  const skip =
    process.platform === 'win32' ||
    (typeof process.getuid === 'function' && process.getuid() === 0);

  it.skipIf(skip)('kubic audit exits 1 naming the file', async () => {
    const root = tmpRoot('ledger-');
    const dir = auditLedgerDir(root);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, AUDIT_LEDGER_FILE);
    writeFileSync(file, '');
    chmodSync(file, 0o000);
    chmodded.push(file);
    expect(() => readAuditLedger(dir)).toThrow(/audit\.jsonl/);
    const io = capture();
    const code = await runAuditCommand(
      {},
      { ...io.deps, loadRecords: () => readAuditLedger(dir) },
    );
    expect(code).toBe(1);
    expect(io.err.join('\n')).toContain(file);
    expect(io.out).toEqual([]);
  });

  it('a missing ledger is still an empty trail', () => {
    expect(readAuditLedger(auditLedgerDir(tmpRoot('none-')))).toEqual([]);
  });
});
