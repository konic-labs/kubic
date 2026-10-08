// 'allow once' is one call, 'allow for the session' is the session. Before this
// issue ApprovalService.submit latched and persisted EVERY verdict, so pressing
// 'a' on `rm -rf build/` silently approved every later identical call — across
// restarts, via approvals.json.
//
// Hermetic: real service, real file store in a temp dir removed in afterEach.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type ApprovalVerdict,
  FileApprovalStore,
  installPolicy,
} from './approvals.js';
import { auditLedgerDir, readAuditLedger } from './policy/audit-ledger.js';

const made: string[] = [];

function tmpRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `kubic-approvals-allow-${prefix}`));
  made.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const CALL = {
  toolName: 'bash',
  args: { command: 'rm -rf build/' },
  toolCallId: 'c1',
};

function withSeat(verdict: ApprovalVerdict) {
  const workspace = tmpRoot('ws-');
  const sessionDir = tmpRoot('session-');
  let asks = 0;
  const installed = installPolicy({
    workspace,
    sessionDir,
    answer: async () => {
      asks += 1;
      return verdict;
    },
  });
  return { installed, sessionDir, workspace, asks: () => asks };
}

describe('allow-once is not latched', () => {
  it('approves the call, and a second identical request asks the seat again', async () => {
    const seat = withSeat({ approved: true, by: 'allow-once' });
    expect(await seat.installed.ask(CALL)).toEqual({
      approved: true,
      challenged: true,
    });
    expect(await seat.installed.ask(CALL)).toEqual({
      approved: true,
      challenged: true,
    });
    expect(seat.asks()).toBe(2);
  });

  it('approvals.json never contains an allow-once verdict', async () => {
    const seat = withSeat({ approved: true, by: 'allow-once' });
    await seat.installed.ask(CALL);
    expect(new FileApprovalStore(seat.sessionDir).load()).toEqual({});
    let text = '';
    try {
      text = readFileSync(join(seat.sessionDir, 'approvals.json'), 'utf8');
    } catch {
      // No file at all is also "no allow-once verdict".
    }
    expect(text).not.toContain('allow-once');
  });

  it('allow-session latches: the second request never reaches the seat', async () => {
    const seat = withSeat({ approved: true, by: 'allow-session' });
    await seat.installed.ask(CALL);
    await seat.installed.ask(CALL);
    expect(seat.asks()).toBe(1);
    expect(
      Object.values(new FileApprovalStore(seat.sessionDir).load()),
    ).toEqual([{ approved: true, by: 'allow-session', justified: false }]);
  });

  it('a user denial latches for the session (fail-safe direction)', async () => {
    const seat = withSeat({ approved: false, reason: 'denied by the user' });
    expect((await seat.installed.ask(CALL)).approved).toBe(false);
    expect((await seat.installed.ask(CALL)).approved).toBe(false);
    expect(seat.asks()).toBe(1);
  });

  it('the audit record still tells allow-once from allow-session', async () => {
    const once = withSeat({ approved: true, by: 'allow-once' });
    await once.installed.ask(CALL);
    const session = withSeat({ approved: true, by: 'allow-session' });
    await session.installed.ask(CALL);
    const onceText = JSON.stringify(
      readAuditLedger(auditLedgerDir(once.workspace)),
    );
    const sessionText = JSON.stringify(
      readAuditLedger(auditLedgerDir(session.workspace)),
    );
    expect(onceText).toContain('approved by allow-once');
    expect(sessionText).toContain('approved by allow-session');
  });
});
