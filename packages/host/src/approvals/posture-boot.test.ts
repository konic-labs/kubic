// The full-access posture is resolved ONCE, at session boot. installPolicy
// must not re-read <session>/posture.json on every ask: one model-issued bash
// redirect (`echo '{"fullAccess":true}' > …/posture.json`) would otherwise switch
// approvals off for the rest of the session, and the ledger would record it as
// if the user had.
//
// Hermetic: temp session/workspace dirs removed in afterEach, no model.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../../test/temp-dir.js';
import { auditLedgerDir, readAuditLedger } from '../audit/index.js';
import { enableSessionFullAccess } from './full-access.js';
import { installPolicy } from './install.js';
import { FileApprovalStore } from './stores.js';

function tmpRoot(prefix: string): string {
  return tempDir(`kubic-approvals-posture-${prefix}`);
}

const DESTRUCTIVE = {
  toolName: 'bash',
  args: { command: 'rm -rf build' },
  toolCallId: 'c1',
};

function forgePosture(sessionDir: string): void {
  // Exactly what the model's bash redirect writes.
  writeFileSync(join(sessionDir, 'posture.json'), '{"fullAccess":true}');
}

describe('posture is decided at boot', () => {
  it('a posture.json written after install does not approve a destructive call', async () => {
    const workspace = tmpRoot('ws-');
    const sessionDir = tmpRoot('session-');
    let asks = 0;
    const installed = installPolicy({
      workspace,
      sessionDir,
      answer: async () => {
        asks += 1;
        return { approved: false, reason: 'denied by the user' };
      },
    });
    expect(installed.posture.fullAccess).toBe(false);
    forgePosture(sessionDir);
    const verdict = await installed.ask(DESTRUCTIVE);
    expect(verdict.approved).toBe(false);
    expect(asks).toBe(1);
  });

  it('headless: the forged posture is refused, not honoured', async () => {
    const workspace = tmpRoot('ws-');
    const sessionDir = tmpRoot('session-');
    const installed = installPolicy({ workspace, sessionDir });
    forgePosture(sessionDir);
    expect((await installed.ask(DESTRUCTIVE)).approved).toBe(false);
  });

  it('a session created with --dangerously-skip-approvals still starts in full access', async () => {
    const workspace = tmpRoot('ws-');
    const sessionDir = tmpRoot('session-');
    enableSessionFullAccess({
      sessionDir,
      sessionId: 'sess-posture-other',
      command: 'sessions create',
      workspace,
    });
    const installed = installPolicy({ workspace, sessionDir });
    expect(installed.posture.fullAccess).toBe(true);
    expect(await installed.ask(DESTRUCTIVE)).toEqual({
      approved: true,
      challenged: true,
    });
  });

  it('audit records carry the posture decided at boot, and the mid-run change is recorded once', async () => {
    const workspace = tmpRoot('ws-');
    const sessionDir = tmpRoot('session-');
    const installed = installPolicy({ workspace, sessionDir });
    forgePosture(sessionDir);
    await installed.ask(DESTRUCTIVE);
    await installed.ask(DESTRUCTIVE);
    const records = readAuditLedger(auditLedgerDir(workspace));
    const decisions = records.filter((r) => r.what === 'tool:bash');
    expect(decisions).toHaveLength(2);
    for (const record of decisions) expect(record.posture).toBe('approvals');
    const changes = records.filter(
      (r) => r.what === 'posture:changed-mid-session',
    );
    expect(changes).toHaveLength(1);
    expect(changes[0]?.result).toBe('deny');
  });

  it('the forged file is restored to the boot posture, so a later resume stays enforced', async () => {
    const workspace = tmpRoot('ws-');
    const sessionDir = tmpRoot('session-');
    const installed = installPolicy({ workspace, sessionDir });
    forgePosture(sessionDir);
    await installed.ask(DESTRUCTIVE);
    expect(
      JSON.parse(readFileSync(join(sessionDir, 'posture.json'), 'utf8')),
    ).toEqual({ fullAccess: false });
    const resumed = installPolicy({ workspace, sessionDir });
    expect(resumed.posture.fullAccess).toBe(false);
  });

  it('the installed ask also reads the posture once', async () => {
    const dir = tmpRoot('store-');
    const installed = installPolicy({
      workspace: dir,
      sessionDir: dir,
      maxPendingMs: 10,
    });
    forgePosture(dir);
    expect((await installed.ask(DESTRUCTIVE)).approved).toBe(false);
  });
});

