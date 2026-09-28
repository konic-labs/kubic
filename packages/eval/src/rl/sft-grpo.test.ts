// SFT + GRPO exporter tests (issue #54, RED first).
// Both types generate against a schema and validate fail-closed:
// stripped provenance/labels are errors, not warnings.
import { describe, expect, it } from 'vitest';
import { makeExport } from './fixtures.js';
import { buildGrpoGroup, validateGrpoGroup } from './grpo.js';
import { canonicalJson } from './manifest.js';
import { buildSftRecord, validateSftRecord } from './sft.js';

describe('buildSftRecord (issue #54)', () => {
  it('generates a schema-valid SFT record from a passing trajectory', () => {
    const built = buildSftRecord(
      makeExport({ evalLabels: { 'signal:tests': 'pass' } }),
    );
    expect(built.schema).toBe('sft/1');
    expect(validateSftRecord(built).valid).toBe(true);
    expect(built.provenance.worktree).toBe('/wt/agent-1');
    expect(built.verifier.verdict).toBe('pass');
  });

  it('embeds the §52 category on failed runs', () => {
    const built = buildSftRecord(
      makeExport({ status: 'failed', failureCategory: 'model_failed' }),
    );
    expect(built.failureCategory).toBe('model_failed');
    expect(validateSftRecord(built).valid).toBe(true);
  });

  it('rejects a stripped record with an error, not a warning', () => {
    const built = buildSftRecord(makeExport({}));
    const { provenance: _dropped, ...stripped } = built;
    const checked = validateSftRecord(stripped);
    expect(checked.valid).toBe(false);
    if (!checked.valid) {
      expect(checked.errors.join(' ')).toMatch(/provenance/i);
      expect(checked.record).toBeUndefined();
    }
  });

  it('rejects a record with a stripped failure label', () => {
    const built = buildSftRecord(makeExport({}));
    const { failureCategory: _dropped, ...stripped } = built;
    const checked = validateSftRecord(stripped);
    expect(checked.valid).toBe(false);
    if (!checked.valid) {
      expect(checked.errors.join(' ')).toMatch(/failureCategory is required/);
    }
  });
});

describe('buildGrpoGroup (issue #54)', () => {
  it('generates a schema-valid GRPO group with verifier rewards', () => {
    const group = buildGrpoGroup([
      makeExport({ evalLabels: { 'signal:tests': 'pass' } }),
      makeExport({ evalLabels: { 'signal:tests': 'fail' } }),
    ]);
    expect(group.schema).toBe('grpo/1');
    expect(group.candidates).toHaveLength(2);
    expect(validateGrpoGroup(group).valid).toBe(true);
    expect(group.candidates[0]?.reward).toBe(1);
    expect(group.candidates[1]?.reward).toBe(0);
  });

  it('rejects a group whose candidates share no prompt', () => {
    const group = buildGrpoGroup([
      makeExport({ promptText: 'task a' }),
      makeExport({ promptText: 'task b' }),
    ]);
    const checked = validateGrpoGroup(group);
    expect(checked.valid).toBe(false);
    if (!checked.valid) {
      expect(checked.errors).toContain(
        'candidates[1] shares no prompt with the group',
      );
    }
  });

  it('rejects a stripped candidate with an error', () => {
    // Two candidates: a one-record group is refused for its size alone, which
    // would let this pass without the provenance check ever running.
    const group = buildGrpoGroup([makeExport({}), makeExport({})]);
    expect(validateGrpoGroup(group).valid).toBe(true);
    const stripped = {
      ...group,
      candidates: [
        group.candidates[0],
        { ...group.candidates[1], provenance: undefined },
      ],
    };
    const checked = validateGrpoGroup(stripped);
    expect(checked.valid).toBe(false);
    if (!checked.valid) {
      expect(checked.errors.join(' ')).toMatch(/candidates\[1\]\.provenance/);
      expect(checked.errors.join(' ')).not.toMatch(/candidates\[0\]/);
    }
  });
});

describe('canonicalJson manifest determinism (issue #54)', () => {
  it('is byte-identical for the same trajectory + verifier', () => {
    const exported = makeExport({ evalLabels: { 'signal:tests': 'pass' } });
    const first = canonicalJson(buildSftRecord(exported));
    const second = canonicalJson(
      buildSftRecord(makeExport({ evalLabels: { 'signal:tests': 'pass' } })),
    );
    expect(second).toBe(first);
  });

  it('changes when the verifier verdict changes', () => {
    const passing = canonicalJson(
      buildSftRecord(makeExport({ evalLabels: { 'signal:tests': 'pass' } })),
    );
    const failing = canonicalJson(buildSftRecord(makeExport({})));
    expect(failing).not.toBe(passing);
  });
});
