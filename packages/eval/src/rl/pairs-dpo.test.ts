// Preference-pair + DPO policy tests (issue #54, RED first).
// Env failures (tool_failed/workspace_failed) never train capability
// preference; cross-boundary runs never form a trainable pair — both
// surface as tagged exclusions instead.
import { describe, expect, it } from 'vitest';
import { buildDpoRecord, validateDpoRecord } from './dpo.js';
import { makeExport } from './fixtures.js';
import { buildPreferencePair, validatePreferencePair } from './preference.js';

function passing(overrides = {}) {
  return makeExport({
    evalLabels: { 'signal:tests': 'pass' },
    summary: 'fixed cleanly',
    ...overrides,
  });
}

function failing(overrides = {}) {
  return makeExport({
    status: 'failed',
    failureCategory: 'model_failed',
    summary: 'broken attempt',
    ...overrides,
  });
}

describe('pairs answer one prompt and one task (issue #269)', () => {
  it('different prompts return pair:null tagged prompt-mismatch-excluded', () => {
    const built = buildPreferencePair(
      passing({ promptText: 'task A' }),
      failing({ promptText: 'task B' }),
    );
    expect(built.pair).toBeNull();
    expect(built.excluded?.tag).toBe('prompt-mismatch-excluded');
    expect(built.excluded?.reason).toMatch(/different prompt/);
    expect(built.excluded?.prompt).toBe('task A');
  });

  it('the same prompt text under different task ids is excluded too', () => {
    const built = buildPreferencePair(
      passing({ taskId: 'task-a' }),
      failing({ taskId: 'task-b' }),
    );
    expect(built.pair).toBeNull();
    expect(built.excluded?.tag).toBe('prompt-mismatch-excluded');
    expect(built.excluded?.reason).toMatch(/task-a.*task-b/);
  });

  it('checks the prompt before the env-failure policy', () => {
    const built = buildPreferencePair(
      passing({ promptText: 'task A' }),
      failing({ promptText: 'task B', failureCategory: 'tool_failed' }),
    );
    expect(built.excluded?.tag).toBe('prompt-mismatch-excluded');
  });

  it('buildDpoRecord over mismatched prompts yields no record', () => {
    const built = buildDpoRecord(
      passing({ promptText: 'task A' }),
      failing({ promptText: 'task B' }),
    );
    expect(built.record).toBeNull();
    expect(built.excluded?.tag).toBe('prompt-mismatch-excluded');
  });

  it('carries the real task refs on the pair and the DPO record', () => {
    const pair = buildPreferencePair(passing({}), failing({})).pair;
    expect(pair?.chosen.taskRef).toBe('task-1');
    expect(pair?.rejected.taskRef).toBe('task-1');
    const record = buildDpoRecord(passing({}), failing({})).record;
    expect(record?.taskRef).toEqual({ chosen: 'task-1', rejected: 'task-1' });
    expect(validateDpoRecord(record).valid).toBe(true);
  });

  it('rejects a hand-crafted pair whose sides answer different tasks', () => {
    const built = buildPreferencePair(passing({}), failing({}));
    const crafted = {
      ...built.pair,
      rejected: { ...built.pair?.rejected, taskRef: 'task-other' },
    };
    const checked = validatePreferencePair(crafted);
    expect(checked.valid).toBe(false);
    if (!checked.valid) {
      expect(checked.errors).toContain(
        'chosen and rejected answer different tasks (task-1 vs task-other)',
      );
    }
  });

  it('rejects a hand-crafted DPO record with mismatched task refs', () => {
    const built = buildDpoRecord(passing({}), failing({}));
    const crafted = {
      ...built.record,
      taskRef: { chosen: 'task-1', rejected: 'task-other' },
    };
    const checked = validateDpoRecord(crafted);
    expect(checked.valid).toBe(false);
    if (!checked.valid) {
      expect(checked.errors).toContain(
        'chosen and rejected answer different tasks (task-1 vs task-other)',
      );
    }
  });

  it('rejects a DPO record without task refs', () => {
    const built = buildDpoRecord(passing({}), failing({}));
    const { taskRef: _taskRef, ...stripped } = built.record ?? {};
    for (const record of [stripped, { ...stripped, taskRef: null }]) {
      const checked = validateDpoRecord(record);
      expect(checked.valid).toBe(false);
      if (!checked.valid) {
        expect(checked.errors).toContain(
          'taskRef is required: carry both task refs (§74)',
        );
      }
    }
  });

  it('excludes (never throws) when the rejected side has no prompt', () => {
    const rejected = failing({});
    (rejected as { prompt?: unknown }).prompt = undefined;
    const built = buildPreferencePair(passing({}), rejected);
    expect(built.pair).toBeNull();
    expect(built.excluded?.tag).toBe('prompt-mismatch-excluded');
  });
});

