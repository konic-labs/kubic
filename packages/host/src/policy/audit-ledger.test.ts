// §60 audit ledger (one record format, one file): approval decisions are
// emitted through emitAudit as OrgAuditRecords and read back by the same
// reader `kubic audit` uses.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createWorkerAskRouter } from '../orchestrator/approvals/worker-asks.js';
import { runAuditCommand } from './audit-cli.js';
import {
  AUDIT_LEDGER_FILE,
  appendToLedger,
  auditLedgerDir,
  auditLedgerDirFor,
  credentialUseAudit,
  fullAccessEnabledAudit,
  mergeDecisionAudit,
  orchestratorDecisionAudit,
  PRIVILEGED_ACTION_KINDS,
  readAuditLedger,
  resolveRunBaseRevision,
  soloDecisionAudit,
  undoRestoreAudit,
  workerGenerationFromEnv,
  workerSpawnAudit,
  workerTerminateAudit,
  worktreeCreateAudit,
  worktreeRemoveAudit,
} from './audit-ledger.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'audit-ledger-'));
  roots.push(root);
  return root;
}

const askInput = {
  trigger: 'network',
  toolName: 'bash',
  args: { command: 'curl example.com' },
  justification: 'fetch the fixture',
  sessionId: 'sess-1',
  agentId: 'agent-1',
  role: 'implementer',
  worktree: '/repo/.kubic/wt/agent-1',
  provenance: { parentSessionId: 'root-1', model: 'faux/faux' },
};

