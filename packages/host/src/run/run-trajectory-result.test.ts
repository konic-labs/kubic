// Run → trajectory assembly. Pure: session entries, journal
// changes, ledger records and the settled outcome in; a TrajectoryExport
// that parseTrajectoryExport accepts out. Entry shapes are the ones the
// real lane stores (assistant toolCall parts, toolResult messages,
// per-request usage on assistant messages).

import { readConversationEntries } from '@kubic/agent/lane/transcript';
import {
  BACKGROUND_CONTEXT,
  createModels,
  createRegistry,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  Harness,
  MemoryStorage,
} from '@kubic/agent/pi-boundary';
import type { FileChange } from '@kubic/exec/journal';
import { parseTrajectoryExport } from '@kubic/trajectory/schema';
import { describe, expect, it } from 'vitest';
import type { OrgAuditRecord } from '../audit/index.js';
import { ENTRIES, STARTED } from '../test-support/run-entries.js';
import {
  assembleRunTrajectory,
  type RunTrajectoryInput,
  trajectoryResultFor,
} from './run-trajectory.js';

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
    agent: { session: 'sess-1', role: 'default' },
    model: { provider: 'faux', id: 'echo', thinking: 'off' },
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
    role: 'default',
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
