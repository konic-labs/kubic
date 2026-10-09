// Every way a run stops, mapped to its terminus and exit code: one row per
// stop kind (and per branch inside a kind).
import { mapTerminusToExitCode } from '@kubic/host/run';
import { describe, expect, it } from 'vitest';
import { type RunStop, retryRecord, runResult } from './outcome.js';
import { NO_ASSISTANT_TEXT_SUMMARY } from './output.js';

interface Row {
  name: string;
  stop: RunStop;
  sessionId?: string;
  terminus: string;
  exitCode: number;
  summary: string;
  error?: string;
  signal?: string;
  failureCode?: string;
}

const retry = retryRecord(
  { decision: 'retry_with_new_context', reason: 'context overflow' },
  true,
);

const rows: Row[] = [
  {
    name: 'an invalid request, before any session',
    stop: { kind: 'usage', message: 'invalid maxTurns 0' },
    terminus: 'usage',
    exitCode: 2,
    summary: 'invalid maxTurns 0',
    error: 'invalid maxTurns 0',
  },
  {
    name: 'a caught workspace error',
    stop: { kind: 'caught', error: new Error('ENOENT: no such file') },
    sessionId: 's1',
    terminus: 'workspace_unavailable',
    exitCode: 5,
    summary: 'ENOENT: no such file',
    error: 'ENOENT: no such file',
    failureCode: 'workspace_failed',
  },
  {
    name: 'any other caught error',
    stop: { kind: 'caught', error: new Error('boom') },
    sessionId: 's1',
    terminus: 'failed',
    exitCode: 1,
    summary: 'boom',
    error: 'boom',
  },
  {
    name: 'a boot with no usable model',
    stop: {
      kind: 'refused',
      refusal: { kind: 'provider', message: 'no model available' },
    },
    sessionId: 's1',
    terminus: 'provider_probe_failed',
    exitCode: 6,
    summary: 'no model available',
    error: 'no model available',
  },
  {
    name: 'a boot that failed (an unknown role)',
    stop: {
      kind: 'refused',
      refusal: { kind: 'failed', message: "no role document for 'x'" },
    },
    sessionId: 's1',
    terminus: 'failed',
    exitCode: 1,
    summary: "no role document for 'x'",
    error: "no role document for 'x'",
  },
  {
    name: 'a boot whose store failed',
    stop: {
      kind: 'refused',
      refusal: { kind: 'store', error: new Error('disk full') },
    },
    sessionId: 's1',
    terminus: 'failed',
    exitCode: 1,
    summary: 'Error: disk full',
    error: 'Error: disk full',
  },
  {
    name: 'a boot cancelled with no signal behind it',
    stop: { kind: 'refused', refusal: { kind: 'cancelled' } },
    sessionId: 's1',
    terminus: 'cancelled',
    exitCode: 130,
    summary: 'cancelled',
  },
  {
    name: 'an interrupt',
    stop: { kind: 'interrupted', signal: 'SIGTERM' },
    sessionId: 's1',
    terminus: 'cancelled',
    exitCode: 143,
    summary: 'run interrupted by SIGTERM',
    error: 'run interrupted by SIGTERM',
    signal: 'SIGTERM',
  },
  {
    name: 'the wall clock',
    stop: { kind: 'timeout', ms: 5000 },
    sessionId: 's1',
    terminus: 'timeout',
    exitCode: 1,
    summary: 'run timed out after 5000ms',
    error: 'run timed out after 5000ms',
  },
  {
    name: 'the turn bound',
    stop: { kind: 'turn-limit', turns: 3 },
    sessionId: 's1',
    terminus: 'turn_limit',
    exitCode: 3,
    summary: 'turn limit reached after 3 turns',
    error: 'turn limit reached after 3 turns',
  },
  {
    name: 'a user abort of the lane',
    stop: { kind: 'aborted', reason: 'user' },
    sessionId: 's1',
    terminus: 'failed',
    exitCode: 1,
    summary: 'lane aborted before it settled',
    error: 'lane aborted before it settled',
  },
  {
    name: 'a guard abort with no recorded guard stop',
    stop: { kind: 'aborted', reason: 'guard' },
    sessionId: 's1',
    terminus: 'turn_limit',
    exitCode: 3,
    summary: 'run guard exhausted',
    error: 'run guard exhausted',
  },
  {
    name: 'a refused approval',
    stop: {
      kind: 'denied',
      denials: [
        { capability: 'shell', toolName: 'bash', reason: 'denied by user' },
        { capability: 'write', toolName: 'write', reason: 'second' },
      ],
    },
    sessionId: 's1',
    terminus: 'approval_denied',
    exitCode: 4,
    summary: 'approval refused: shell (bash), write (write) — denied by user',
    error: 'approval refused: shell (bash), write (write) — denied by user',
  },
  {
    name: 'an approval nobody answered in time',
    stop: {
      kind: 'denied',
      denials: [
        {
          capability: 'shell',
          toolName: 'bash',
          reason: 'approval timed out after 1000ms',
        },
      ],
    },
    sessionId: 's1',
    terminus: 'approval_timed_out',
    exitCode: 4,
    summary: 'approval refused: shell (bash) — approval timed out after 1000ms',
    error: 'approval refused: shell (bash) — approval timed out after 1000ms',
  },
  {
    name: 'a completed turn',
    stop: { kind: 'completed', summary: 'done' },
    sessionId: 's1',
    terminus: 'completed',
    exitCode: 0,
    summary: 'done',
  },
  {
    name: 'a completed turn with no assistant text',
    stop: { kind: 'completed', summary: undefined },
    sessionId: 's1',
    terminus: 'completed',
    exitCode: 0,
    summary: NO_ASSISTANT_TEXT_SUMMARY,
  },
  {
    name: 'a failed tool turn',
    stop: {
      kind: 'failed',
      outcome: { kind: 'failed', reason: 'tool_failed', error: 'exit 1' },
    },
    sessionId: 's1',
    terminus: 'failed',
    exitCode: 1,
    summary: 'tool_failed: exit 1',
    error: 'exit 1',
    failureCode: 'tool_failed',
  },
  {
    name: 'a failed turn with no error text',
    stop: { kind: 'failed', outcome: { kind: 'failed', reason: 'busy' } },
    sessionId: 's1',
    terminus: 'failed',
    exitCode: 1,
    summary: 'busy: busy',
    error: 'busy',
  },
  {
    name: 'a provider that refused the credentials mid-run',
    stop: {
      kind: 'failed',
      outcome: {
        kind: 'failed',
        reason: 'provider_auth',
        error: '401 unauthorized',
      },
    },
    sessionId: 's1',
    terminus: 'provider_auth',
    exitCode: 1,
    summary: 'provider_auth: 401 unauthorized',
    error: '401 unauthorized',
    failureCode: 'provider_auth',
  },
];