describe('§60 audit ledger', () => {
  it('records an orchestrator approval decision as one OrgAuditRecord', async () => {
    const dir = auditLedgerDir(repo());
    mkdirSync(dir, { recursive: true });
    const router = createWorkerAskRouter({ dir, maxPendingMs: 1_000 });
    const outcome = await router.ask(askInput, { autoApprove: true });
    expect(outcome.approved).toBe(true);
    const records = readAuditLedger(dir);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      who: 'agent:agent-1',
      what: 'tool:bash',
      mode: 'orchestrator',
      posture: 'approvals',
      result: 'ok',
      agent: { session: 'sess-1', role: 'implementer', parent: 'root-1' },
      model: { provider: 'faux', id: 'faux' },
    });
  });

  it('records a manager approve attempt as a denied decision', () => {
    const dir = auditLedgerDir(repo());
    mkdirSync(dir, { recursive: true });
    const router = createWorkerAskRouter({ dir, maxPendingMs: 1_000 });
    router.managerApprove('no-such-key');
    const records = readAuditLedger(dir);
    expect(records).toHaveLength(1);
    expect(records[0]?.result).toBe('deny');
  });

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
      { mode: 'solo', result: 'deny', reason: 'user denied' },
    ]);
  });

  // Issue #323: a merge approved by the run's `--yes` standing answer is not
  // a user decision; the ledger row says which one it was.
  it('merge-gate rows tell a --yes approval apart from a user answer', () => {
    const root = repo();
    const dir = auditLedgerDir(root);
    const base = {
      sessionId: 'orch-1',
      agentId: 'worker-1',
      branch: 'kubic/worker-1',
      workspace: root,
      posture: 'approvals',
    };
    appendToLedger(
      dir,
      mergeDecisionAudit({ ...base, approved: true, by: '--yes' }),
    );
    appendToLedger(
      dir,
      mergeDecisionAudit({ ...base, approved: true, by: 'user' }),
    );
    appendToLedger(
      dir,
      mergeDecisionAudit({
        ...base,
        approved: false,
        by: 'user',
        reason: 'denied',
      }),
    );
    const records = readAuditLedger(dir);
    expect(records.map((record) => record.permission.approval)).toEqual([
      'approved by --yes',
      'approved by user',
      'denied',
    ]);
    expect(records[0]).toMatchObject({
      who: 'agent:worker-1',
      what: 'merge:kubic/worker-1',
      mode: 'orchestrator',
      result: 'ok',
      agent: { session: 'orch-1', role: 'manager' },
      permission: { permission: 'gate:merge' },
    });
    expect(records[2]).toMatchObject({ result: 'deny', reason: 'denied' });
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

  // Issue #359: the live-value refusal is a substring match, so a short or
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

  // Issue #279: the generation a worker child records is the one its
  // lifecycle layer stamped (KUBIC_WORKER_GENERATION); a solo row is 0.
  it("reads a worker child's generation from its env, exactly", () => {
    const base = {
      sessionId: 's',
      toolName: 'bash',
      trigger: 'destructive-shell',
      workspace: '/w',
      approved: false,
      reason: 'no',
      posture: 'approvals',
    };
    const worker = { id: 'w-1', orchestratorSession: 'orch' };
    const generationFor = (env: Record<string, string | undefined>) =>
      soloDecisionAudit({ ...base, worker }, env).worker.generation;
    expect(generationFor({ KUBIC_WORKER_GENERATION: '3' })).toBe(3);
    expect(generationFor({ KUBIC_WORKER_GENERATION: '0' })).toBe(0);
    expect(generationFor({ KUBIC_WORKER_GENERATION: '12' })).toBe(12);
    for (const bad of ['', 'x', '-2', '1.5', ' ']) {
      expect(generationFor({ KUBIC_WORKER_GENERATION: bad })).toBe(0);
    }
    expect(generationFor({})).toBe(0);
    // An explicit generation from the caller wins over the env.
    expect(
      soloDecisionAudit(
        { ...base, worker: { ...worker, generation: 5 } },
        { KUBIC_WORKER_GENERATION: '3' },
      ).worker.generation,
    ).toBe(5);
    // A solo row never inherits a stray env value.
    expect(
      soloDecisionAudit(base, { KUBIC_WORKER_GENERATION: '3' }).worker
        .generation,
    ).toBe(0);
    expect(workerGenerationFromEnv({ KUBIC_WORKER_GENERATION: '7' })).toBe(7);
  });

  // Issue #282: the ledger must answer which worker (pid, generation) on
  // which base ran X, and at which thinking level — no hard-coded 0/unknown
  // for a field the run knows.
  describe('audit provenance fields (issue #282)', () => {
    const request = {
      key: 'k1',
      trigger: 'network' as const,
      toolName: 'bash',
      summary: 'curl example.com',
      justification: 'fetch the fixture',
      sessionId: 'sess-1',
      agentId: 'worker-1',
      role: 'implementer',
      worktree: '/repo/.kubic/wt/worker-1',
      provenance: { parentSessionId: 'orch-1', model: 'faux/faux' },
    };
    const approve = { approved: true, by: 'user' } as const;

    it("records the worker's pid, generation, thinking level and worktree base", () => {
      const input = orchestratorDecisionAudit(request, approve, {
        posture: 'approvals',
        pid: 4242,
        generation: 1,
        thinking: 'high',
        base: 'abc123',
      });
      expect(input.worker).toMatchObject({ pid: 4242, generation: 1 });
      expect(input.model.thinking).toBe('high');
      expect(input.workspace.base).toBe('abc123');
    });

    it('keeps the honest 0/unknown fallback when the run knows nothing (e.g. a forged key)', () => {
      const input = orchestratorDecisionAudit(
        { key: 'k9' } as unknown as typeof request,
        { approved: false, reason: 'no such ask' },
        { posture: 'approvals' },
      );
      expect(input.worker).toMatchObject({ pid: 0, generation: 0 });
      expect(input.model.thinking).toBe('unknown');
      expect(input.workspace.base).toBe('unknown');
    });

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

    it('probes git in the workspace dir, not the spawn cwd (issue #282 review gap)', async () => {
      // A scratch repo (the workspace) and a bare non-repo dir (the spawn
      // cwd): the probe must report the workspace's HEAD even though the
      // spawning shell sits elsewhere.
      const workspace = mkdtempSync(join(tmpdir(), 'kubic-base-ws-'));
      roots.push(workspace);
      const elsewhere = mkdtempSync(join(tmpdir(), 'kubic-base-cwd-'));
      roots.push(elsewhere);
      execFileSync('git', ['init', '-b', 'main'], {
        cwd: workspace,
        encoding: 'utf8',
      });
      execFileSync('git', ['config', 'user.email', 'base@kubic.dev'], {
        cwd: workspace,
      });
      execFileSync('git', ['config', 'user.name', 'kubic base'], {
        cwd: workspace,
      });
      execFileSync('git', ['config', 'commit.gpgsign', 'false'], {
        cwd: workspace,
      });
      writeFileSync(join(workspace, 'base.txt'), 'base\n');
      execFileSync('git', ['add', 'base.txt'], { cwd: workspace });
      execFileSync('git', ['commit', '-m', 'base'], { cwd: workspace });
      const expected = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: workspace,
        encoding: 'utf8',
      }).trim();
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
      const orchestrated = orchestratorDecisionAudit(request, approve, {
        posture: 'approvals',
        pid: 4242,
        generation: 1,
        thinking: 'medium',
        base: 'abc123',
      });
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
      for (const record of [orchestrated, solo]) {
        expect(JSON.stringify(record)).not.toContain('unknown');
      }
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
      '{"type":"orchestrator-ask-raised","detail":"legacy"}\n{torn\n',
    );
    expect(readAuditLedger(dir)).toEqual([]);
  });

  describe('privileged-action audit rows (issue #284)', () => {
    it('defines the closed privileged-action set', () => {
      expect(PRIVILEGED_ACTION_KINDS).toEqual([
        'full-access-grant',
        'merge',
        'worktree-create',
        'worktree-remove',
        'worker-spawn',
        'worker-terminate',
        'undo-restore',
      ]);
    });

    it('records a worker spawn with live registry provenance', () => {
      const record = workerSpawnAudit({
        sessionId: 'orch',
        agentId: 'worker-1',
        role: 'implementer',
        pid: 4242,
        generation: 0,
        worktree: '/repo/.kubic/wt/worker-1',
        base: 'abc123',
        model: 'faux/faux-1',
        thinking: 'off',
        posture: 'approvals',
      });
      expect(record.who).toBe('agent:worker-1');
      expect(record.what).toBe('worker-spawn:worker-1');
      expect(record.mode).toBe('orchestrator');
      expect(record.agent).toEqual({ session: 'orch', role: 'manager' });
      expect(record.worker).toEqual({
        pid: 4242,
        generation: 0,
        role: 'implementer',
      });
      expect(record.workspace).toEqual({
        path: '/repo/.kubic/wt/worker-1',
        base: 'abc123',
      });
      expect(record.model).toEqual({
        provider: 'faux',
        id: 'faux-1',
        thinking: 'off',
      });
      expect(record.result).toBe('ok');
    });

    it('records worker termination with ok and error results', () => {
      const base = {
        sessionId: 'orch',
        agentId: 'worker-1',
        role: 'implementer',
        pid: 4242,
        generation: 0,
        worktree: '/repo/.kubic/wt/worker-1',
        base: 'abc123',
        posture: 'approvals' as const,
      };
      const ok = workerTerminateAudit({ ...base, reason: 'ok', result: 'ok' });
      expect(ok.what).toBe('worker-terminate:worker-1');
      expect(ok.result).toBe('ok');
      expect(ok.reason).toBe('ok');
      const failed = workerTerminateAudit({
        ...base,
        reason: 'worker_failed',
        result: 'error',
      });
      expect(failed.result).toBe('error');
      expect(failed.reason).toBe('worker_failed');
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
      expect(record.mode).toBe('solo');
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

    it('records worktree creation and removal', () => {
      const created = worktreeCreateAudit({
        sessionId: 'orch',
        agentId: 'worker-1',
        path: '/repo/.kubic/wt/worker-1',
        branch: 'kubic/orch/worker-1',
        base: 'abc123',
        posture: 'approvals',
      });
      expect(created.what).toBe('worktree-create:kubic/orch/worker-1');
      expect(created.mode).toBe('orchestrator');
      expect(created.workspace).toEqual({
        path: '/repo/.kubic/wt/worker-1',
        base: 'abc123',
      });
      const removed = worktreeRemoveAudit({
        sessionId: 'cli',
        path: '/repo/.kubic/wt/worker-1',
        branch: 'kubic/orch/worker-1',
      });
      expect(removed.who).toBe('user:cli');
      expect(removed.what).toBe('worktree-remove:kubic/orch/worker-1');
      expect(removed.mode).toBe('solo');
      expect(removed.workspace.path).toBe('/repo/.kubic/wt/worker-1');
    });

    it('names the worktree path on approved merges', () => {
      const withTree = mergeDecisionAudit({
        sessionId: 'orch',
        agentId: 'worker-1',
        branch: 'kubic/orch/worker-1',
        workspace: '/repo',
        worktree: '/repo/.kubic/wt/worker-1',
        approved: true,
        by: '--yes',
        posture: 'approvals',
      });
      expect(withTree.what).toBe('merge:kubic/orch/worker-1');
      expect(withTree.reason).toContain('/repo/.kubic/wt/worker-1');
      const without = mergeDecisionAudit({
        sessionId: 'orch',
        agentId: 'worker-1',
        branch: 'kubic/orch/worker-1',
        workspace: '/repo',
        approved: true,
        by: '--yes',
        posture: 'approvals',
      });
      expect(without.reason).toBe('approved');
    });
  });

  it('kubic audit reads the ledger records back, filtered by mode', async () => {
    const dir = auditLedgerDir(repo());
    mkdirSync(dir, { recursive: true });
    const router = createWorkerAskRouter({ dir, maxPendingMs: 1_000 });
    await router.ask(askInput, { autoApprove: true });
    const lines: string[] = [];
    const code = await runAuditCommand(
      { mode: 'orchestrator', json: true },
      {
        loadRecords: () => readAuditLedger(dir),
        loadSecrets: () => [],
        out: (line) => lines.push(line),
        err: (line) => lines.push(line),
      },
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(lines.join('\n')) as unknown[];
    expect(parsed).toHaveLength(1);
  });
});

// The closed privileged-action set (issue #284 review): every kind in
// PRIVILEGED_ACTION_KINDS maps to a builder whose `what` carries the kind —
// a kind without coverage, or coverage without a kind, fails here. The two
// pre-union kinds keep their shipped shapes (`posture:full-access`,
// `merge:<branch>`); the five #284 builders write `<kind>:<identity>`.
describe('privileged-action kinds map to whats (issue #284)', () => {
  const sessionId = 'sess-kinds';
  const spawn = {
    sessionId,
    agentId: 'worker-1',
    role: 'implementer',
    worktree: '/repo/.kubic/wt/worker-1',
    generation: 0,
    posture: 'restricted',
  };

  it.each([
    ['full-access-grant', 'posture:full-access'],
    ['merge', 'merge:kubic/worker-1'],
    ['worktree-create', 'worktree-create:kubic/worker-1'],
    ['worktree-remove', 'worktree-remove:kubic/worker-1'],
    ['worker-spawn', 'worker-spawn:worker-1'],
    ['worker-terminate', 'worker-terminate:worker-1'],
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
            mode: 'solo',
          }).what,
        ).toBe(what);
        break;
      case 'merge':
        expect(
          mergeDecisionAudit({
            sessionId,
            agentId: 'worker-1',
            branch: 'kubic/worker-1',
            workspace: '/repo',
            approved: true,
            by: 'user',
            posture: 'approvals',
          }).what,
        ).toBe(what);
        break;
      case 'worktree-create':
        expect(
          worktreeCreateAudit({
            sessionId,
            agentId: 'worker-1',
            path: '/repo/.kubic/wt/worker-1',
            branch: 'kubic/worker-1',
            posture: 'approvals',
          }).what,
        ).toBe(what);
        break;
      case 'worktree-remove':
        expect(
          worktreeRemoveAudit({
            sessionId,
            path: '/repo/.kubic/wt/worker-1',
            branch: 'kubic/worker-1',
          }).what,
        ).toBe(what);
        break;
      case 'worker-spawn':
        expect(workerSpawnAudit(spawn).what).toBe(what);
        break;
      case 'worker-terminate':
        expect(
          workerTerminateAudit({ ...spawn, reason: 'ok', result: 'ok' }).what,
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

  it('the set is closed: no more and no fewer than the seven kinds', () => {
    expect([...PRIVILEGED_ACTION_KINDS].sort()).toEqual(
      [
        'full-access-grant',
        'merge',
        'undo-restore',
        'worker-spawn',
        'worker-terminate',
        'worktree-create',
        'worktree-remove',
      ].sort(),
    );
  });
});
