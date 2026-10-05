// §60 audit ledger (one record format, one file): approval decisions are
// emitted through emitAudit as OrgAuditRecords and read back by the same
// reader `kubic audit` uses.
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
  mergeDecisionAudit,
  orchestratorDecisionAudit,
  readAuditLedger,
  resolveRunBaseRevision,
  soloDecisionAudit,
  workerGenerationFromEnv,
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
      const sha = await resolveRunBaseRevision(async () => ({
        exitCode: 0,
        stdout: '  abc123\n',
      }));
      expect(sha).toBe('abc123');
      await expect(
        resolveRunBaseRevision(async () => ({
          exitCode: 128,
          stdout: 'fatal: not a git repository',
        })),
      ).resolves.toBe('none');
      await expect(
        resolveRunBaseRevision(async () => {
          throw new Error('spawn git ENOENT');
        }),
      ).resolves.toBe('none');
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
