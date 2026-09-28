// Prod runner wiring for the analysis surfaces: the runners must read the
// user's working directory and the SAME installed policy `kubic run` and
// `kubic doctor` use — not a filesystem root, not an empty policy.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeExport } from '../../../packages/eval/src/rl/fixtures.js';
import { installedPolicyPosture } from '../../../packages/host/src/approvals.js';
import {
  appendToLedger,
  auditLedgerDir,
  soloDecisionAudit,
} from '../../../packages/host/src/policy/audit-ledger.js';
import type { CliConfigResult } from './config-runtime.js';
import { createProdRunners } from './prod-runners.js';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const noConfig: CliConfigResult = {
  runtime: undefined,
  error: undefined,
  ignoreSplit: { missing: [], checked: [], applicable: false },
};

// The prod runners colour from the real stdout; NO_COLOR pins plain text
// whatever terminal the test runner has.
function runners(): {
  lines: string[];
  errs: string[];
  r: ReturnType<typeof createProdRunners>;
} {
  vi.stubEnv('NO_COLOR', '1');
  const lines: string[] = [];
  const errs: string[] = [];
  return {
    lines,
    errs,
    r: createProdRunners({
      out: (line) => lines.push(line),
      debug: (line) => errs.push(line),
    }),
  };
}

describe('kubic export (prod wiring)', () => {
  it('resolves a relative --trajectory against the working directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prod-export-'));
    roots.push(dir);
    writeFileSync(join(dir, 'rel.json'), JSON.stringify(makeExport()));
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    const { lines, errs, r } = runners();
    expect(await r.export({ trajectory: 'rel.json' }, noConfig)).toBe(0);
    expect(errs).toEqual([]);
    expect(lines.join('\n')).toMatch(/^schema: /);
  });
});

describe('kubic policy (prod wiring)', () => {
  it('agrees with the installed policy doctor reports and run enforces', async () => {
    const { allowlist } = installedPolicyPosture({ workspace: process.cwd() });
    expect(allowlist.length).toBeGreaterThan(0);
    for (const tool of allowlist) {
      const { lines, r } = runners();
      await r.policy({ tool }, noConfig);
      expect(lines).toEqual([`allow ${tool}`]);
    }
    const { lines, r } = runners();
    await r.policy({ tool: 'network_fetch' }, noConfig);
    expect(lines).toEqual(['deny network_fetch']);
  });
});

describe('kubic audit (prod wiring)', () => {
  it('reads the repo §60 ledger the approval layers write', async () => {
    const root = mkdtempSync(join(tmpdir(), 'prod-audit-'));
    roots.push(root);
    appendToLedger(
      auditLedgerDir(root),
      soloDecisionAudit({
        sessionId: 's',
        toolName: 'bash',
        trigger: 'destructive-shell',
        workspace: root,
        approved: true,
        posture: 'approvals',
      }),
    );
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    const { lines, r } = runners();
    await r.audit({ mode: 'solo', json: true }, noConfig);
    const records = JSON.parse(lines.join('\n')) as { mode: string }[];
    expect(records.map((record) => record.mode)).toEqual(['solo']);
    const text = runners();
    await text.r.audit({ mode: 'solo' }, noConfig);
    expect(text.lines).toHaveLength(1);
    expect(text.lines[0]).toMatch(/^WHEN +MODE/);
    expect(text.lines[0]).toMatch(/ solo +approvals /);
  });
});

describe('kubic audit from a subdirectory', () => {
  it('reads the ledger at the repo root, where orchestrate writes it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'prod-audit-sub-'));
    roots.push(root);
    mkdirSync(join(root, '.git'));
    mkdirSync(join(root, 'pkg'));
    appendToLedger(
      auditLedgerDir(root),
      soloDecisionAudit({
        sessionId: 's',
        toolName: 'bash',
        trigger: 'destructive-shell',
        workspace: root,
        approved: true,
        posture: 'approvals',
      }),
    );
    vi.spyOn(process, 'cwd').mockReturnValue(join(root, 'pkg'));
    const { lines, r } = runners();
    await r.audit({ json: true }, noConfig);
    expect(lines.join('\n')).toContain('"mode": "solo"');
  });
});
