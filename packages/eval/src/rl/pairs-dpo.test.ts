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
