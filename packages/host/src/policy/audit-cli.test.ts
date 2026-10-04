// `kubic audit` CLI tests (issue #79; §60, 14 fields, sentinel-only
// credentials). RED first: audit-cli.ts lands after this file. Records
// are injected; the command redacts before printing. Faux-only —
// shape-matching values below carry a FAUX marker and stay inert.
import { describe, expect, it } from 'vitest';
import {
  AUDIT_FIELDS,
  FLOW_AUDIT_FIXTURE,
  type OrgAuditRecord,
} from './audit.js';
import { runAuditCommand } from './audit-cli.js';
import { containsSecretShape, REDACTED_SECRET } from './secret-shapes.js';

// Shape-matching but inert (FAUX marker, never a live key): exercises the
// redaction path the way secret-shapes.test.ts does.
const FAUX_SHAPED = 'SK-FAUX-TEST-KEY-0001';
const FAUX_LISTED = 'faux-inventory-token-0001';

function seeded(): OrgAuditRecord[] {
  return [
    {
      ...FLOW_AUDIT_FIXTURE,
      agent: { ...FLOW_AUDIT_FIXTURE.agent },
      model: { ...FLOW_AUDIT_FIXTURE.model },
      worker: { ...FLOW_AUDIT_FIXTURE.worker },
      workspace: { ...FLOW_AUDIT_FIXTURE.workspace },
      permission: { ...FLOW_AUDIT_FIXTURE.permission },
      credential: { ...FLOW_AUDIT_FIXTURE.credential },
      network: { ...FLOW_AUDIT_FIXTURE.network },
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
      sentinel: FLOW_AUDIT_FIXTURE.credential.sentinel,
    });
  });
});

describe('kubic audit query (issue #79)', () => {
  const TWO: OrgAuditRecord[] = [
    FLOW_AUDIT_FIXTURE,
    {
      ...FLOW_AUDIT_FIXTURE,
      agent: { ...FLOW_AUDIT_FIXTURE.agent },
      model: { ...FLOW_AUDIT_FIXTURE.model },
      worker: { ...FLOW_AUDIT_FIXTURE.worker },
      workspace: { ...FLOW_AUDIT_FIXTURE.workspace },
      permission: { ...FLOW_AUDIT_FIXTURE.permission },
      credential: { ...FLOW_AUDIT_FIXTURE.credential },
      network: { ...FLOW_AUDIT_FIXTURE.network },
      mode: 'solo',
      posture: 'full-access',
      result: 'deny',
    },
  ];

  it('filters on mode, posture, and result', async () => {
    const cap = capture();
    const code = await runAuditCommand(
      { mode: 'solo', posture: 'full-access', result: 'deny' },
      { loadRecords: () => TWO, out: cap.out, err: cap.err },
    );
    expect(code).toBe(0);
    // One table: the header plus the one matching record.
    expect(cap.lines).toHaveLength(1);
    const rows = (cap.lines[0] ?? '').split('\n');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatch(/^WHEN +MODE +POSTURE +RESULT +WHAT/);
    expect(rows[1]).toMatch(/ solo +full-access +deny +tool\.call /);
  });

  // Issue #159: `--session <orch>` reads one orchestration run's decisions —
  // the manager's own rows (agent.session = the run) and every worker ask it
  // spawned (agent.session = `<orch>-<agent>`, agent.parent = the run).
  it('filters on the orchestrator session: the run and the workers it spawned', async () => {
    const rows: OrgAuditRecord[] = [
      {
        ...FLOW_AUDIT_FIXTURE,
        agent: { session: 'orch-9', role: 'manager' },
        what: 'merge:kubic/orch-9/worker-1',
      },
      {
        ...FLOW_AUDIT_FIXTURE,
        agent: {
          session: 'orch-9-worker-1',
          role: 'implementer',
          parent: 'orch-9',
        },
        what: 'tool:bash',
      },
      {
        ...FLOW_AUDIT_FIXTURE,
        agent: {
          session: 'orch-8-worker-1',
          role: 'implementer',
          parent: 'orch-8',
        },
        what: 'tool:bash',
      },
    ];
    const cap = capture();
    const code = await runAuditCommand(
      { session: 'orch-9', json: true },
      { loadRecords: () => rows, out: cap.out, err: cap.err },
    );
    expect(code).toBe(0);
    const printed = JSON.parse(cap.lines[0] ?? '[]') as OrgAuditRecord[];
    expect(printed.map((record) => record.what)).toEqual([
      'merge:kubic/orch-9/worker-1',
      'tool:bash',
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

describe('kubic audit usage (issue #79, §78)', () => {
  it('exits 2 on an unknown mode', async () => {
    const cap = capture();
    const code = await runAuditCommand(
      { mode: 'turbo' },
      {
        loadRecords: seeded,
        out: cap.out,
        err: cap.err,
      },
    );
    expect(code).toBe(2);
    expect(cap.lines).toEqual([]);
    expect(cap.errs).toEqual([
      'error: unknown mode "turbo" (want solo|orchestrator)',
    ]);
  });

  it('exits 2 on an unknown result', async () => {
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
      { mode: FAUX_SHAPED },
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
