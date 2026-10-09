// End to end: the host approval service gating a real lane
// through the agent approve hook. The lane boots through
// the shared faux harness factory; its tool-end events come from the
// durable watch exactly as `kubic run`/`tui` consume them.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KubicLaneEvent, LaneEventSink } from '@kubic/agent/lane/events';
import { bootFauxLane, fauxToolUse } from '@kubic/agent/lane/test-harness';
import { fauxAssistantMessage, fauxToolCall } from '@kubic/agent/pi-boundary';
import { afterEach, describe, expect, it } from 'vitest';
import { auditLedgerDirFor, readAuditLedger } from '../policy/audit-ledger.js';
import { enableFullAccess } from './full-access.js';
import { installPolicy } from './install.js';
import { FileApprovalStore } from './stores.js';

const made: string[] = [];

function mkTmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe('approvals gate the lane', () => {
  it('denies a destructive call headless, runs it under full-access', async () => {
    const dir = mkTmp('approvals-lane-');
    const store = new FileApprovalStore(dir);

    // Each boot installs the policy anew: the posture is read once, at install.
    const runOnce = async (): Promise<KubicLaneEvent[]> => {
      const installed = installPolicy({
        workspace: dir,
        sessionDir: dir,
        maxPendingMs: 20,
      });
      const lane = await bootFauxLane({
        policy: { interceptors: installed.interceptors },
        responses: [
          fauxToolUse([fauxToolCall('bash', { command: 'rm -rf /tmp/x' })]),
          fauxAssistantMessage('done'),
        ],
      });
      try {
        const ends: KubicLaneEvent[] = [];
        const sink: LaneEventSink = (event) => {
          if (event.type === 'tool-end') ends.push(event);
        };
        const stop = await lane.subscribe(sink);
        try {
          await lane.run('clean tmp');
        } finally {
          await stop();
        }
        return ends;
      } finally {
        await lane.cleanup();
      }
    };

    const denied = await runOnce();
    expect(denied).toHaveLength(1);
    expect(JSON.stringify(denied[0])).toContain('not approved');

    enableFullAccess(store, 'test');
    // The posture is read once at boot, so full access applies
    // to the NEXT boot of the ask, never mid-session.
    const allowed = await runOnce();
    expect(allowed).toHaveLength(1);
    expect(JSON.stringify(allowed[0])).not.toContain('not approved');
    expect(JSON.stringify(allowed[0])).not.toContain(
      'destructive command blocked',
    );
  });
});

describe('credential access is challenged and audited', () => {
  it('denies a headless bash credential read and records trigger:credentials', async () => {
    const dir = mkTmp('approvals-cred-');
    const installed = installPolicy({
      workspace: dir,
      sessionDir: join(dir, 'session'),
    });
    const lane = await bootFauxLane({
      policy: { interceptors: installed.interceptors },
      responses: [
        fauxToolUse([
          fauxToolCall('bash', { command: 'cat ~/.aws/credentials' }),
        ]),
        fauxAssistantMessage('done'),
      ],
    });
    try {
      const ends: KubicLaneEvent[] = [];
      const sink: LaneEventSink = (event) => {
        if (event.type === 'tool-end') ends.push(event);
      };
      const stop = await lane.subscribe(sink);
      try {
        await lane.run('read the aws credentials');
      } finally {
        await stop();
      }
      // Refused, never run: the block names the missing approval.
      expect(ends).toHaveLength(1);
      expect(JSON.stringify(ends[0])).toContain('not approved');
    } finally {
      await lane.cleanup();
    }
    expect(installed.denials().map((entry) => entry.capability)).toContain(
      'credentials',
    );
    expect(installed.denials()[0]?.reason).toContain(
      'kubic run has no ask prompt',
    );
    const record = readAuditLedger(auditLedgerDirFor(dir)).find(
      (row) => row.permission.permission === 'trigger:credentials',
    );
    expect(record?.result).toBe('deny');
  });
});