// The in-session toggle. It flips the LIVE posture
// the ask reads (so the very next challenged call follows it), writes
// posture.json through the same host helpers the CLI uses, and re-bases the
// Guard so the operator's own change is not restored underneath them.
describe('the in-session full-access toggle', () => {
  it('flips the live posture, the file and the indicator, and the next call follows', async () => {
    const workspace = tmpRoot('ws-');
    const sessionDir = tmpRoot('session-');
    let asks = 0;
    const installed = installPolicy({
      workspace,
      sessionDir,
      sessionId: 'sess-posture',
      answer: async () => {
        asks += 1;
        return { approved: true, by: 'user' };
      },
    });
    expect(installed.posture.fullAccess).toBe(false);
    expect(installed.approvalsSkipped()).toBe(false);
    // A challenged call asks first.
    expect((await installed.ask(DESTRUCTIVE)).approved).toBe(true);
    expect(asks).toBe(1);

    // Enable: the live posture, the predicate, the file and the audit row all
    // move (the row names the action, in order).
    installed.setFullAccess?.(true, 'kubic tui /approvals on');
    expect(installed.posture.fullAccess).toBe(true);
    expect(
      readAuditLedger(auditLedgerDir(workspace))
        .filter((record) => record.what === 'posture:full-access')
        .map((record) => record.posture),
    ).toEqual(['full-access']);
    expect(installed.approvalsSkipped()).toBe(true);
    expect(new FileApprovalStore(sessionDir).loadPosture()).toMatchObject({
      fullAccess: true,
    });
    // The next challenged call is waived (no ask).
    expect(await installed.ask(DESTRUCTIVE)).toEqual({
      approved: true,
      challenged: true,
    });
    expect(asks).toBe(1);
    // The guard accepts the operator's own change: settle() does NOT
    // restore the boot posture underneath them.
    installed.settle?.();
    expect(installed.posture.fullAccess).toBe(true);
    expect(new FileApprovalStore(sessionDir).loadPosture()).toMatchObject({
      fullAccess: true,
    });

    // Disable: the next destructive call raises an approval again. A
    // DIFFERENT command, because an answered call latches for the session.
    installed.setFullAccess?.(false, 'kubic tui /approvals off');
    expect(installed.approvalsSkipped()).toBe(false);
    expect(
      readAuditLedger(auditLedgerDir(workspace))
        .filter((record) => record.what.startsWith('posture:'))
        .map((record) => record.what),
    ).toEqual(['posture:full-access', 'posture:approvals']);
    expect(new FileApprovalStore(sessionDir).loadPosture()).toMatchObject({
      fullAccess: false,
    });
    expect(
      (
        await installed.ask({
          ...DESTRUCTIVE,
          args: { command: 'rm -rf dist' },
        })
      ).approved,
    ).toBe(true);
    expect(asks).toBe(2);
  });

  it('writes two audit rows in order — enabled then revoked', () => {
    const workspace = tmpRoot('ws-');
    const sessionDir = tmpRoot('session-');
    enableSessionFullAccess({
      sessionDir,
      sessionId: 'sess-posture',
      command: 'tui',
      workspace,
      clock: () => 1_700_000_000_000,
    });
    const revoked = installPolicy({
      workspace,
      sessionDir,
      sessionId: 'sess-posture',
      clock: () => 1_700_000_000_500,
    }).setFullAccess?.(false, 'kubic tui /approvals off');
    expect(revoked?.fullAccess).toBe(false);
    expect(new FileApprovalStore(sessionDir).loadPosture()).toMatchObject({
      fullAccess: false,
    });
    const rows = readAuditLedger(auditLedgerDir(workspace)).filter(
      (record) =>
        record.what === 'posture:full-access' ||
        record.what === 'posture:approvals',
    );
    expect(rows.map((record) => record.what)).toEqual([
      'posture:full-access',
      'posture:approvals',
    ]);
    expect(rows.map((record) => record.posture)).toEqual([
      'full-access',
      'approvals',
    ]);
    expect(JSON.stringify(rows[1])).toContain('kubic tui /approvals off');
  });

  it('re-bases the guard on the record the posture file holds', () => {
    const workspace = tmpRoot('ws-');
    const sessionDir = tmpRoot('session-');
    // Every clock read returns a DIFFERENT millisecond: two reads would put
    // the file and the guard's baseline out of step, and the guard — which
    // runs before every challenged call and on settle — would judge the
    // operator's own flip a foreign change, rewrite the file and append a
    // false `posture:changed-mid-session` row.
    let tick = 1_700_000_000_000;
    const installed = installPolicy({
      workspace,
      sessionDir,
      clock: () => (tick += 1),
    });
    const recorded = installed.setFullAccess?.(true, 'kubic tui /approvals on');
    expect(recorded?.fullAccess).toBe(true);
    expect(recorded?.enabledAt).toBe(
      new FileApprovalStore(sessionDir).loadPosture().enabledAt,
    );
    // The guard finds nothing to restore and nothing to record.
    installed.settle?.();
    expect(
      readAuditLedger(auditLedgerDir(workspace)).map((record) => record.what),
    ).toEqual(['posture:full-access']);
    expect(new FileApprovalStore(sessionDir).loadPosture()).toMatchObject({
      fullAccess: true,
      enabledAt: recorded?.enabledAt,
    });
  });

  it('the in-session toggle writes its enable and revoke rows in one shape', () => {
    const workspace = tmpRoot('ws-');
    const clock = () => 1_700_000_000_000;
    const toggleDir = tmpRoot('session-toggle-');
    // Enable and revoke through the installed policy's toggle (the TUI path):
    // the rows come from one writer, so their shapes must match.
    enableSessionFullAccess({
      sessionDir: toggleDir,
      sessionId: 'sess-posture',
      command: 'tui',
      workspace,
      clock,
    });
    installPolicy({
      workspace,
      sessionDir: toggleDir,
      sessionId: 'sess-posture',
      clock,
    }).setFullAccess?.(false, 'kubic tui /approvals off');
    const rows = readAuditLedger(auditLedgerDir(workspace)).filter(
      (record) =>
        record.what === 'posture:full-access' ||
        record.what === 'posture:approvals',
    );
    expect(rows.map((record) => record.what)).toEqual([
      'posture:full-access',
      'posture:approvals',
    ]);
    // The ledger stamps `when` from the wall clock; every other field — the
    // row shape, the command, the session, the workspace, the posture — is
    // the writer's own record and must be identical.
    const shape = (row: (typeof rows)[number]) =>
      Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'when'));
    expect(Object.keys(shape(rows[0])).sort()).toEqual(
      Object.keys(shape(rows[1])).sort(),
    );
  });

  it('a disabled posture is what a later resume boots with', () => {
    const workspace = tmpRoot('ws-');
    const sessionDir = tmpRoot('session-');
    enableSessionFullAccess({
      sessionDir,
      sessionId: 'sess-posture',
      command: 'sessions create',
      workspace,
    });
    const first = installPolicy({ workspace, sessionDir });
    expect(first.posture.fullAccess).toBe(true);
    first.setFullAccess?.(false, 'kubic tui /approvals off');
    // A fresh install (a resume) reads the revoked posture.
    const second = installPolicy({ workspace, sessionDir });
    expect(second.posture.fullAccess).toBe(false);
    expect(second.approvalsSkipped()).toBe(false);
  });
});
