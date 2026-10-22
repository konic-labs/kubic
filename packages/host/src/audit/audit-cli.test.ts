// `kubic audit` CLI tests: the record fields, sentinel-only credentials,
// the filters and redaction. Records are injected; the command redacts
// before printing. Faux-only — shape-matching values below carry a FAUX
// marker and stay inert.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  containsSecretShape,
  REDACTED_SECRET,
} from '@kubic/core/secret-shapes';
import { createNodeFileBridge } from '@kubic/exec/file-bridge';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../../test/temp-dir.js';
import { EXAMPLE_AUDIT_RECORD } from '../test-support/audit-fixtures.js';
import { capture } from '../test-support/capture.js';
import { appendChainedAuditLine } from './chain.js';
import {
  AUDIT_FIELDS,
  fullAccessEnabledAudit,
  type OrgAuditRecord,
  runAuditCommand,
  runAuditFlushCommand,
  runAuditVerifyCommand,
  undoRestoreAudit,
} from './index.js';

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
      process: { ...EXAMPLE_AUDIT_RECORD.process },
      workspace: { ...EXAMPLE_AUDIT_RECORD.workspace },
      permission: { ...EXAMPLE_AUDIT_RECORD.permission },
      credential: { ...EXAMPLE_AUDIT_RECORD.credential },
      network: { ...EXAMPLE_AUDIT_RECORD.network },
      reason: `policy allow (saw ${FAUX_SHAPED} and ${FAUX_LISTED} on the wire)`,
    },
  ];
}

