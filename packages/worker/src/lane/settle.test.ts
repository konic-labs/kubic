// Slice C: settlement mapping + abort with kill tree (issue #11).
import { describe, expect, it } from 'vitest';
import { BACKGROUND_CONTEXT } from '../pi-boundary.js';
import { OperationKillRegistry, requestLaneAbort } from './abort.js';
import { classifyHarnessError, settleTerminalStatus } from './settle.js';

describe('settlement mapping (issue #11, slice C)', () => {
  it('maps completed to a completed result without error', () => {
    expect(settleTerminalStatus('completed')).toEqual({ status: 'completed' });
  });

  it('maps failed with a classified error', () => {
    const settled = settleTerminalStatus('failed', {
      code: 'context_overflow',
      message: 'too many tokens',
    });
    expect(settled.status).toBe('failed');
    expect(settled.error?.kind).toBe('context');
  });

  it('maps aborted and declined to cancelled', () => {
    expect(settleTerminalStatus('aborted')).toEqual({ status: 'cancelled' });
    expect(settleTerminalStatus('declined').status).toBe('cancelled');
  });

  it('classifies harness error codes by keyword', () => {
    expect(classifyHarnessError('budget_exhausted', 'no money').kind).toBe(
      'budget',
    );
    expect(classifyHarnessError('model_unavailable', 'gone').kind).toBe(
      'model',
    );
    expect(classifyHarnessError('provider_auth', 'denied').kind).toBe(
      'provider',
    );
    expect(classifyHarnessError('tool_crashed', 'x').kind).toBe('tool');
  });

  it('falls back to process for unrecognized harness errors', () => {
    const error = classifyHarnessError(
      'structural_interrupted',
      'unknown outcome',
    );
    expect(error.kind).toBe('process');
    expect(error.message).toContain('structural_interrupted');
  });
});

describe('lane abort (issue #11, slice C)', () => {
  function stubLane(newlyRequested: boolean) {
    return {
      requestAbort: async (operationId: string) => ({
        ok: true as const,
        value: { operationId, newlyRequested, steer: [], followUp: [] },
      }),
    };
  }

  it('requests abort and drains tracked kills', async () => {
    const kills = new OperationKillRegistry();
    let killed = 0;
    kills.track('op-1', () => {
      killed += 1;
    });
    const result = await requestLaneAbort(
      stubLane(true),
      kills,
      'op-1',
      BACKGROUND_CONTEXT,
    );
    expect(result.newlyRequested).toBe(true);
    expect(result.killed).toBe(1);
    expect(killed).toBe(1);
  });

  it('attempts every kill even when one throws', async () => {
    const kills = new OperationKillRegistry();
    const attempted: string[] = [];
    kills.track('op-1', () => {
      attempted.push('first');
      throw new Error('already gone');
    });
    kills.track('op-1', () => {
      attempted.push('second');
    });
    await expect(
      requestLaneAbort(stubLane(false), kills, 'op-1', BACKGROUND_CONTEXT),
    ).rejects.toThrow(/lane abort kills failed/i);
    expect(attempted).toEqual(['first', 'second']);
  });

  it('throws when the harness rejects the abort', async () => {
    const lane = {
      requestAbort: async (_operationId: string) => ({
        ok: false as const,
        error: { _tag: 'Closed', message: 'shut' },
      }),
    };
    await expect(
      requestLaneAbort(
        lane,
        new OperationKillRegistry(),
        'op-1',
        BACKGROUND_CONTEXT,
      ),
    ).rejects.toThrow(/lane abort failed/i);
  });
});
