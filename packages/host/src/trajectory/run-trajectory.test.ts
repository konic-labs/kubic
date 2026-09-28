// Run → §46 trajectory assembly (issue #383). Pure: session entries, journal
// changes, ledger records and the settled outcome in; a TrajectoryExport
// that parseTrajectoryExport accepts out. Entry shapes are the ones the
// real solo lane stores (assistant toolCall parts, toolResult messages,
// per-request usage on assistant messages).
import { describe, expect, it } from 'vitest';
import { toolSpawnEnv } from '../../../exec/src/env.js';
import type { FileChange } from '../../../exec/src/journal-diff.js';
import { parseTrajectoryExport } from '../../../trajectory/src/schema.js';
import type { OrgAuditRecord } from '../policy/audit.js';
import {
  assembleRunTrajectory,
  type RunTrajectoryInput,
  taskIdForPrompt,
  trajectoryResultFor,
} from './run-trajectory.js';

const STARTED = Date.parse('2026-09-28T10:00:00.000Z');

function usage(input: number, output: number, cost: number) {
  return {
    input,
    output,
    cacheRead: 5,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
  };
}

// The stored chain of one faux run with a single `read` call, out of order
// (the store makes no order promise) plus one entry from an earlier run.
const ENTRIES: unknown[] = [
  {
    type: 'message',
    seq: 40,
    timestamp: STARTED + 30,
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'faux: read returned 6 chars' }],
      provider: 'faux',
      model: 'echo',
      usage: usage(20, 7, 0.001),
    },
  },
  {
    type: 'message',
    seq: 29,
    timestamp: STARTED + 20,
    message: {
      role: 'toolResult',
      toolCallId: 'call-1',
      toolName: 'read',
      content: [{ type: 'text', text: 'hello\n' }],
    },
  },
  {
    type: 'message',
    seq: 19,
    timestamp: STARTED + 10,
    message: {
      role: 'assistant',
      content: [
        {
          type: 'toolCall',
          id: 'call-1',
          name: 'read',
          arguments: { path: 'a.txt' },
        },
      ],
      provider: 'faux',
      model: 'echo',
      usage: usage(100, 6, 0.002),
    },
  },
  {
    type: 'message',
    seq: 6,
    timestamp: STARTED + 1,
    message: { role: 'user', content: [{ type: 'text', text: 'read a.txt' }] },
  },
  {
    // An earlier run of a resumed session: never part of this trajectory.
    type: 'message',
    seq: 2,
    timestamp: STARTED - 60_000,
    message: {
      role: 'assistant',
      content: [
        { type: 'toolCall', id: 'old', name: 'bash', arguments: { cmd: 'x' } },
      ],
      provider: 'faux',
      model: 'echo',
      usage: usage(999, 999, 9),
    },
  },
];

function change(overrides: Partial<FileChange> = {}): FileChange {
  return {
    path: 'a.txt',
    op: 'write',
    agentId: 'root',
    toolCallId: 'call-2',
    sessionId: 'sess-1',
    timestamp: STARTED + 15,
    unattributed: false,
    reversible: true,
    before: 'hello\n',
    after: 'hello world\n',
    corrupt: false,
    afterOmitted: false,
    ...overrides,
  } as FileChange;
}

function ledger(overrides: Partial<OrgAuditRecord> = {}): OrgAuditRecord {
  return {
    who: 'user',
    what: 'approval',
    when: new Date(STARTED + 12).toISOString(),
    agent: { session: 'sess-1', role: 'solo' },
    model: { provider: 'faux', id: 'echo', thinking: 'off' },
    worker: { pid: 1, generation: 0, role: 'solo' },
    workspace: { path: '/ws', base: 'abc' },
    permission: { permission: 'shell', approval: 'ask' },
    credential: { sentinel: '' },
    network: { host: '', port: 0, decision: 'allow', bytes: 0 },
    mode: 'solo',
    posture: 'default',
    result: 'ok',
    reason: 'approved by user',
    ...overrides,
  } as OrgAuditRecord;
}

function input(
  overrides: Partial<RunTrajectoryInput> = {},
): RunTrajectoryInput {
  return {
    sessionId: 'sess-1',
    agentId: 'root',
    workerId: null,
    role: 'solo',
    prompt: 'read a.txt',
    entries: ENTRIES,
    model: { provider: 'faux', id: 'echo', thinking: null },
    pid: 4242,
    generation: 0,
    cwd: '/ws',
    baseRevision: 'abc123',
    branch: 'main',
    env: { PATH: '/usr/bin' },
    changes: [change()],
    approvals: [ledger()],
    skills: ['budget'],
    startedAt: STARTED,
    endedAt: STARTED + 100,
    outcome: { terminus: 'completed', summary: 'faux: read returned 6 chars' },
    ...overrides,
  };
}

