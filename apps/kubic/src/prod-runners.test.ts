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
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const noConfig: CliConfigResult = {
  runtime: undefined,
  error: undefined,
  ignoreSplit: { missing: [], checked: [], applicable: false },
};

function runners(): {
  lines: string[];
  r: ReturnType<typeof createProdRunners>;
} {
  const lines: string[] = [];
  return {
    lines,
    r: createProdRunners({
      out: (line) => lines.push(line),
      debug: () => undefined,
    }),
  };
}

describe('kubic export (prod wiring)', () => {
  it('resolves a relative --trajectory against the working directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prod-export-'));
    roots.push(dir);
    writeFileSync(join(dir, 'rel.json'), JSON.stringify(makeExport()));
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    const { lines, r } = runners();
    await r.export(['--trajectory', 'rel.json'], noConfig);
    expect(lines.join('\n')).not.toMatch(/trajectory-unreadable/);
  });
});

describe('kubic policy (prod wiring)', () => {
  it('agrees with the installed policy doctor reports and run enforces', async () => {
    const { allowlist } = installedPolicyPosture({ workspace: process.cwd() });
    expect(allowlist.length).toBeGreaterThan(0);
    for (const tool of allowlist) {
      const { lines, r } = runners();
      await r.policy(['--tool', tool], noConfig);
      expect(lines).toEqual([`allow ${tool}`]);
    }
    const { lines, r } = runners();
    await r.policy(['--tool', 'network_fetch'], noConfig);
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
    await r.audit(['--mode', 'solo'], noConfig);
    expect(lines.join('\n')).not.toBe('no audit records');
    expect(lines.join('\n')).toContain('"mode":"solo"');
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
    await r.audit([], noConfig);
    expect(lines.join('\n')).toContain('"mode":"solo"');
  });
});
