// Tool-use + coding exporter tests.
// Tool-use records carry the bounded action/observation refs; coding
// records carry diff refs (paths only) plus the reference-verifier
// verdict. Both validate fail-closed.
import { describe, expect, it } from 'vitest';
import { makeExport } from '../test-support/fixtures.js';
import { buildCodingRecord, validateCodingRecord } from './coding.js';
import { buildToolUseRecord, validateToolUseRecord } from './tooluse.js';

describe('buildToolUseRecord', () => {
  it('generates a schema-valid tool-use record with provenance + label', () => {
    const exported = makeExport({});
    exported.actions = [
      { seq: 1, tool: 'exec', args: { cmd: 'ls' } },
      { seq: 2, tool: 'read', args: { path: 'a.ts' } },
    ];
    exported.observations = [
      {
        seq: 1,
        actionSeq: 1,
        output: 'a.ts',
        truncated: false,
        bytesOriginal: 4,
      },
    ];
    const built = buildToolUseRecord(exported);
    expect(built.schema).toBe('tool-use/1');
    expect(validateToolUseRecord(built).valid).toBe(true);
    expect(built.steps).toHaveLength(2);
    expect(built.steps[0]?.observationRef).toBe(1);
    expect(built.steps[1]?.observationRef).toBeNull();
  });

  it('rejects a stripped tool-use record with an error', () => {
    const built = buildToolUseRecord(makeExport({}));
    const { failureCategory: _dropped, ...stripped } = built;
    const checked = validateToolUseRecord(stripped);
    expect(checked.valid).toBe(false);
    if (!checked.valid) {
      expect(checked.errors.join(' ')).toMatch(/failureCategory/i);
      expect(checked.record).toBeUndefined();
    }
  });
});

describe('buildCodingRecord', () => {
  it('generates a schema-valid coding record with diff refs + verdict', () => {
    const exported = makeExport({ evalLabels: { 'signal:tests': 'pass' } });
    exported.diff = {
      filesChanged: ['src/a.ts'],
      files: [{ path: 'src/a.ts', hunks: ['@@ -1 +1 @@'] }],
    };
    const built = buildCodingRecord(exported);
    expect(built.schema).toBe('coding/1');
    expect(validateCodingRecord(built).valid).toBe(true);
    expect(built.diffRefs).toEqual(['src/a.ts']);
    expect(built.verifier.verdict).toBe('pass');
  });

  it('carries paths only, never embedded contents', () => {
    const exported = makeExport({});
    exported.diff = {
      filesChanged: ['src/a.ts'],
      files: [{ path: 'src/a.ts', hunks: ['@@ secret @@'] }],
    };
    const built = buildCodingRecord(exported);
    expect(JSON.stringify(built)).not.toMatch(/secret/);
  });

  it('rejects a stripped coding record with an error', () => {
    const built = buildCodingRecord(makeExport({}));
    const { provenance: _dropped, ...stripped } = built;
    const checked = validateCodingRecord(stripped);
    expect(checked.valid).toBe(false);
    if (!checked.valid) {
      expect(checked.errors.join(' ')).toMatch(/provenance/i);
      expect(checked.record).toBeUndefined();
    }
  });
});
