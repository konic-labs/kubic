// `kubic audit` CLI tests: the record fields, sentinel-only credentials,
// the filters and redaction. Records are injected; the command redacts
// before printing. Faux-only — shape-matching values below carry a FAUX
// marker and stay inert.
import { describe, expect, it } from 'vitest';
import {
  AUDIT_FIELDS,
  EXAMPLE_AUDIT_RECORD,
  type OrgAuditRecord,
} from '../../../../packages/host/src/policy/audit.js';
import { runAuditCommand } from '../../../../packages/host/src/policy/audit-cli.js';
import {
  fullAccessEnabledAudit,
  undoRestoreAudit,
} from '../../../../packages/host/src/policy/audit-ledger.js';
import {
  containsSecretShape,
  REDACTED_SECRET,
} from '../../../../packages/host/src/policy/secret-shapes.js';

// Shape-matching but inert (FAUX marker, never a live key): exercises the
// redaction path the way secret-shapes.test.ts does.
const FAUX_SHAPED = 'SK-FAUX-TEST-KEY-0001';
const FAUX_LISTED = 'faux-inventory-token-0001';

function seeded(): OrgAuditRecord[] {
  return [
    {
      ...EXAMPLE_AUDIT_RECORD,
      agent: { ...EXAMPLE_AUDIT_RECORD.agent },
      model: { ...EXAMPLE_AUDIT_RECORD.model },
      worker: { ...EXAMPLE_AUDIT_RECORD.worker },
      workspace: { ...EXAMPLE_AUDIT_RECORD.workspace },
      permission: { ...EXAMPLE_AUDIT_RECORD.permission },
      credential: { ...EXAMPLE_AUDIT_RECORD.credential },
      network: { ...EXAMPLE_AUDIT_RECORD.network },
      reason: `policy allow (saw ${FAUX_SHAPED} and ${FAUX_LISTED} on the wire)`,
    },
  ];
}

// stdout (`lines`) and stderr (`errs`) captured separately.
function capture() {
  const lines: string[] = [];
  const errs: string[] = [];
  return {
    lines,
    errs,
    out: (line: string): void => {
      lines.push(line);
    },
    err: (line: string): void => {
      errs.push(line);
    },
  };
}

describe('kubic audit secret backstop (issue #79)', () => {
  it('prints zero secret-shaped values on a faux-seeded fixture', async () => {
    const cap = capture();
    const code = await runAuditCommand(
      {},
      {
        loadRecords: seeded,
        secrets: [FAUX_LISTED],
        out: cap.out,
        err: cap.err,
      },
    );
    expect(code).toBe(0);
    const text = cap.lines.join('\n');
    expect(containsSecretShape(text)).toBe(false);
    expect(text).not.toContain(FAUX_SHAPED);
    expect(text).not.toContain(FAUX_LISTED);
    expect(text).toContain(REDACTED_SECRET);
  });

  it('redacts the same way under --json', async () => {
    const cap = capture();
    const code = await runAuditCommand(
      { json: true },
      {
        loadRecords: seeded,
        secrets: [FAUX_LISTED],
        out: cap.out,
        err: cap.err,
      },
    );
    expect(code).toBe(0);
    const text = cap.lines.join('\n');
    expect(containsSecretShape(text)).toBe(false);
    expect(text).not.toContain(FAUX_SHAPED);
    expect(text).not.toContain(FAUX_LISTED);
    const parsed = JSON.parse(text) as OrgAuditRecord[];
    expect(parsed).toHaveLength(1);
    const head = parsed[0];
    if (head === undefined) throw new Error('missing audit record');
    expect(Object.keys(head).sort()).toEqual([...AUDIT_FIELDS].sort());
  });

  it('keeps sentinel-only credentials (never material)', async () => {
    const cap = capture();
    await runAuditCommand(
      { json: true },
      {
        loadRecords: seeded,
        secrets: [FAUX_LISTED],
        out: cap.out,
        err: cap.err,
      },
    );
    const parsed = JSON.parse(cap.lines.join('\n')) as OrgAuditRecord[];
    const head = parsed[0];
    if (head === undefined) throw new Error('missing audit record');
    expect(head.credential).toEqual({
      sentinel: EXAMPLE_AUDIT_RECORD.credential.sentinel,
    });
  });
});