describe('assembleRunTrajectory (issue #383)', () => {
  it('builds a §46 export that parseTrajectoryExport accepts', () => {
    const exported = assembleRunTrajectory(input());
    expect(() =>
      parseTrajectoryExport(JSON.parse(JSON.stringify(exported))),
    ).not.toThrow();
    expect(exported.schema_version).toBe('1.0');
  });

  it('records the run provenance: session, agent, pid, generation, worktree, model', () => {
    const exported = assembleRunTrajectory(input({ generation: 3, pid: 7 }));
    expect(exported.provenance).toEqual({
      sessionId: 'sess-1',
      agentId: 'root',
      pid: 7,
      generation: 3,
      worktree: '/ws',
      model: 'faux/echo',
    });
    expect(exported.model).toEqual({
      provider: 'faux',
      model: 'echo',
      thinking: null,
      escalations: [],
    });
    expect(exported.worktree).toEqual({
      path: '/ws',
      baseRevision: 'abc123',
      branch: 'main',
    });
    expect(exported.identity).toEqual({
      sessionId: 'sess-1',
      agentId: 'root',
      workerId: null,
    });
  });

  it('maps tool calls to actions and tool results to observations, in seq order, this run only', () => {
    const exported = assembleRunTrajectory(input());
    expect(exported.actions).toEqual([
      { seq: 1, tool: 'read', args: { path: 'a.txt' } },
    ]);
    expect(exported.observations).toEqual([
      {
        seq: 1,
        actionSeq: 1,
        output: 'hello\n',
        truncated: false,
        bytesOriginal: 6,
      },
    ]);
  });

  it("sums usage over this run's assistant messages", () => {
    const exported = assembleRunTrajectory(input());
    expect(exported.usage).toEqual({
      inputTokens: 120,
      outputTokens: 13,
      cachedTokens: 10,
      requests: 2,
      costUsd: 0.003,
      byModel: {
        'faux/echo': { requests: 2, input: 120, output: 13, costTotal: 0.003 },
      },
    });
  });

  it('records the journal diff of this session and this run', () => {
    const exported = assembleRunTrajectory(
      input({
        changes: [
          change(),
          change({ path: 'other-session.txt', sessionId: 'sess-2' }),
          change({ path: 'earlier.txt', timestamp: STARTED - 1 }),
        ],
      }),
    );
    expect(exported.diff.filesChanged).toEqual(['a.txt']);
    expect(exported.diff.files[0]?.path).toBe('a.txt');
    expect(exported.diff.files[0]?.hunks.join('\n')).toMatch(/\+hello world/);
  });

  it('records ledger approvals of this session and run with their verdicts', () => {
    const exported = assembleRunTrajectory(
      input({
        approvals: [
          ledger(),
          ledger({ result: 'deny', reason: 'denied by user' }),
          ledger({
            result: 'deny',
            reason: 'approval timed out after 120000ms',
          }),
          ledger({ agent: { session: 'sess-2', role: 'solo' } }),
          ledger({ when: new Date(STARTED - 5).toISOString() }),
        ],
      }),
    );
    expect(exported.approvals).toEqual([
      {
        approvalId: 'sess-1:1',
        capability: 'shell',
        verdict: 'approved',
        by: 'user',
      },
      {
        approvalId: 'sess-1:2',
        capability: 'shell',
        verdict: 'denied',
        by: 'user',
      },
      {
        approvalId: 'sess-1:3',
        capability: 'shell',
        verdict: 'timed-out',
        by: 'user',
      },
    ]);
  });

  it('records the used environment verbatim with capturedFrom used', () => {
    const exported = assembleRunTrajectory(input());
    expect(exported.environment).toEqual({
      capturedFrom: 'used',
      cwd: '/ws',
      env: { PATH: '/usr/bin' },
    });
  });

  it('exported environment.env keys equal toolSpawnEnv() keys (no secrets)', () => {
    const base = {
      PATH: '/usr/bin',
      HOME: '/home/u',
      LANG: 'C',
      ANTHROPIC_API_KEY: 'sk-live',
      GITHUB_TOKEN: 'ghp_x',
      KUBIC_ROLE_WRITER_TOKEN: 't',
    };
    const env = toolSpawnEnv(base);
    const exported = assembleRunTrajectory(input({ env }));
    expect(Object.keys(exported.environment.env).sort()).toEqual(
      Object.keys(env).sort(),
    );
    expect(JSON.stringify(exported)).not.toMatch(/sk-live|ghp_x/);
  });

  it('derives a stable task id from the prompt so runs of one prompt pair', () => {
    const a = assembleRunTrajectory(input({ sessionId: 'sess-a' }));
    const b = assembleRunTrajectory(input({ sessionId: 'sess-b' }));
    expect(a.task.taskId).toBe(b.task.taskId);
    expect(a.task.taskId).toBe(taskIdForPrompt('read a.txt'));
    expect(taskIdForPrompt('read b.txt')).not.toBe(a.task.taskId);
    expect(a.task).toMatchObject({ objective: 'read a.txt', role: 'solo' });
    expect(a.transfer).toEqual({
      taskId: a.task.taskId,
      worktree: '/ws',
      grantRef: 'role:solo',
    });
    expect(a.resources).toEqual({ skills: ['budget'], promptTemplates: [] });
    expect(a.prompt).toEqual({ text: 'read a.txt', constraints: [] });
  });

  it('keeps the run timestamps', () => {
    expect(assembleRunTrajectory(input()).timestamps).toEqual({
      startedAt: '2026-09-28T10:00:00.000Z',
      endedAt: '2026-09-28T10:00:00.100Z',
      durationMs: 100,
    });
  });
});