describe('buildPreferencePair (issue #54)', () => {
  it('builds a within-boundary pair from pass-vs-capability-fail', () => {
    const built = buildPreferencePair(passing({}), failing({}));
    expect(built.pair).not.toBeNull();
    expect(built.excluded).toBeNull();
    expect(built.pair?.boundary).toBe('within');
    expect(validatePreferencePair(built.pair).valid).toBe(true);
  });

  it('emits no pair for a tool_failed run vs a capability run (tagged)', () => {
    const envFail = makeExport({
      status: 'failed',
      failureCategory: 'tool_failed',
      summary: 'tool exploded',
    });
    const built = buildPreferencePair(passing({}), envFail);
    expect(built.pair).toBeNull();
    expect(built.excluded?.tag).toBe('env-failure-excluded');
  });

  it('emits no pair for a workspace_failed run vs a success (tagged)', () => {
    const envFail = makeExport({
      status: 'failed',
      failureCategory: 'workspace_failed',
      summary: 'workspace broke',
    });
    const built = buildPreferencePair(passing({}), envFail);
    expect(built.pair).toBeNull();
    expect(built.excluded?.tag).toBe('env-failure-excluded');
  });

  it('emits no pair across worktrees (tagged cross-boundary)', () => {
    const built = buildPreferencePair(
      passing({ worktree: '/wt/agent-1' }),
      failing({ worktree: '/wt/agent-2' }),
    );
    expect(built.pair).toBeNull();
    expect(built.excluded?.tag).toBe('cross-boundary-excluded');
  });

  it('emits no pair across capability grants (tagged cross-boundary)', () => {
    const other = failing({});
    other.transfer = {
      taskId: 'task-1',
      worktree: '/wt/agent-1',
      grantRef: 'worktree:write',
    };
    const built = buildPreferencePair(passing({}), other);
    expect(built.pair).toBeNull();
    expect(built.excluded?.tag).toBe('cross-boundary-excluded');
  });

  it('emits no pair without a verifier preference signal (tagged)', () => {
    const built = buildPreferencePair(failing({}), failing({}));
    expect(built.pair).toBeNull();
    expect(built.excluded?.tag).toBe('no-preference-signal-excluded');
  });

  it('rejects a hand-crafted env-failure pair at validation', () => {
    const built = buildPreferencePair(passing({}), failing({}));
    const crafted = structuredClone(built.pair);
    expect(crafted).not.toBeNull();
    if (crafted !== null) {
      crafted.rejected.failureCategory = 'tool_failed';
      expect(validatePreferencePair(crafted).valid).toBe(false);
    }
  });

  it('rejects a hand-crafted no-preference-signal pair at validation', () => {
    const built = buildPreferencePair(passing({}), failing({}));
    const crafted = structuredClone(built.pair);
    expect(crafted).not.toBeNull();
    if (crafted !== null) {
      crafted.rejected.verifier = { verdict: 'pass', tests: 'pass' };
      expect(validatePreferencePair(crafted).valid).toBe(false);
    }
  });
});

describe('buildDpoRecord (issue #54)', () => {
  it('builds a schema-valid DPO record from an eligible pair', () => {
    const built = buildDpoRecord(passing({}), failing({}));
    expect(built.record).not.toBeNull();
    expect(validateDpoRecord(built.record).valid).toBe(true);
    expect(built.record?.schema).toBe('dpo/1');
  });

  it('carries no trainable DPO record for env-failure input', () => {
    const envFail = makeExport({
      status: 'failed',
      failureCategory: 'tool_failed',
      summary: 'tool exploded',
    });
    const built = buildDpoRecord(passing({}), envFail);
    expect(built.record).toBeNull();
    expect(built.excluded?.tag).toBe('env-failure-excluded');
  });

  it('rejects a cross-boundary DPO record at validation', () => {
    const built = buildDpoRecord(passing({}), failing({}));
    // A null record would spread to `{ boundary }` and be invalid for the
    // wrong reason.
    expect(built.record).not.toBeNull();
    const crossed = {
      ...built.record,
      boundary: 'cross-worktree',
    };
    expect(validateDpoRecord(crossed).valid).toBe(false);
  });

  it('rejects a stripped DPO record with an error', () => {
    const built = buildDpoRecord(passing({}), failing({}));
    expect(built.record).not.toBeNull();
    const { provenance: _dropped, ...stripped } =
      built.record as unknown as Record<string, unknown>;
    const checked = validateDpoRecord(stripped);
    expect(checked.valid).toBe(false);
    if (!checked.valid) {
      expect(checked.errors.join(' ')).toMatch(/provenance/i);
      expect(checked.record).toBeUndefined();
    }
  });

  it('rejects a hand-crafted cross-grant DPO at validation', () => {
    const built = buildDpoRecord(passing({}), failing({}));
    const crossed = structuredClone(built.record);
    expect(crossed).not.toBeNull();
    if (crossed !== null) {
      crossed.boundary = 'within';
      crossed.grantRef = { chosen: 'solo:exec', rejected: 'worktree:write' };
      expect(validateDpoRecord(crossed).valid).toBe(false);
    }
  });

  it('rejects a hand-crafted env-failure DPO at validation', () => {
    const built = buildDpoRecord(passing({}), failing({}));
    const crafted = structuredClone(built.record);
    expect(crafted).not.toBeNull();
    if (crafted !== null) {
      crafted.failureCategory = {
        ...crafted.failureCategory,
        rejected: 'tool_failed',
      };
      expect(validateDpoRecord(crafted).valid).toBe(false);
    }
  });

  it('rejects a hand-crafted no-preference-signal DPO at validation', () => {
    const built = buildDpoRecord(passing({}), failing({}));
    const crafted = structuredClone(built.record);
    expect(crafted).not.toBeNull();
    if (crafted !== null) {
      crafted.verifier = {
        ...crafted.verifier,
        rejected: { verdict: 'pass', tests: 'pass' },
      };
      expect(validateDpoRecord(crafted).valid).toBe(false);
    }
  });
});
