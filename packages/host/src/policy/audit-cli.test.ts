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

function capture() {
  const lines: string[] = [];
  return {
    lines,
    out: (line: string): void => {
      lines.push(line);
    },
  };
}

describe('kubic audit secret backstop (issue #79)', () => {
  it('prints zero secret-shaped values on a faux-seeded fixture', async () => {
    const cap = capture();
    const code = await runAuditCommand([], {
      loadRecords: seeded,
      secrets: [FAUX_LISTED],
      out: cap.out,
    });
    expect(code).toBe(0);
    const text = cap.lines.join('\n');
    expect(containsSecretShape(text)).toBe(false);
    expect(text).not.toContain(FAUX_SHAPED);
    expect(text).not.toContain(FAUX_LISTED);
    expect(text).toContain(REDACTED_SECRET);
  });

  it('redacts the same way under --json', async () => {
    const cap = capture();
    const code = await runAuditCommand(['--json'], {
      loadRecords: seeded,
      secrets: [FAUX_LISTED],
      out: cap.out,
    });
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
    await runAuditCommand(['--json'], {
      loadRecords: seeded,
      secrets: [FAUX_LISTED],
      out: cap.out,
    });
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
      ['--mode', 'solo', '--posture', 'full-access', '--result', 'deny'],
      { loadRecords: () => TWO, out: cap.out },
    );
    expect(code).toBe(0);
    expect(cap.lines).toHaveLength(1);
    expect(cap.lines[0]).toMatch(/"solo"/);
  });

  it('reports no audit records on an empty store', async () => {
    const cap = capture();
    const code = await runAuditCommand([], {
      loadRecords: () => [],
      out: cap.out,
    });
    expect(code).toBe(0);
    expect(cap.lines).toEqual(['no audit records']);
  });
});

describe('kubic audit usage (issue #79, §78)', () => {
  it('exits 2 on an unknown mode', async () => {
    const cap = capture();
    const code = await runAuditCommand(['--mode', 'turbo'], {
      loadRecords: seeded,
      out: cap.out,
    });
    expect(code).toBe(2);
    expect(
      cap.lines.some((line) => line.startsWith('usage: kubic audit')),
    ).toBe(true);
  });

  it('exits 2 on an unknown result', async () => {
    const cap = capture();
    const code = await runAuditCommand(['--result', 'maybe'], {
      loadRecords: seeded,
      out: cap.out,
    });
    expect(code).toBe(2);
  });

  it('exits 2 when a filter has no value', async () => {
    const cap = capture();
    const code = await runAuditCommand(['--posture'], {
      loadRecords: seeded,
      out: cap.out,
    });
    expect(code).toBe(2);
  });

  it('exits 2 on an unknown flag', async () => {
    const cap = capture();
    const code = await runAuditCommand(['--bogus'], {
      loadRecords: seeded,
      out: cap.out,
    });
    expect(code).toBe(2);
  });
});

describe('kubic audit prod secrets wiring (issue #79 fix cycle 1)', () => {
  it('redacts a listed-inventory value supplied via the prod loadSecrets hook', async () => {
    const cap = capture();
    const code = await runAuditCommand(['--json'], {
      loadRecords: seeded,
      loadSecrets: () => [FAUX_LISTED],
      out: cap.out,
    });
    expect(code).toBe(0);
    const text = cap.lines.join('\n');
    expect(text).not.toContain(FAUX_LISTED);
    expect(text).toContain(REDACTED_SECRET);
  });

  it('redacts secret-shaped material in unknown filter-value errors', async () => {
    const cap = capture();
    const code = await runAuditCommand(['--mode', FAUX_SHAPED], {
      loadRecords: seeded,
      out: cap.out,
    });
    expect(code).toBe(2);
    const text = cap.lines.join('\n');
    expect(text).not.toContain(FAUX_SHAPED);
    expect(text).toContain(REDACTED_SECRET);
  });
});
