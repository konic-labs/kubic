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
  createSyslogSink,
  defaultSyslogSocketPath,
  emitAudit,
  FLOW_AUDIT_FIXTURE,
  type OrgAuditRecord,
  parseSyslogTarget,
  queryAudits,
  type SyslogTransport,
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

  it('credential sentinel names the reference, never the value', () => {
    const sentinel = toCredentialSentinel('$API_KEY');
    expect(sentinel).toBe('sentinel:$API_KEY');
    const sink = createMemorySink();
    const record = emitAudit(
      [sink],
      {
        ...baseInput(),
        credential: { sentinel },
      },
      { secrets: [FAUX_A, FAUX_B], now: () => 1_700_000_000_000 },
    );
    expect(record.credential.sentinel).toBe('sentinel:$API_KEY');
    expect(sink.records).toEqual([record]);
  });

  it('refuses a listed (unshaped) secret anywhere in the record', () => {
    // Not secret-SHAPED, so only the listed inventory can catch it.
    const listed = 'plain-inventory-value-0001';
    const sink = createMemorySink();
    expect(() =>
      emitAudit(
        [sink],
        { ...baseInput(), reason: `denied: saw ${listed}` },
        { secrets: [listed] },
      ),
    ).toThrow(AuditShapeError);
    expect(sink.records).toHaveLength(0);
    // The same record without the inventory is emitted: the refusal above
    // came from the listed-secret rule, not the shape backstop.
    expect(
      emitAudit([sink], { ...baseInput(), reason: `denied: saw ${listed}` })
        .reason,
    ).toBe(`denied: saw ${listed}`);
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

  // Issue #159: an orchestration's ledger holds the manager's own rows
  // (agent.session is the run) and each worker's rows (agent.session is the
  // worker's `<orch>-<agent>`, agent.parent is the run). Filtering by the
  // orchestrator session must return both halves of that run, and nothing
  // from another run.
  it('filters on the orchestrator session across manager and worker rows (issue #159)', () => {
    const sink = createMemorySink('memory');
    emitAudit(
      [sink],
      { ...baseInput(), agent: { session: 'orch-9', role: 'manager' } },
      { now: () => 1_700_000_000_001 },
    );
    emitAudit(
      [sink],
      {
        ...baseInput(),
        agent: {
          session: 'orch-9-worker-1',
          role: 'implementer',
          parent: 'orch-9',
        },
      },
      { now: () => 1_700_000_000_002 },
    );
    emitAudit(
      [sink],
      {
        ...baseInput(),
        agent: {
          session: 'orch-8-worker-1',
          role: 'implementer',
          parent: 'orch-8',
        },
      },
      { now: () => 1_700_000_000_003 },
    );
    expect(
      queryAudits(sink.records, { session: 'orch-9' }).map(
        (record) => record.agent.session,
      ),
    ).toEqual(['orch-9', 'orch-9-worker-1']);
    expect(queryAudits(sink.records, { session: 'nobody' })).toEqual([]);
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

describe('case-transform bypass (fix cycle 2)', () => {
  it('refuses uppercase SK- material in the wire form', () => {
    const sink = createMemorySink();
    expect(() =>
      emitAudit([sink], {
        ...baseInput(),
        reason: 'denied: saw SK-FAUX-TEST-KEY-0001 on the wire',
      }),
    ).toThrow(AuditShapeError);
    expect(sink.records).toHaveLength(0);
  });

  it.each(['BEARER', 'bEaReR', 'BeArEr'])(
    'refuses %s-scheme tokens in the wire form',
    (scheme) => {
      const sink = createMemorySink();
      expect(() =>
        emitAudit([sink], {
          ...baseInput(),
          reason: `denied: saw ${scheme} faux-token-0001-abcdef on the wire`,
        }),
      ).toThrow(AuditShapeError);
      expect(sink.records).toHaveLength(0);
    },
  );

  it.each(['BEARER', 'bEaReR'])(
    'redacts %s-scheme tokens from sink failure messages',
    (scheme) => {
      const live = `${scheme} faux-token-0001-abcdef`;
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
        expect(message).not.toContain('faux-token-0001-abcdef');
        expect(message).toContain('[redacted-secret]');
      }
    },
  );

  it('redacts uppercase SK- material from sink failure messages', () => {
    const live = 'SK-FAUX-TEST-KEY-0001';
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

  it('redacts listed-secret inventory values from sink failure messages', () => {
    const listed = 'listed-plaintext-inventory-token-0001';
    const leaking = {
      name: 'leaky',
      kind: 'syslog' as const,
      write: (): void => {
        throw new Error(`syslog unreachable: saw ${listed} on the wire`);
      },
    };
    try {
      appendAudit([leaking], FLOW_AUDIT_FIXTURE, [listed]);
      expect.unreachable('leaky sink failure must throw');
    } catch (error) {
      expect(error).toBeInstanceOf(AuditSinkError);
      const message = (error as Error).message;
      expect(message).not.toContain(listed);
      expect(message).toContain('[redacted-secret]');
    }
  });

  it('a sink cannot rewrite the record other sinks store', () => {
    const memory = createMemorySink('memory');
    const rewriting = {
      name: 'rewriter',
      kind: 'syslog' as const,
      write: (record: OrgAuditRecord): void => {
        record.reason = 'pwned';
      },
    };
    const returned = emitAudit([rewriting, memory], baseInput(), {
      now: () => 1_700_000_000_000,
    });
    expect(memory.records).toHaveLength(1);
    expect(memory.records[0]?.reason).toBe('policy allow');
    expect(returned.reason).toBe('policy allow');
  });

  it('rejects a non-string agent.parent instead of emitting it', () => {
    const sink = createMemorySink();
    const smuggled = {
      ...baseInput(),
      agent: { session: 'sess-1', role: 'implementer', parent: { evil: 1 } },
    } as unknown as Omit<OrgAuditRecord, 'when'>;
    expect(() => emitAudit([sink], smuggled)).toThrow(AuditSinkError);
    expect(sink.records).toHaveLength(0);
  });
});

describe('nested unknown keys (fix cycle 2)', () => {
  it('rejects agent.extra (exactly-14 holds below the top level)', () => {
    const sink = createMemorySink();
    const input = baseInput();
    const smuggled = {
      ...input,
      agent: { ...input.agent, extra: 'smuggled' },
    } as unknown as Omit<OrgAuditRecord, 'when'>;
    expect(() => emitAudit([sink], smuggled)).toThrow(AuditShapeError);
    expect(sink.records).toHaveLength(0);
  });

  it('rejects credential.extra', () => {
    const sink = createMemorySink();
    const input = baseInput();
    const smuggled = {
      ...input,
      credential: { ...input.credential, extra: 'smuggled' },
    } as unknown as Omit<OrgAuditRecord, 'when'>;
    expect(() => emitAudit([sink], smuggled)).toThrow(AuditShapeError);
    expect(sink.records).toHaveLength(0);
  });

  it('rejects network.extra', () => {
    const sink = createMemorySink();
    const input = baseInput();
    const smuggled = {
      ...input,
      network: { ...input.network, extra: 'smuggled' },
    } as unknown as Omit<OrgAuditRecord, 'when'>;
    expect(() => emitAudit([sink], smuggled)).toThrow(AuditShapeError);
    expect(sink.records).toHaveLength(0);
  });

  it('rejects worker.extra', () => {
    const sink = createMemorySink();
    const input = baseInput();
    const smuggled = {
      ...input,
      worker: { ...input.worker, extra: 'smuggled' },
    } as unknown as Omit<OrgAuditRecord, 'when'>;
    expect(() => emitAudit([sink], smuggled)).toThrow(AuditShapeError);
    expect(sink.records).toHaveLength(0);
  });
});

// Syslog sink (issue #286; §58): one record → one RFC 5424 line over an
// injectable transport. Faux-only: the fake transport captures lines, no
// socket is ever opened.
describe('syslog sink (issue #286)', () => {
  function fakeTransport(): SyslogTransport & { lines: string[] } {
    const lines: string[] = [];
    return {
      lines,
      send: (line: string): void => {
        lines.push(line);
      },
    };
  }

  function record(): OrgAuditRecord {
    return { ...baseInput(), when: '2026-10-05T12:00:00.000Z' };
  }

  it('emits one RFC 5424 line whose MSG is the record JSON', () => {
    const transport = fakeTransport();
    const sink = createSyslogSink({ transport, hostname: 'web-1' });
    expect(sink.kind).toBe('syslog');
    sink.write(record());
    expect(transport.lines).toHaveLength(1);
    const line = transport.lines[0] ?? '';
    // local0 (16) × 8 + info (6) = 134; the record timestamp, host, app,
    // acting pid, and the record as the MSG.
    expect(
      line.startsWith('<134>1 2026-10-05T12:00:00.000Z web-1 kubic 1234 - - '),
    ).toBe(true);
    expect(JSON.parse(line.slice(line.indexOf('{')))).toMatchObject({
      who: 'ege@example.com',
      what: 'tool.call',
    });
  });

  it('raises severity to warning for deny and error results', () => {
    const transport = fakeTransport();
    const sink = createSyslogSink({ transport, hostname: 'web-1' });
    sink.write({ ...record(), result: 'deny' });
    sink.write({ ...record(), result: 'error' });
    expect(transport.lines[0]?.startsWith('<132>1')).toBe(true);
    expect(transport.lines[1]?.startsWith('<132>1')).toBe(true);
  });

  it('honours facility names, numbers and the app name', () => {
    const a = fakeTransport();
    createSyslogSink({
      transport: a,
      facility: 'authpriv',
      appName: 'kubic-worker',
      hostname: 'web-1',
    }).write(record());
    // authpriv (10) × 8 + info (6) = 86.
    expect(
      a.lines[0]?.startsWith(
        '<86>1 2026-10-05T12:00:00.000Z web-1 kubic-worker ',
      ),
    ).toBe(true);
    const b = fakeTransport();
    createSyslogSink({ transport: b, facility: 19, hostname: 'web-1' }).write(
      record(),
    );
    // 19 × 8 + 6 = 158.
    expect(b.lines[0]?.startsWith('<158>1')).toBe(true);
  });

  it('refuses an unknown facility by name', () => {
    expect(() =>
      createSyslogSink({
        transport: fakeTransport(),
        facility: 'carrier-pigeon',
      }),
    ).toThrow(/unknown syslog facility 'carrier-pigeon'/);
    expect(() =>
      createSyslogSink({ transport: fakeTransport(), facility: 99 }),
    ).toThrow(/unknown syslog facility '99'/);
  });

  it('parses syslog targets: bare and unix: paths, host:port and bare hosts', () => {
    expect(parseSyslogTarget(undefined)).toEqual({
      kind: 'unix',
      path: defaultSyslogSocketPath(),
    });
    expect(parseSyslogTarget('/dev/log')).toEqual({
      kind: 'unix',
      path: '/dev/log',
    });
    expect(parseSyslogTarget('unix:/var/run/syslog')).toEqual({
      kind: 'unix',
      path: '/var/run/syslog',
    });
    expect(parseSyslogTarget('loghost:514')).toEqual({
      kind: 'udp',
      host: 'loghost',
      port: 514,
    });
    expect(parseSyslogTarget('loghost')).toEqual({
      kind: 'udp',
      host: 'loghost',
      port: 514,
    });
    expect(() => parseSyslogTarget('loghost:notaport')).toThrow(
      /invalid syslog target/,
    );
    expect(() => parseSyslogTarget('')).toThrow(/invalid syslog target/);
    expect(() => parseSyslogTarget('   ')).toThrow(/invalid syslog target/);
  });
});