describe('assembleRunTrajectory reads real entries defensively (issue #383)', () => {
  const at = (offset: number) => STARTED + offset;

  it('skips foreign or malformed entries and keeps the run-start boundary inclusive', () => {
    const exported = assembleRunTrajectory(
      input({
        entries: [
          null,
          'not an entry',
          ['an', 'array'],
          { type: 'compaction', seq: 1, timestamp: at(1), message: {} },
          { type: 'message', seq: 2, timestamp: at(1), message: 'text' },
          {
            type: 'message',
            seq: 3,
            timestamp: at(1),
            message: { content: [] },
          },
          // Exactly at the run start: part of this run.
          {
            type: 'message',
            seq: 4,
            timestamp: STARTED,
            message: {
              role: 'assistant',
              content: [
                { type: 'toolCall', id: 'c1', name: 42, arguments: undefined },
                'not a part',
                { type: 'text', text: 'thinking' },
              ],
            },
          },
          // No seq/timestamp numbers: sorts first, filtered by time (0 < start).
          {
            type: 'message',
            seq: 'x',
            timestamp: 'y',
            message: {
              role: 'assistant',
              content: [{ type: 'toolCall', id: 'old', name: 'old' }],
            },
          },
          // Assistant without a content array: no actions, no crash.
          {
            type: 'message',
            seq: 5,
            timestamp: at(2),
            message: { role: 'assistant' },
          },
          {
            type: 'message',
            seq: 6,
            timestamp: at(3),
            message: {
              role: 'toolResult',
              toolCallId: 'c1',
              content: [
                { type: 'text', text: 'line one' },
                { type: 'image', data: 'x' },
                { type: 'text', text: 7 },
                { type: 'text', text: 'line two' },
              ],
            },
          },
          // A result whose call is not in this run, and one without an id.
          {
            type: 'message',
            seq: 7,
            timestamp: at(4),
            message: { role: 'toolResult', toolCallId: 'nope', content: [] },
          },
          {
            type: 'message',
            seq: 8,
            timestamp: at(5),
            message: { role: 'toolResult', content: 'x' },
          },
        ],
      }),
    );
    expect(exported.actions).toEqual([{ seq: 1, tool: 'unknown', args: null }]);
    expect(exported.observations).toEqual([
      {
        seq: 1,
        actionSeq: 1,
        output: 'line one\nline two',
        truncated: false,
        bytesOriginal: 17,
      },
    ]);
    // No usage on any message: nothing is counted.
    expect(exported.usage).toMatchObject({
      requests: 0,
      costUsd: 0,
      byModel: {},
    });
  });

  it('names an unknown provider/model and tolerates a usage row without cost', () => {
    const exported = assembleRunTrajectory(
      input({
        entries: [
          {
            type: 'message',
            seq: 1,
            timestamp: at(1),
            message: {
              role: 'assistant',
              content: [],
              usage: { input: 3, output: 2 },
            },
          },
          {
            // A user message with usage-shaped data is not a request.
            type: 'message',
            seq: 2,
            timestamp: at(2),
            message: {
              role: 'user',
              content: [],
              usage: { input: 99, output: 99 },
            },
          },
        ],
      }),
    );
    expect(exported.usage).toEqual({
      inputTokens: 3,
      outputTokens: 2,
      cachedTokens: 0,
      requests: 1,
      costUsd: 0,
      byModel: {
        'unknown/unknown': { requests: 1, input: 3, output: 2, costTotal: 0 },
      },
    });
  });

  it('diffs creates, deletes and omitted after-sides; the change boundary is inclusive', () => {
    const exported = assembleRunTrajectory(
      input({
        changes: [
          change({
            path: 'new.txt',
            before: null,
            after: 'hi\n',
            timestamp: STARTED,
          }),
          change({ path: 'gone.txt', before: 'bye\n', after: null }),
          change({ path: 'big.bin', afterOmitted: true, after: null }),
        ],
      }),
    );
    expect(exported.diff.filesChanged).toEqual([
      'new.txt',
      'gone.txt',
      'big.bin',
    ]);
    const [created, deleted, omitted] = exported.diff.files;
    expect(created?.hunks.join('\n')).toMatch(/\+hi/);
    expect(created?.hunks.join('\n')).not.toMatch(/Stryker/);
    expect(deleted?.hunks.join('\n')).toMatch(/-bye/);
    expect(omitted).toEqual({ path: 'big.bin', hunks: [] });
  });

  it('reads ledger verdicts: timeouts, an empty who, a record without an agent, the inclusive boundary', () => {
    const exported = assembleRunTrajectory(
      input({
        approvals: [
          ledger({ when: new Date(STARTED).toISOString() }),
          ledger({ result: 'deny', reason: 'approval timeout after 5s' }),
          ledger({ result: 'error', reason: 'timed out waiting' }),
          ledger({ result: 'deny', reason: 'refused', who: '' }),
          { ...ledger(), agent: undefined } as unknown as OrgAuditRecord,
        ],
      }),
    );
    expect(exported.approvals.map((a) => [a.verdict, a.by])).toEqual([
      ['approved', 'user'],
      ['timed-out', 'user'],
      ['timed-out', 'user'],
      ['denied', null],
    ]);
  });

  it('records the task id as a 16-hex prompt digest and the terminal state', () => {
    const exported = assembleRunTrajectory(input());
    expect(exported.task.taskId).toMatch(/^prompt:[0-9a-f]{16}$/);
    expect(exported.state).toEqual({ phase: 'completed', snapshot: null });
  });
});

