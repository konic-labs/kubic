// §60 audit ledger on the solo path: every resolved approval ask (a denial
// here — headless has no answer surface) appends one ledger record, and a
// ledger that cannot be written never throws into the approval path.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { installSoloPolicy } from './approvals.js';
import { AUDIT_LEDGER_FILE, auditLedgerDir } from './policy/audit-ledger.js';

const made: string[] = [];

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'solo-ledger-'));
  made.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const destructive = {
  toolName: 'bash',
  args: { command: 'rm -rf build' },
  toolCallId: 'call-1',
};

describe('solo approval decisions reach the §60 audit ledger', () => {
  it('appends a solo denial record when the ask resolves', async () => {
    const ws = workspace();
    const installed = installSoloPolicy({
      workspace: ws,
      sessionId: 'sess-1',
      model: 'faux/faux',
    });
    const verdict = await installed.ask(destructive);
    expect(verdict.approved).toBe(false);
    const file = join(auditLedgerDir(ws), AUDIT_LEDGER_FILE);
    expect(existsSync(file)).toBe(true);
    const records = readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records).toHaveLength(1);
    const record = records[0] as {
      mode: string;
      posture: string;
      what: string;
      agent: { session: string };
    };
    expect(record.mode).toBe('solo');
    expect(record.posture).toBe('approvals');
    expect(record.what).toBe('tool:bash');
    expect(record.agent.session).toBe('sess-1');
  });

  it('never throws into the approval path when the ledger cannot be written', async () => {
    const ws = workspace();
    // `.kubic/orchestrator` is a FILE: the ledger dir cannot be created.
    mkdirSync(join(ws, '.kubic'));
    writeFileSync(join(ws, '.kubic', 'orchestrator'), 'not a dir');
    const errors: string[] = [];
    const installed = installSoloPolicy({
      workspace: ws,
      sessionId: 'sess-2',
      onAuditError: (message) => errors.push(message),
    });
    const verdict = await installed.ask(destructive);
    expect(verdict.approved).toBe(false);
    expect(installed.denials()).toHaveLength(1);
    expect(errors.length).toBeGreaterThan(0);
  });
});
