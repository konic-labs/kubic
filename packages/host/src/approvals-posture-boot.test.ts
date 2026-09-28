// The full-access posture is resolved ONCE, at session boot (issue #325;
// §41.4, §41.2, §59). Before this issue installSoloPolicy re-read
// <session>/posture.json on every ask, so one model-issued bash redirect
// (`echo '{"fullAccess":true}' > …/posture.json`) switched approvals off for
// the rest of the session — and the ledger recorded it as if the user had.
//
// Hermetic: temp session/workspace dirs removed in afterEach, no model.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SOLO_DEFAULTS } from '../../agents/src/policy.js';
import {
  ApprovalService,
  createApprovalAsk,
  enableSessionFullAccess,
  FileApprovalStore,
  installSoloPolicy,
  triggerContextFor,
  validatePolicy,
} from './approvals.js';
import { auditLedgerDir, readAuditLedger } from './policy/audit-ledger.js';

const made: string[] = [];

function tmpRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `kubic-325-${prefix}`));
  made.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const DESTRUCTIVE = {
  toolName: 'bash',
  args: { command: 'rm -rf build' },
  toolCallId: 'c1',
};

function forgePosture(sessionDir: string): void {
  // Exactly what the model's bash redirect writes.
  writeFileSync(join(sessionDir, 'posture.json'), '{"fullAccess":true}');
}

describe('posture is decided at boot (issue #325)', () => {
  it('a posture.json written after install does not approve a destructive call', async () => {
    const workspace = tmpRoot('ws-');
    const sessionDir = tmpRoot('session-');
    let asks = 0;
    const installed = installSoloPolicy({
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
    const installed = installSoloPolicy({ workspace, sessionDir });
    forgePosture(sessionDir);
    expect((await installed.ask(DESTRUCTIVE)).approved).toBe(false);
  });

  it('a session created with --dangerously-skip-approvals still starts in full access', async () => {
    const workspace = tmpRoot('ws-');
    const sessionDir = tmpRoot('session-');
    enableSessionFullAccess({
      sessionDir,
      sessionId: 'sess-325',
      command: 'sessions create',
      workspace,
    });
    const installed = installSoloPolicy({ workspace, sessionDir });
    expect(installed.posture.fullAccess).toBe(true);
    expect(await installed.ask(DESTRUCTIVE)).toEqual({
      approved: true,
      challenged: true,
    });
  });

  it('audit records carry the posture decided at boot, and the mid-run change is recorded once', async () => {
    const workspace = tmpRoot('ws-');
    const sessionDir = tmpRoot('session-');
    const installed = installSoloPolicy({ workspace, sessionDir });
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
    const installed = installSoloPolicy({ workspace, sessionDir });
    forgePosture(sessionDir);
    await installed.ask(DESTRUCTIVE);
    expect(
      JSON.parse(readFileSync(join(sessionDir, 'posture.json'), 'utf8')),
    ).toEqual({ fullAccess: false });
    const resumed = installSoloPolicy({ workspace, sessionDir });
    expect(resumed.posture.fullAccess).toBe(false);
  });

  it('createApprovalAsk also reads the posture once', async () => {
    const dir = tmpRoot('store-');
    const store = new FileApprovalStore(dir);
    const service = new ApprovalService({
      policy: validatePolicy({ maxPendingMs: 10 }),
      store,
    });
    const ask = createApprovalAsk(
      service,
      triggerContextFor({ ...SOLO_DEFAULTS }, dir),
      store,
    );
    forgePosture(dir);
    expect((await ask(DESTRUCTIVE)).approved).toBe(false);
  });
});