describe('kubic audit query (issue #79)', () => {
  const TWO: OrgAuditRecord[] = [
    EXAMPLE_AUDIT_RECORD,
    {
      ...EXAMPLE_AUDIT_RECORD,
      agent: { ...EXAMPLE_AUDIT_RECORD.agent },
      model: { ...EXAMPLE_AUDIT_RECORD.model },
      worker: { ...EXAMPLE_AUDIT_RECORD.worker },
      workspace: { ...EXAMPLE_AUDIT_RECORD.workspace },
      permission: { ...EXAMPLE_AUDIT_RECORD.permission },
      credential: { ...EXAMPLE_AUDIT_RECORD.credential },
      network: { ...EXAMPLE_AUDIT_RECORD.network },
      posture: 'full-access',
      result: 'deny',
    },
  ];

  it('filters on posture and result', async () => {
    const cap = capture();
    const code = await runAuditCommand(
      { posture: 'full-access', result: 'deny' },
      { loadRecords: () => TWO, out: cap.out, err: cap.err },
    );
    expect(code).toBe(0);
    // One table: the header plus the one matching record.
    expect(cap.lines).toHaveLength(1);
    const rows = (cap.lines[0] ?? '').split('\n');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatch(/^WHEN +POSTURE +RESULT +WHAT/);
    expect(rows[1]).toMatch(/ full-access +deny +tool\.call /);
  });

  it("filters on one session's rows", async () => {
    const rows: OrgAuditRecord[] = [
      {
        ...EXAMPLE_AUDIT_RECORD,
        agent: { session: 's-1', role: 'root' },
        what: 'tool:bash',
      },
      {
        ...EXAMPLE_AUDIT_RECORD,
        agent: { session: 's-2', role: 'root' },
        what: 'tool:write',
      },
      {
        ...EXAMPLE_AUDIT_RECORD,
        agent: { session: 's-1', role: 'user' },
        what: 'undo-restore',
      },
    ];
    const cap = capture();
    const code = await runAuditCommand(
      { session: 's-1', json: true },
      { loadRecords: () => rows, out: cap.out, err: cap.err },
    );
    expect(code).toBe(0);
    const printed = JSON.parse(cap.lines[0] ?? '[]') as OrgAuditRecord[];
    expect(printed.map((record) => record.what)).toEqual([
      'tool:bash',
      'undo-restore',
    ]);
  });

  it('exits 2 on a whitespace-only session filter, like the other filters', async () => {
    const cap = capture();
    const code = await runAuditCommand(
      { session: '   ' },
      { loadRecords: () => TWO, out: cap.out, err: cap.err },
    );
    expect(code).toBe(2);
    expect(cap.errs.join('\n')).toMatch(/session/);
  });

  it('reports no audit records on an empty store', async () => {
    const cap = capture();
    const code = await runAuditCommand(
      {},
      {
        loadRecords: () => [],
        out: cap.out,
        err: cap.err,
      },
    );
    expect(code).toBe(0);
    expect(cap.lines).toEqual(['no audit records']);
  });
});

it('returns the privileged-action rows under --json with every field', async () => {
  const when = '2023-11-14T22:13:20.000Z';
  const records: OrgAuditRecord[] = [
    {
      ...fullAccessEnabledAudit({
        sessionId: 'sess',
        command: 'kubic run --dangerously-skip-approvals',
        workspace: '/repo',
      }),
      when,
    },
    {
      ...undoRestoreAudit({
        sessionId: 'sess',
        workspace: '/repo',
        base: 'abc123',
        restored: ['a.txt'],
        skipped: 0,
      }),
      when,
    },
  ];
  const cap = capture();
  const code = await runAuditCommand(
    { json: true },
    { loadRecords: () => records, out: cap.out, err: cap.err },
  );
  expect(code).toBe(0);
  const parsed = JSON.parse(cap.lines.join('\n')) as OrgAuditRecord[];
  expect(parsed.map((row) => row.what)).toEqual([
    'posture:full-access',
    'undo-restore',
  ]);
  for (const row of parsed) {
    expect(Object.keys(row).sort()).toEqual([...AUDIT_FIELDS].sort());
  }
});

describe('kubic audit usage', () => {
  it('exits 2 on an unknown result, naming the choices', async () => {
    const cap = capture();
    const code = await runAuditCommand(
      { result: 'maybe' },
      {
        loadRecords: seeded,
        out: cap.out,
        err: cap.err,
      },
    );
    expect(code).toBe(2);
    expect(cap.lines).toEqual([]);
    expect(cap.errs).toEqual([
      'error: unknown result "maybe" (want ok|deny|error)',
    ]);
  });

  // Argv syntax (a filter without a value, unknown flags, --help) is
  // commander's: apps/kubic/src/commands/analysis.test.ts pins it.
});

describe('kubic audit prod secrets wiring (issue #79 fix cycle 1)', () => {
  it('redacts a listed-inventory value supplied via the prod loadSecrets hook', async () => {
    const cap = capture();
    const code = await runAuditCommand(
      { json: true },
      {
        loadRecords: seeded,
        loadSecrets: () => [FAUX_LISTED],
        out: cap.out,
        err: cap.err,
      },
    );
    expect(code).toBe(0);
    const text = cap.lines.join('\n');
    expect(text).not.toContain(FAUX_LISTED);
    expect(text).toContain(REDACTED_SECRET);
  });

  it('redacts secret-shaped material in unknown filter-value errors', async () => {
    const cap = capture();
    const code = await runAuditCommand(
      { result: FAUX_SHAPED },
      {
        loadRecords: seeded,
        out: cap.out,
        err: cap.err,
      },
    );
    expect(code).toBe(2);
    const text = cap.errs.join('\n');
    expect(text).not.toContain(FAUX_SHAPED);
    expect(text).toContain(REDACTED_SECRET);
  });
});
