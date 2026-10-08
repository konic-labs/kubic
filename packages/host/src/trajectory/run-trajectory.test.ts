// Run → trajectory assembly. Pure: session entries, journal
// changes, ledger records and the settled outcome in; a TrajectoryExport
// that parseTrajectoryExport accepts out. Entry shapes are the ones the
// real solo lane stores (assistant toolCall parts, toolResult messages,
// per-request usage on assistant messages).
import { describe, expect, it } from 'vitest';
import { toolSpawnEnv } from '../../../exec/src/env.js';
import type { FileChange } from '../../../exec/src/journal-diff.js';
import { parseTrajectoryExport } from '../../../trajectory/src/schema.js';
import { readConversationEntries } from '../../../worker/src/lane/transcript.js';
import {
  BACKGROUND_CONTEXT,
  createModels,
  createRegistry,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  Harness,
  MemoryStorage,
} from '../../../worker/src/pi-boundary.js';
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

// The durable entry chain of one faux run with a single `read` call
// (pi-durable `EntryRecord`s: typed kinds, `model` payloads), plus one entry
// from an earlier run. Entries carry no timestamp of their own — the
// messages do — and the array is deliberately out of id order: entry ids are
// assigned in commit order, so the adapter restores transcript order.
function assistantEntry(
  id: number,
  timestamp: number,
  content: unknown[],
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    conversationId: 1,
    kind: 'pi.assistant',
    model: [
      {
        role: 'assistant',
        content,
        api: 'faux',
        provider: 'faux',
        model: 'echo',
        usage: usage(20, 7, 0.001),
        stopReason: 'stop',
        timestamp,
        ...overrides,
      },
    ],
  };
}

const ENTRIES: unknown[] = [
  assistantEntry(40, STARTED + 30, [
    { type: 'text', text: 'faux: read returned 6 chars' },
  ]),
  {
    id: 29,
    conversationId: 1,
    kind: 'pi.tool-result',
    data: { diagnostics: [] },
    model: [
      {
        role: 'toolResult',
        toolCallId: 'call-1',
        toolName: 'read',
        content: [{ type: 'text', text: 'hello\n' }],
        isError: false,
        timestamp: STARTED + 20,
      },
    ],
  },
  assistantEntry(
    19,
    STARTED + 10,
    [
      {
        type: 'toolCall',
        id: 'call-1',
        name: 'read',
        arguments: { path: 'a.txt' },
      },
    ],
    { usage: usage(100, 6, 0.002) },
  ),
  {
    id: 6,
    conversationId: 1,
    kind: 'pi.user',
    model: [
      {
        role: 'user',
        content: [{ type: 'text', text: 'read a.txt' }],
        timestamp: STARTED + 1,
      },
    ],
  },
  // An earlier run of a resumed session: never part of this trajectory.
  assistantEntry(
    2,
    STARTED - 60_000,
    [{ type: 'toolCall', id: 'old', name: 'bash', arguments: { cmd: 'x' } }],
    { usage: usage(999, 999, 9) },
  ),
];

let nextEntryId = 100;
function entryId(): number {
  nextEntryId += 1;
  return nextEntryId;
}

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
    worker: { pid: 1, role: 'solo' },
    workspace: { path: '/ws', base: 'abc' },
    permission: { permission: 'shell', approval: 'ask' },
    credential: { sentinel: '' },
    network: { host: '', port: 0, decision: 'allow', bytes: 0 },
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
    role: 'solo',
    prompt: 'read a.txt',
    entries: ENTRIES,
    model: { provider: 'faux', id: 'echo', thinking: null },
    pid: 4242,
    cwd: '/ws',
    baseRevision: 'abc123',
    branch: 'main',
    env: { PATH: '/usr/bin' },
    changes: [change()],
    approvals: [ledger()],
    skills: ['review'],
    startedAt: STARTED,
    endedAt: STARTED + 100,
    outcome: { terminus: 'completed', summary: 'faux: read returned 6 chars' },
    ...overrides,
  };
}