describe('runResult', () => {
  it.each(rows)('maps $name', (row) => {
    const result = runResult(row.stop, row.sessionId);
    expect(result.terminus).toBe(row.terminus);
    expect(mapTerminusToExitCode(result.terminus, result.signal)).toBe(
      row.exitCode,
    );
    expect(result.summary).toBe(row.summary);
    expect(result.error).toEqual(
      row.error === undefined
        ? undefined
        : { kind: row.terminus, message: row.error },
    );
    expect(result.signal).toBe(row.signal);
    if (row.failureCode !== undefined) {
      expect(result.failure?.code).toBe(row.failureCode);
    }
  });

  it('names the session in every ref, or `unassigned` without one', () => {
    expect(runResult({ kind: 'timeout', ms: 1 }, 'abc')).toMatchObject({
      sessionId: 'abc',
      journalRef: 'journal:abc',
      usageRef: 'usage:abc',
      trajectoryRef: 'trajectory:abc',
    });
    expect(runResult({ kind: 'usage', message: 'x' })).toMatchObject({
      sessionId: 'unassigned',
      journalRef: 'journal:unassigned',
    });
    expect(runResult({ kind: 'caught', error: new Error('x') })).toMatchObject({
      sessionId: 'unassigned',
    });
  });

  it('carries the overflow retry record on a settled turn, never on a denial', () => {
    expect(
      runResult({ kind: 'completed', summary: 'ok', retry }, 's1').retry,
    ).toEqual(retry);
    expect(
      runResult(
        {
          kind: 'failed',
          outcome: { kind: 'failed', reason: 'model_failed' },
          retry,
        },
        's1',
      ).retry,
    ).toEqual(retry);
    expect(
      runResult({ kind: 'completed', summary: 'ok' }, 's1').retry,
    ).toBeUndefined();
  });
});
