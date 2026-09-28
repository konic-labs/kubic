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
  mergeDecisionAudit,
  readAuditLedger,
  soloDecisionAudit,
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