describe('kubic audit secret backstop', () => {
  it('prints zero secret-shaped values on a faux-seeded fixture', async () => {
    const cap = capture();
    const code = (
      await runAuditCommand(
        {},
        {
          loadRecords: seeded,
          secrets: [FAUX_LISTED],
          out: cap.out,
          err: cap.err,
        },
      )
    ).exitCode;
    expect(code).toBe(0);
    const text = cap.lines.join('\n');
    expect(containsSecretShape(text)).toBe(false);
    expect(text).not.toContain(FAUX_SHAPED);
    expect(text).not.toContain(FAUX_LISTED);
    expect(text).toContain(REDACTED_SECRET);
  });

  it('redacts the same way under --json', async () => {
    const cap = capture();
    const code = (
      await runAuditCommand(
        { json: true },
        {
          loadRecords: seeded,
          secrets: [FAUX_LISTED],
          out: cap.out,
          err: cap.err,
        },
      )
    ).exitCode;
    expect(code).toBe(0);
    const text = cap.lines.join('\n');
    expect(containsSecretShape(text)).toBe(false);
    expect(text).not.toContain(FAUX_SHAPED);
    expect(text).not.toContain(FAUX_LISTED);
    const parsed = JSON.parse(text) as OrgAuditRecord[];
    expect(parsed).toHaveLength(1);
    const head = parsed[0];
    if (head === undefined) throw new Error('missing audit record');
    expect(Object.keys(head).sort()).toEqual(
      ['version', ...AUDIT_FIELDS].sort(),
    );
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

describe('kubic audit query', () => {
  const TWO: OrgAuditRecord[] = [
    EXAMPLE_AUDIT_RECORD,
    {
      ...EXAMPLE_AUDIT_RECORD,
      agent: { ...EXAMPLE_AUDIT_RECORD.agent },
      model: { ...EXAMPLE_AUDIT_RECORD.model },
      process: { ...EXAMPLE_AUDIT_RECORD.process },
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
    const code = (
      await runAuditCommand(
        { posture: 'full-access', result: 'deny' },
        { loadRecords: () => TWO, out: cap.out, err: cap.err },
      )
    ).exitCode;
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
    const code = (
      await runAuditCommand(
        { session: 's-1', json: true },
        { loadRecords: () => rows, out: cap.out, err: cap.err },
      )
    ).exitCode;
    expect(code).toBe(0);
    const printed = JSON.parse(cap.lines[0] ?? '[]') as OrgAuditRecord[];
    expect(printed.map((record) => record.what)).toEqual([
      'tool:bash',
      'undo-restore',
    ]);
  });

  it('exits 2 on a whitespace-only session filter, like the other filters', async () => {
    const cap = capture();
    const code = (
      await runAuditCommand(
        { session: '   ' },
        { loadRecords: () => TWO, out: cap.out, err: cap.err },
      )
    ).exitCode;
    expect(code).toBe(2);
    expect(cap.errs.join('\n')).toMatch(/session/);
  });

  it('reports no audit records on an empty store', async () => {
    const cap = capture();
    const code = (
      await runAuditCommand(
        {},
        {
          loadRecords: () => [],
          out: cap.out,
          err: cap.err,
        },
      )
    ).exitCode;
    expect(code).toBe(0);
    expect(cap.lines).toEqual(['no audit records']);
  });
});

it('returns the privileged-action rows under --json with every field', async () => {
  const when = '2023-11-14T22:13:20.000Z';
  const records: OrgAuditRecord[] = [
    {
      version: 1,
      ...fullAccessEnabledAudit({
        sessionId: 'sess',
        command: 'kubic run --dangerously-skip-approvals',
        workspace: '/repo',
      }),
      when,
    },
    {
      version: 1,
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
  const code = (
    await runAuditCommand(
      { json: true },
      { loadRecords: () => records, out: cap.out, err: cap.err },
    )
  ).exitCode;
  expect(code).toBe(0);
  const parsed = JSON.parse(cap.lines.join('\n')) as OrgAuditRecord[];
  expect(parsed.map((row) => row.what)).toEqual([
    'posture:full-access',
    'undo-restore',
  ]);
  for (const row of parsed) {
    expect(Object.keys(row).sort()).toEqual(
      ['version', ...AUDIT_FIELDS].sort(),
    );
  }
});

describe('kubic audit usage', () => {
  it('exits 2 on an unknown result, naming the choices', async () => {
    const cap = capture();
    const code = (
      await runAuditCommand(
        { result: 'maybe' },
        {
          loadRecords: seeded,
          out: cap.out,
          err: cap.err,
        },
      )
    ).exitCode;
    expect(code).toBe(2);
    expect(cap.lines).toEqual([]);
    expect(cap.errs).toEqual([
      'error: unknown result "maybe" (want ok|deny|error)',
    ]);
  });

  // Argv syntax (a filter without a value, unknown flags, --help) is
  // commander's: apps/kubic/src/commands/analysis.test.ts pins it.
});

describe('kubic audit prod secrets wiring', () => {
  it('redacts a listed-inventory value supplied via the prod loadSecrets hook', async () => {
    const cap = capture();
    const code = (
      await runAuditCommand(
        { json: true },
        {
          loadRecords: seeded,
          loadSecrets: () => [FAUX_LISTED],
          out: cap.out,
          err: cap.err,
        },
      )
    ).exitCode;
    expect(code).toBe(0);
    const text = cap.lines.join('\n');
    expect(text).not.toContain(FAUX_LISTED);
    expect(text).toContain(REDACTED_SECRET);
  });

  it('redacts secret-shaped material in unknown filter-value errors', async () => {
    const cap = capture();
    const code = (
      await runAuditCommand(
        { result: FAUX_SHAPED },
        {
          loadRecords: seeded,
          out: cap.out,
          err: cap.err,
        },
      )
    ).exitCode;
    expect(code).toBe(2);
    const text = cap.errs.join('\n');
    expect(text).not.toContain(FAUX_SHAPED);
    expect(text).toContain(REDACTED_SECRET);
  });
});

describe('kubic audit time range and formats', () => {
  const at = (when: string, what: string): OrgAuditRecord => ({
    ...EXAMPLE_AUDIT_RECORD,
    agent: { ...EXAMPLE_AUDIT_RECORD.agent },
    model: { ...EXAMPLE_AUDIT_RECORD.model },
    process: { ...EXAMPLE_AUDIT_RECORD.process },
    workspace: { ...EXAMPLE_AUDIT_RECORD.workspace },
    permission: { ...EXAMPLE_AUDIT_RECORD.permission },
    credential: { ...EXAMPLE_AUDIT_RECORD.credential },
    network: { ...EXAMPLE_AUDIT_RECORD.network },
    when,
    what,
  });
  const RECORDS = [
    at('2026-10-01T00:00:00.000Z', 'tool:old'),
    at('2026-10-20T12:00:00.000Z', 'tool:recent'),
    at('2026-10-21T09:00:00.000Z', '=HYPERLINK("x")'),
  ];
  const now = () => Date.parse('2026-10-21T10:00:00.000Z');

  async function run(options: Parameters<typeof runAuditCommand>[0]) {
    const cap = capture();
    const code = (
      await runAuditCommand(options, {
        loadRecords: () => RECORDS,
        now,
        out: cap.out,
        err: cap.err,
      })
    ).exitCode;
    return { code, ...cap };
  }

  it('keeps the records inside --since and --until, absolute or as an age', async () => {
    const recent = await run({ since: '2d', format: 'jsonl' });
    expect(recent.code).toBe(0);
    expect(
      recent.lines.map((line) => (JSON.parse(line) as OrgAuditRecord).what),
    ).toEqual(['tool:recent', '=HYPERLINK("x")']);
    const window = await run({
      since: '2026-10-01',
      until: '2026-10-21T00:00:00Z',
      format: 'json',
    });
    expect(
      (JSON.parse(window.lines.join('\n')) as OrgAuditRecord[]).map(
        (record) => record.what,
      ),
    ).toEqual(['tool:old', 'tool:recent']);
  });

  it('prints CSV with a header, quoting and defused formulas', async () => {
    const csv = await run({ format: 'csv' });
    const rows = (csv.lines[0] ?? '').split('\n');
    expect(rows[0]).toBe(
      'when,who,what,session,role,provider,model,posture,permission,approval,result,reason,workspace',
    );
    expect(rows).toHaveLength(4);
    expect(rows[3]).toContain(`"'=HYPERLINK(""x"")"`);
  });

  it('refuses an unknown time, an unknown format and --json with another format', async () => {
    expect((await run({ since: 'yesterday' })).errs.join('\n')).toContain(
      'unknown time "yesterday" for --since',
    );
    expect((await run({ format: 'xml' })).code).toBe(2);
    expect((await run({ format: 'csv', json: true })).code).toBe(2);
  });
});

describe('kubic audit verify and flush', () => {
  it('reports an intact ledger and names the line of a broken one', () => {
    const dir = tempDir('audit-verify-');
    const bridge = createNodeFileBridge(dir);
    for (const what of ['run:start', 'tool:bash']) {
      appendChainedAuditLine(bridge, dir, 'audit.jsonl', {
        ...EXAMPLE_AUDIT_RECORD,
        what,
      });
    }
    const ledgerPath = join(dir, 'audit.jsonl');
    const intact = capture();
    expect(
      runAuditVerifyCommand(
        {},
        { ledgerPath, out: intact.out, err: intact.err },
      ).exitCode,
    ).toBe(0);
    expect(intact.lines[0]).toMatch(
      new RegExp(
        `^audit ledger ${ledgerPath}: intact — 2 record\\(s\\), head sha256:[0-9a-f]{64}$`,
      ),
    );
    writeFileSync(
      ledgerPath,
      readFileSync(ledgerPath, 'utf8').replace('tool:bash', 'tool:read'),
    );
    const broken = capture();
    expect(
      runAuditVerifyCommand(
        {},
        { ledgerPath, out: broken.out, err: broken.err },
      ).exitCode,
    ).toBe(1);
    expect(broken.errs.join('\n')).toContain(
      `audit ledger ${ledgerPath}: line 2 was changed after it was written`,
    );
  });

  it('says how much each collector delivered and what still waits', async () => {
    const none = capture();
    expect(
      (await runAuditFlushCommand({ ...none, flush: async () => [] })).exitCode,
    ).toBe(0);
    expect(none.lines).toEqual([
      'no collector sinks configured: nothing is spooled',
    ]);
    const waiting = capture();
    expect(
      (
        await runAuditFlushCommand({
          ...waiting,
          flush: async () => [
            { source: 'audit[1]', delivered: 2, pending: 0 },
            {
              source: 'audit[2]',
              delivered: 0,
              pending: 3,
              error: 'https://collector answered 503',
            },
          ],
        })
      ).exitCode,
    ).toBe(1);
    expect(waiting.lines).toEqual([
      'audit[1]: delivered 2, 0 waiting',
      'audit[2]: delivered 0, 3 waiting',
    ]);
  });
});
