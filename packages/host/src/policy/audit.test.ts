// Org audit trail tests (issue #57; §60 14 fields, §83 engine, §85 flow).
// RED first: imports fail until audit.ts lands. Faux-only, zero network.
// Secret-shaped fixtures below are faux (contain 'faux'), never real.
import { describe, expect, it } from 'vitest';
import {
  AUDIT_FIELDS,
  AuditShapeError,
  AuditSinkError,
  appendAudit,
  createMemorySink,
  emitAudit,
  FLOW_AUDIT_FIXTURE,
  type OrgAuditRecord,
  queryAudits,
  sortAuditSinksSyslogFirst,
  toCredentialSentinel,
  WORKED_EXAMPLE_JSON,
} from './audit.js';

// Secret-shaped but faux: shaped like real material so the sentinel and
// redaction paths are exercised, inert so tests stay faux-only.
const FAUX_A = 'sk-faux-test-key-0001';
const FAUX_B = 'AKIAFAUXTEST00000001';

function baseInput(): Omit<OrgAuditRecord, 'when'> {
  return {
    who: 'ege@example.com',
    what: 'tool.call',
    agent: { session: 'sess-1', role: 'implementer', parent: 'sess-0' },
    model: { provider: 'local', id: 'llama3', thinking: 'medium' },
    worker: { pid: 1234, generation: 2, role: 'implementer' },
    workspace: { path: '/repo/wt/57', base: '/repo' },
    permission: { permission: 'write', approval: 'approved:tester' },
    credential: { sentinel: toCredentialSentinel('$API_KEY') },
    network: { host: 'example.com', port: 443, decision: 'allow', bytes: 512 },
    mode: 'orchestrator',
    posture: 'restricted',
    result: 'ok',
    reason: 'policy allow',
  };
}

describe('org audit record', () => {
  it('carries all 14 section-60 fields on every record', () => {
    const sink = createMemorySink();
    const record = emitAudit([sink], baseInput(), {
      now: () => 1_700_000_000_000,
    });
    expect(Object.keys(record)).toHaveLength(14);
    expect([...Object.keys(record)].sort()).toEqual([...AUDIT_FIELDS].sort());
    expect(record.when).toBe('2023-11-14T22:13:20.000Z');
    expect(record.mode).toBe('orchestrator');
    expect(record.posture).toBe('restricted');
  });

  it('credential sentinel never carries secret material', () => {
    const sentinel = toCredentialSentinel('$API_KEY');
    expect(sentinel).not.toContain(FAUX_A);
    expect(sentinel).not.toContain(FAUX_B);
    const sink = createMemorySink();
    const record = emitAudit(
      [sink],
      {
        ...baseInput(),
        credential: { sentinel },
      },
      { secrets: [FAUX_A, FAUX_B], now: () => 1_700_000_000_000 },
    );
    expect(JSON.stringify(record)).not.toContain(FAUX_A);
    expect(JSON.stringify(record)).not.toContain(FAUX_B);
  });

  it('rejects a sentinel smuggling secret-shaped material', () => {
    const sink = createMemorySink();
    expect(() =>
      emitAudit(
        [sink],
        { ...baseInput(), credential: { sentinel: FAUX_A } },
        {
          secrets: [FAUX_A],
        },
      ),
    ).toThrow(AuditSinkError);
  });

  it('rejects unknown top-level keys instead of keeping them (exactly 14)', () => {
    const sink = createMemorySink();
    const smuggled = {
      ...baseInput(),
      extra: 'smuggled',
    } as unknown as Omit<OrgAuditRecord, 'when'>;
    expect(() => emitAudit([sink], smuggled)).toThrow(AuditShapeError);
    expect(sink.records).toHaveLength(0);
  });

  it('refuses secret-shaped material in the sentinel without a secrets list', () => {
    const sink = createMemorySink();
    expect(() =>
      emitAudit([sink], {
        ...baseInput(),
        credential: { sentinel: 'sentinel:sk-faux-test-key-0001' },
      }),
    ).toThrow(AuditShapeError);
    expect(sink.records).toHaveLength(0);
  });

  it('refuses secret-shaped material in the reason without a secrets list', () => {
    const sink = createMemorySink();
    expect(() =>
      emitAudit([sink], {
        ...baseInput(),
        reason: 'denied: saw sk-faux-test-key-0001 on the wire',
      }),
    ).toThrow(AuditShapeError);
    expect(sink.records).toHaveLength(0);
  });
});

describe('section-85 flow fixture', () => {
  it('matches the section-60 worked example verbatim', () => {
    expect(JSON.stringify(FLOW_AUDIT_FIXTURE)).toBe(WORKED_EXAMPLE_JSON);
    const parsed = JSON.parse(WORKED_EXAMPLE_JSON) as OrgAuditRecord;
    expect(Object.keys(parsed)).toHaveLength(14);
  });
});

describe('mode, posture, and query', () => {
  it('full-access records are queryable by posture', () => {
    const sink = createMemorySink();
    const full = emitAudit(
      [sink],
      { ...baseInput(), posture: 'full-access', mode: 'solo' },
      { now: () => 1_700_000_000_001 },
    );
    emitAudit([sink], baseInput(), { now: () => 1_700_000_000_002 });
    expect(full.mode).toBe('solo');
    expect(queryAudits(sink.records, { posture: 'full-access' })).toEqual([
      full,
    ]);
    expect(queryAudits(sink.records, { mode: 'orchestrator' })).toHaveLength(1);
  });
});

describe('sink failure', () => {
  it('fails loudly with no silent loss', () => {
    const failing = {
      name: 'broken',
      kind: 'syslog' as const,
      write: (): void => {
        throw new Error('syslog unreachable');
      },
    };
    expect(() => appendAudit([failing], FLOW_AUDIT_FIXTURE)).toThrow(
      AuditSinkError,
    );
    expect(() => appendAudit([], FLOW_AUDIT_FIXTURE)).toThrow(AuditSinkError);
  });

  it('syslog sinks order first', () => {
    const ordered = sortAuditSinksSyslogFirst([
      { name: 'f', kind: 'file' as const, write: (): void => {} },
      { name: 's', kind: 'syslog' as const, write: (): void => {} },
      { name: 'm', kind: 'memory' as const, write: (): void => {} },
    ]);
    expect(ordered.map((sink) => sink.kind)).toEqual([
      'syslog',
      'file',
      'memory',
    ]);
  });

  it('refuses async sinks that return a thenable', () => {
    const asyncSink = {
      name: 'async-syslog',
      kind: 'syslog' as const,
      write: (): unknown => Promise.resolve(),
    };
    expect(() => appendAudit([asyncSink], FLOW_AUDIT_FIXTURE)).toThrow(
      AuditSinkError,
    );
  });

  it('redacts secret-shaped substrings from sink failure messages', () => {
    const live = 'sk-faux-test-key-0001';
    const leaking = {
      name: 'leaky',
      kind: 'syslog' as const,
      write: (): void => {
        throw new Error(`syslog unreachable: saw ${live} on the wire`);
      },
    };
    try {
      appendAudit([leaking], FLOW_AUDIT_FIXTURE);
      expect.unreachable('leaky sink failure must throw');
    } catch (error) {
      expect(error).toBeInstanceOf(AuditSinkError);
      const message = (error as Error).message;
      expect(message).not.toContain(live);
      expect(message).toContain('[redacted-secret]');
    }
  });
});
