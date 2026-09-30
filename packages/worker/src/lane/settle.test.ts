// Slice C: settlement mapping + abort with kill tree (issue #11).
import { describe, expect, it } from 'vitest';
import { BACKGROUND_CONTEXT } from '../pi-boundary.js';
import {
  drainOperation,
  type LaneAborter,
  OperationKillRegistry,
  requestLaneAbort,
} from './abort.js';
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

// Issue #312: drainOperation is the best-effort backstop shared with the TUI
// quit path. Every "requestAbort refused" branch reports a distinct, exact
// message and the kills still run — pinned per branch so a mutated report
// string or a skipped drain cannot pass.
describe('drainOperation (issue #312)', () => {
  function lane(requestAbort: LaneAborter['requestAbort']): LaneAborter {
    return { requestAbort };
  }

  function trackedKills(): { kills: OperationKillRegistry; log: string[] } {
    const kills = new OperationKillRegistry();
    const log: string[] = [];
    kills.track('op-1', () => {
      log.push('first');
      throw new Error('already gone');
    });
    kills.track('op-1', () => {
      log.push('second');
    });
    return { kills, log };
  }

  async function drain(aborter: LaneAborter): Promise<{
    reports: string[];
    log: string[];
    kills: OperationKillRegistry;
  }> {
    const { kills, log } = trackedKills();
    const reports: string[] = [];
    await drainOperation(aborter, kills, 'op-1', BACKGROUND_CONTEXT, (m) =>
      reports.push(m),
    );
    return { reports, log, kills };
  }

  it('reports nothing and drains every kill when the abort is accepted', async () => {
    const { reports, log, kills } = await drain(
      lane(async (operationId) => ({
        ok: true as const,
        value: { operationId, newlyRequested: true },
      })),
    );
    expect(reports).toEqual([]);
    // A throwing kill never stops the next; the registry is emptied.
    expect(log).toEqual(['first', 'second']);
    expect(kills.drain('op-1')).toEqual([]);
  });

  it('reports a refusal carrying an Error by its message, then still kills', async () => {
    const { reports, log } = await drain(
      lane(async () => ({
        ok: false as const,
        error: new Error('harness closed'),
      })),
    );
    expect(reports).toEqual(['requestAbort refused: harness closed']);
    expect(log).toEqual(['first', 'second']);
  });

  it('reports a refusal carrying a plain object as its JSON, then still kills', async () => {
    const { reports, log } = await drain(
      lane(async () => ({
        ok: false as const,
        error: { _tag: 'Closed', message: 'shut' },
      })),
    );
    expect(reports).toEqual([
      'requestAbort refused: {"_tag":"Closed","message":"shut"}',
    ]);
    expect(log).toEqual(['first', 'second']);
  });

  it('reports a throwing requestAbort (Error) by its message, then still kills', async () => {
    const { reports, log } = await drain(
      lane(async () => {
        throw new Error('rpc down');
      }),
    );
    expect(reports).toEqual(['requestAbort refused: rpc down']);
    expect(log).toEqual(['first', 'second']);
  });

  it('reports a throwing requestAbort (non-Error) as its string form, then still kills', async () => {
    const { reports, log } = await drain(
      lane(async () => {
        throw 'plain string failure';
      }),
    );
    expect(reports).toEqual(['requestAbort refused: plain string failure']);
    expect(log).toEqual(['first', 'second']);
  });

  it('never throws and still kills when no report sink is given', async () => {
    const { kills, log } = trackedKills();
    await expect(
      drainOperation(
        lane(async () => ({ ok: false as const, error: new Error('x') })),
        kills,
        'op-1',
        BACKGROUND_CONTEXT,
      ),
    ).resolves.toBeUndefined();
    await expect(
      drainOperation(
        lane(async () => {
          throw new Error('y');
        }),
        kills,
        'op-1',
        BACKGROUND_CONTEXT,
      ),
    ).resolves.toBeUndefined();
    // The first drain emptied the registry, so only it ran the kills.
    expect(log).toEqual(['first', 'second']);
  });
});