describe('trajectoryResultFor (issue #383): §78 terminus → §46 status + §52 code', () => {
  it.each([
    [{ terminus: 'completed', summary: 'ok' }, 'completed', null],
    [
      {
        terminus: 'budget_exhausted',
        summary: 'turn budget exhausted after 3 turns',
      },
      'budget_exhausted',
      'budget_exhausted',
    ],
    [
      { terminus: 'budget_exhausted', summary: 'run timed out after 5ms' },
      'timeout',
      'budget_exhausted',
    ],
    [
      { terminus: 'approval_denied', summary: 'no' },
      'failed',
      'approval_denied',
    ],
    [
      { terminus: 'approval_timed_out', summary: 'late' },
      'failed',
      'approval_timed_out',
    ],
    [
      { terminus: 'workspace_unavailable', summary: 'ENOENT' },
      'failed',
      'workspace_failed',
    ],
    [
      { terminus: 'provider_probe_failed', summary: 'no model configured' },
      'failed',
      'provider_auth',
    ],
    [
      {
        terminus: 'failed',
        summary: 'run interrupted by SIGINT',
        interrupted: true,
      },
      'cancelled',
      'process_crashed',
    ],
    [
      { terminus: 'failed', summary: 'extension startup failed closed' },
      'failed',
      'process_crashed',
    ],
  ] as const)('%o → %s/%s', (outcome, status, code) => {
    const result = trajectoryResultFor(outcome);
    expect(result.status).toBe(status);
    expect(result.failureCategory).toBe(code);
    expect(result.summary).toBe(outcome.summary);
    if (status === 'completed') expect(result.error).toBeNull();
    else
      expect(result.error).toEqual({
        kind: outcome.terminus,
        message: outcome.summary,
      });
  });

  it('classifies a lane failure through the §52 taxonomy', () => {
    const result = trajectoryResultFor({
      terminus: 'failed',
      summary: 'tool_error: bash failed',
      lane: {
        status: 'failed',
        error: { code: 'model_error', message: 'upstream 500' },
      },
    });
    expect(result.status).toBe('failed');
    expect(result.failureCategory).toBe('model_failed');
  });

  it('a lane failure without an error record is a process failure', () => {
    const result = trajectoryResultFor({
      terminus: 'failed',
      summary: 'lane failed without detail',
      lane: { status: 'failed' },
    });
    expect(result).toMatchObject({
      status: 'failed',
      failureCategory: 'process_crashed',
    });
  });

  it('marks an aborted or declined lane operation cancelled', () => {
    const result = trajectoryResultFor({
      terminus: 'failed',
      summary: 'lane aborted without detail',
      lane: { status: 'aborted' },
    });
    expect(result.status).toBe('cancelled');
    expect(result.failureCategory).toBe('process_crashed');
  });

  it('a failed trajectory never lacks its failure category (fail-closed export)', () => {
    const exported = assembleRunTrajectory(
      input({
        outcome: { terminus: 'failed', summary: 'lane failed without detail' },
      }),
    );
    expect(exported.result.status).toBe('failed');
    expect(exported.result.failureCategory).not.toBeNull();
  });
});