describe('assembleRunTrajectory', () => {
  it('builds a export that parseTrajectoryExport accepts', () => {
    const exported = assembleRunTrajectory(input());
    expect(() =>
      parseTrajectoryExport(JSON.parse(JSON.stringify(exported))),
    ).not.toThrow();
    expect(exported.schema_version).toBe('1.0');
  });

  it('carries the lane escalation record into model.escalations', () => {
    const exported = assembleRunTrajectory(
      input({
        escalations: [
          {
            reason: '3 consecutive tool failures',
            at: new Date(STARTED + 50).toISOString(),
            fromModel: 'faux/echo',
            toModel: 'faux/big',
            thinking: null,
          },
        ],
      }),
    );
    expect(exported.model.escalations).toHaveLength(1);
    expect(exported.model.escalations[0]).toEqual({
      reason: '3 consecutive tool failures',
      at: new Date(STARTED + 50).toISOString(),
      fromModel: 'faux/echo',
      toModel: 'faux/big',
      thinking: null,
    });
    expect(() =>
      parseTrajectoryExport(JSON.parse(JSON.stringify(exported))),
    ).not.toThrow();
  });

  it('records the run provenance: session, agent, pid, worktree, model', () => {
    const exported = assembleRunTrajectory(input({ pid: 7 }));
    expect(exported.provenance).toEqual({
      sessionId: 'sess-1',
      agentId: 'root',
      pid: 7,
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
    expect(a.resources).toEqual({ skills: ['review'] });
    expect(a.prompt).toEqual({ text: 'read a.txt' });
  });

  it('keeps the run timestamps', () => {
    expect(assembleRunTrajectory(input()).timestamps).toEqual({
      startedAt: '2026-09-28T10:00:00.000Z',
      endedAt: '2026-09-28T10:00:00.100Z',
      durationMs: 100,
    });
  });
});

describe('assembleRunTrajectory reads real entries defensively', () => {
  const at = (offset: number) => STARTED + offset;

  it('skips foreign or malformed entries and keeps the run-start boundary inclusive', () => {
    const exported = assembleRunTrajectory(
      input({
        entries: [
          null,
          'not an entry',
          ['an', 'array'],
          // Not a durable entry record: no numeric id.
          { kind: 'pi.assistant', model: [] },
          // A compaction entry with no messages: nothing to show.
          { id: entryId(), conversationId: 1, kind: 'pi.compaction' },
          // A model payload that is not an array, and one with no numeric
          // timestamp: neither can be placed in the run.
          {
            id: entryId(),
            conversationId: 1,
            kind: 'pi.assistant',
            model: 'x',
          },
          {
            id: entryId(),
            conversationId: 1,
            kind: 'pi.user',
            model: [{ role: 'user', content: [], timestamp: 'y' }],
          },
          // Exactly at the run start: part of this run. A tool call with a
          // non-string name and no arguments, plus parts that are not calls.
          {
            id: entryId(),
            conversationId: 1,
            kind: 'pi.assistant',
            model: [
              {
                role: 'assistant',
                content: [
                  {
                    type: 'toolCall',
                    id: 'c1',
                    name: 42,
                    arguments: undefined,
                  },
                  'not a part',
                  { type: 'text', text: 'thinking' },
                ],
                timestamp: STARTED,
              },
            ],
          },
          // Assistant without a content array: no actions, no crash.
          {
            id: entryId(),
            conversationId: 1,
            kind: 'pi.assistant',
            model: [
              {
                role: 'assistant',
                timestamp: at(2),
                provider: 'faux',
                model: 'echo',
              },
            ],
          },
          {
            id: entryId(),
            conversationId: 1,
            kind: 'pi.tool-result',
            data: { diagnostics: [] },
            model: [
              {
                role: 'toolResult',
                toolCallId: 'c1',
                toolName: 'read',
                content: [
                  { type: 'text', text: 'line one' },
                  { type: 'image', data: 'x' },
                  { type: 'text', text: 7 },
                  { type: 'text', text: 'line two' },
                ],
                isError: false,
                timestamp: at(3),
              },
            ],
          },
          // A result whose call is not in this run, and one without an id.
          {
            id: entryId(),
            conversationId: 1,
            kind: 'pi.tool-result',
            model: [
              {
                role: 'toolResult',
                toolCallId: 'nope',
                toolName: 'read',
                content: [],
                isError: false,
                timestamp: at(4),
              },
            ],
          },
          {
            id: entryId(),
            conversationId: 1,
            kind: 'pi.tool-result',
            model: [
              {
                role: 'toolResult',
                toolName: 'read',
                content: [{ type: 'text', text: 'x' }],
                isError: false,
                timestamp: at(5),
              },
            ],
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
            id: entryId(),
            conversationId: 1,
            kind: 'pi.assistant',
            model: [
              {
                role: 'assistant',
                content: [],
                usage: { input: 3, output: 2 },
                timestamp: at(1),
              },
            ],
          },
          {
            // A user message with usage-shaped data is not a request.
            id: entryId(),
            conversationId: 1,
            kind: 'pi.user',
            model: [
              {
                role: 'user',
                content: [],
                usage: { input: 99, output: 99 },
                timestamp: at(2),
              },
            ],
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

  it('records the thinking level the responses ran at when the caller named none', () => {
    const exported = assembleRunTrajectory(
      input({
        model: { provider: 'faux', id: 'echo', thinking: null },
        entries: [
          assistantEntry(1, at(1), [{ type: 'text', text: 'first' }], {
            thinkingLevel: 'low',
          }),
          assistantEntry(2, at(2), [{ type: 'text', text: 'second' }], {
            thinkingLevel: 'high',
          }),
        ],
      }),
    );
    // The newest response names the level the run ended at.
    expect(exported.model.thinking).toBe('high');
  });

  it('keeps the caller-named thinking level over the responses', () => {
    const exported = assembleRunTrajectory(
      input({
        model: { provider: 'faux', id: 'echo', thinking: 'medium' },
        entries: [
          assistantEntry(1, at(1), [{ type: 'text', text: 'first' }], {
            thinkingLevel: 'high',
          }),
        ],
      }),
    );
    expect(exported.model.thinking).toBe('medium');
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
    expect(exported.state).toEqual({ phase: 'completed' });
  });
});

describe('trajectoryResultFor: terminus → status + failure code', () => {
  it.each([
    [{ terminus: 'completed', summary: 'ok' }, 'completed', null],
    [
      {
        terminus: 'turn_limit',
        summary: 'turn limit reached after 3 turns',
      },
      'turn_limit',
      'run_limit',
    ],
    [
      { terminus: 'timeout', summary: 'run timed out after 5ms' },
      'timeout',
      'run_limit',
    ],
    [
      { terminus: 'cancelled', summary: 'run interrupted by SIGINT' },
      'cancelled',
      'process_crashed',
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
        terminus: 'provider_transient',
        summary: 'provider capacity exhausted',
      },
      'failed',
      'provider_transient',
    ],
    [
      { terminus: 'provider_auth', summary: 'invalid api key' },
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
      { terminus: 'failed', summary: 'skill load failed' },
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

  it('classifies a lane failure through the taxonomy', () => {
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

describe('assembleRunTrajectory over a real harness', () => {
  it('builds a schema-valid v1 trajectory from the entries a faux harness stored', async () => {
    // A real pi-durable Harness over MemoryStorage with the faux provider:
    // the entries the adapter reads are the ones the harness actually
    // writes (user turn, assistant tool call, its result, the answer).
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const harness = await Harness.open(
      new MemoryStorage(),
      { models, registry: createRegistry() },
      BACKGROUND_CONTEXT,
    );
    try {
      const root = await harness.root(BACKGROUND_CONTEXT, {
        agent: { model: { provider: 'faux', modelId: 'faux-1' } },
      });
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall('read', { path: 'a.txt' })], {
          stopReason: 'toolUse',
        }),
        fauxAssistantMessage('read returned 6 chars'),
      ]);
      const startedAt = Date.now() - 60_000;
      await (
        await root.submit(
          { type: 'input', content: 'read a.txt' },
          BACKGROUND_CONTEXT,
        )
      ).wait(BACKGROUND_CONTEXT);
      const entries = await readConversationEntries(root, BACKGROUND_CONTEXT);
      const exported = assembleRunTrajectory(
        input({
          entries,
          startedAt,
          endedAt: Date.now(),
          prompt: 'read a.txt',
          outcome: {
            terminus: 'completed',
            summary: 'read returned 6 chars',
          },
        }),
      );
      expect(() =>
        parseTrajectoryExport(JSON.parse(JSON.stringify(exported))),
      ).not.toThrow();
      expect(exported.actions).toEqual([
        { seq: 1, tool: 'read', args: { path: 'a.txt' } },
      ]);
      expect(exported.observations).toHaveLength(1);
      expect(exported.observations[0]?.actionSeq).toBe(1);
      expect(exported.usage.requests).toBe(2);
      expect(exported.usage.byModel['faux/faux-1']?.requests).toBe(2);
      expect(exported.provenance.model).toBe('faux/echo');
    } finally {
      await harness.close(BACKGROUND_CONTEXT);
    }
  });
});
