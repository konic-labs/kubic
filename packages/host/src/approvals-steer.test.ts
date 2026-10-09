// Steering an approval: a
// denial carries the operator's comment to the model, an edited command runs
// instead of the proposed one after it is judged again, and "allow all edits
// this turn" approves the turn's edit/write asks of the same kind — never
// another capability, never past the turn. Driven end to end on a faux lane
// through the policy and the lane's own hooks.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KubicLaneEvent } from '@kubic/agent/lane/events';
import {
  bootFauxLane,
  type FauxLane,
  fauxToolUse,
} from '@kubic/agent/lane/test-harness';
import { fauxAssistantMessage, fauxToolCall } from '@kubic/agent/pi-boundary';
import { FakeExecutionEnv } from '@kubic/exec/env';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ALLOW_TURN_EDITS,
  type ApprovalRequest,
  type ApprovalVerdict,
  type InstalledPolicy,
  installPolicy,
} from './approvals.js';
import { auditLedgerDirFor, readAuditLedger } from './policy/audit-ledger.js';

const made: string[] = [];

afterEach(() => {
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

interface Rig {
  dir: string;
  asks: ApprovalRequest[];
  installed: InstalledPolicy;
  env: FakeExecutionEnv;
  lane: FauxLane;
  turn: (prompt: string) => Promise<KubicLaneEvent[]>;
}

async function rig(options: {
  answer: (request: ApprovalRequest, n: number) => ApprovalVerdict;
  responses: Parameters<typeof bootFauxLane>[0] extends infer O
    ? O extends { responses?: infer R }
      ? R
      : never
    : never;
  requires?: string[];
}): Promise<Rig> {
  const dir = mkdtempSync(join(tmpdir(), 'kubic-approvals-steer-'));
  made.push(dir);
  mkdirSync(join(dir, 'session'), { recursive: true });
  const asks: ApprovalRequest[] = [];
  const installed = installPolicy({
    workspace: dir,
    sessionDir: join(dir, 'session'),
    ...(options.requires === undefined ? {} : { requires: options.requires }),
    answer: async (request) => {
      asks.push(request);
      return options.answer(request, asks.length);
    },
  });
  const env = new FakeExecutionEnv({});
  const lane = await bootFauxLane({
    policy: { interceptors: installed.interceptors },
    responses: options.responses,
    env,
  });
  const turn = async (prompt: string): Promise<KubicLaneEvent[]> => {
    const ends: KubicLaneEvent[] = [];
    const stop = await lane.subscribe((event) => {
      if (event.type === 'tool-end') ends.push(event);
    });
    try {
      await lane.run(prompt);
    } finally {
      await stop();
    }
    return ends;
  };
  return { dir, asks, installed, env, lane, turn };
}

const ran = (env: FakeExecutionEnv): string => JSON.stringify(env.calls);

describe('deny with a comment', () => {
  it("tells the model why, and records the operator's words", async () => {
    const r = await rig({
      answer: () => ({
        approved: false,
        reason: 'denied by the user: use git clean -n first',
      }),
      responses: [
        fauxToolUse([fauxToolCall('bash', { command: 'rm -rf /tmp/x' })]),
        fauxAssistantMessage('ok'),
      ],
    });
    try {
      const ends = await r.turn('clean');
      expect(JSON.stringify(ends[0])).toContain(
        'not approved: denied by the user: use git clean -n first',
      );
      expect(ran(r.env)).not.toContain('rm -rf');
      const records = readAuditLedger(auditLedgerDirFor(r.dir)).filter(
        (record) => record.what === 'tool:bash',
      );
      expect(records.at(-1)?.reason).toBe(
        'denied by the user: use git clean -n first',
      );
    } finally {
      await r.lane.cleanup();
    }
  });
});

describe('edit then allow', () => {
  it('runs the edited command instead, judged again first', async () => {
    const r = await rig({
      answer: () => ({
        approved: true,
        by: 'allow-once',
        edited: { command: 'rm -i tmp/x.log' },
      }),
      responses: [
        fauxToolUse([fauxToolCall('bash', { command: 'rm -rf /tmp/x' })]),
        fauxAssistantMessage('ok'),
      ],
    });
    try {
      const ends = await r.turn('clean');
      expect(r.asks).toHaveLength(1);
      expect(r.asks[0]?.editable).toBe(true);
      expect(JSON.stringify(ends[0])).not.toContain('not approved');
      expect(ran(r.env)).toContain('rm -i tmp/x.log');
      expect(ran(r.env)).not.toContain('rm -rf /tmp/x');
      // The result says what ran, for the model and the transcript alike.
      expect(JSON.stringify(ends[0])).toContain(
        '[edited by the user — ran: rm -i tmp/x.log (proposed: rm -rf /tmp/x)]',
      );
      const note = readAuditLedger(auditLedgerDirFor(r.dir))
        .map((record) => record.reason)
        .find((reason) => reason.startsWith('edited by the user'));
      expect(note).toBe('edited by the user: rm -rf /tmp/x → rm -i tmp/x.log');
    } finally {
      await r.lane.cleanup();
    }
  });

  it('asks again when the edit is itself dangerous', async () => {
    const r = await rig({
      answer: (_request, n) =>
        n === 1
          ? {
              approved: true,
              by: 'allow-once',
              edited: { command: 'rm -rf /tmp/y' },
            }
          : { approved: true, by: 'allow-once' },
      responses: [
        fauxToolUse([fauxToolCall('bash', { command: 'rm -rf /tmp/x' })]),
        fauxAssistantMessage('ok'),
      ],
    });
    try {
      await r.turn('clean');
      expect(r.asks.map((ask) => ask.command)).toEqual([
        'rm -rf /tmp/x',
        'rm -rf /tmp/y',
      ]);
      expect(ran(r.env)).toContain('rm -rf /tmp/y');
      expect(ran(r.env)).not.toContain('rm -rf /tmp/x');
    } finally {
      await r.lane.cleanup();
    }
  });

  it('refuses an empty edit', async () => {
    const r = await rig({
      answer: () => ({
        approved: true,
        by: 'allow-once',
        edited: { command: '   ' },
      }),
      responses: [
        fauxToolUse([fauxToolCall('bash', { command: 'rm -rf /tmp/x' })]),
        fauxAssistantMessage('ok'),
      ],
    });
    try {
      const ends = await r.turn('clean');
      expect(JSON.stringify(ends[0])).toContain('the edited command is empty');
      expect(ran(r.env)).not.toContain('rm -rf');
    } finally {
      await r.lane.cleanup();
    }
  });
});

describe('allow all edits this turn', () => {
  const writeCall = (path: string) =>
    fauxToolCall('write', { path, content: 'x\n' });

  it("approves the turn's role-obliged writes at once, and asks again next turn", async () => {
    const r = await rig({
      requires: ['write'],
      answer: () => ({ approved: true, by: ALLOW_TURN_EDITS }),
      responses: [
        fauxToolUse([writeCall('a.md')]),
        fauxToolUse([writeCall('b.md')]),
        fauxAssistantMessage('turn one'),
        fauxToolUse([writeCall('c.md')]),
        fauxAssistantMessage('turn two'),
      ],
    });
    try {
      await r.turn('one');
      expect(r.asks).toHaveLength(1);
      expect(r.asks[0]?.batchable).toBe(true);
      expect(r.installed.editsApprovedThisTurn?.()).toBe(true);
      r.installed.endTurn?.();
      expect(r.installed.editsApprovedThisTurn?.()).toBe(false);
      await r.turn('two');
      expect(r.asks).toHaveLength(2);
    } finally {
      await r.lane.cleanup();
    }
  });

  it('never covers a write outside the workspace', async () => {
    const r = await rig({
      requires: ['write'],
      answer: (request) =>
        request.capability === 'outside-write'
          ? { approved: false, reason: 'denied by the user' }
          : { approved: true, by: ALLOW_TURN_EDITS },
      responses: [
        fauxToolUse([writeCall('a.md')]),
        fauxToolUse([writeCall('/etc/kubic-steer-probe')]),
        fauxAssistantMessage('done'),
      ],
    });
    try {
      const ends = await r.turn('go');
      expect(r.asks.map((ask) => ask.capability)).toContain('outside-write');
      expect(JSON.stringify(ends[1])).toContain('not approved');
    } finally {
      await r.lane.cleanup();
    }
  });

  it('is never offered for another kind of ask, and never latches', async () => {
    const r = await rig({
      answer: () => ({ approved: true, by: ALLOW_TURN_EDITS }),
      responses: [
        fauxToolUse([fauxToolCall('bash', { command: 'rm -rf /tmp/x' })]),
        fauxToolUse([fauxToolCall('bash', { command: 'rm -rf /tmp/x' })]),
        fauxAssistantMessage('done'),
      ],
    });
    try {
      await r.turn('go');
      expect(r.asks[0]?.batchable).toBeUndefined();
      // Answered with the batch anyway: it approved that one call only.
      expect(r.asks).toHaveLength(2);
      expect(r.installed.editsApprovedThisTurn?.()).toBe(false);
    } finally {
      await r.lane.cleanup();
    }
  });
});
