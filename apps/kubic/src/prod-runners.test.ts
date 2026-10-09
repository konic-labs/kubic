import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeExport } from '@kubic/eval/test-support/fixtures';
import { FileJournalStore } from '@kubic/exec/journal';
import { disposeAllGitSandboxes } from '@kubic/exec/test-support/git-sandbox';
import { installedPolicyPosture } from '@kubic/host/approvals';
import {
  appendToLedger,
  auditLedgerDir,
  decisionAudit,
} from '@kubic/host/audit';
import { NO_PROJECT_TRUST } from '@kubic/host/config';
import { defaultSessionsRoot } from '@kubic/host/sessions';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CliConfigResult } from './config/load.js';
import { loadCliConfig } from './config/load.js';
import { createProdRunners } from './prod-runners.js';

const roots: string[] = [];

afterEach(() => {
  disposeAllGitSandboxes();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
  // The default sessions root lives under the temp HOME: runs and
  // retention tests seed it, so sweep it too (nothing in this file
  // carries a session across tests).
  rmSync(defaultSessionsRoot(), { recursive: true, force: true });
});

const noConfig: CliConfigResult = {
  runtime: undefined,
  error: undefined,
  ignoreSplit: { missing: [], checked: [], applicable: false },
  trust: NO_PROJECT_TRUST,
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
    expect(
      (await r.export({ trajectory: 'rel.json' }, noConfig)).exitCode,
    ).toBe(0);
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
      expect(lines).toEqual([`allow ${tool} (installed)`]);
    }
    const { lines, r } = runners();
    await r.policy({ tool: 'network_fetch' }, noConfig);
    expect(lines).toEqual(['deny network_fetch (installed)']);
  });

  it('fails closed with the named reason when the config load was refused', async () => {
    const { lines, errs, r } = runners();
    const code = (
      await r.policy(
        { tool: 'bash' },
        {
          runtime: undefined,
          error: "layer 'enterprise': unknown key 'bogus_key'",
          ignoreSplit: { missing: [], checked: [], applicable: false },
          trust: NO_PROJECT_TRUST,
        },
      )
    ).exitCode;
    expect(code).toBe(1);
    expect(lines).toEqual([]);
    expect(errs).toEqual([
      "error: layer 'enterprise': unknown key 'bogus_key'",
    ]);
  });
});

describe('kubic audit (prod wiring)', () => {
  it('reads the repo ledger the approval layers write', async () => {
    const root = mkdtempSync(join(tmpdir(), 'prod-audit-'));
    roots.push(root);
    appendToLedger(
      auditLedgerDir(root),
      decisionAudit({
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
    await r.audit({ json: true }, noConfig);
    const records = JSON.parse(lines.join('\n')) as { posture: string }[];
    expect(records.map((record) => record.posture)).toEqual(['approvals']);
    const text = runners();
    await text.r.audit({}, noConfig);
    expect(text.lines).toHaveLength(1);
    expect(text.lines[0]).toMatch(/^WHEN +POSTURE/);
    expect(text.lines[0]).toMatch(/ approvals +/);
  });
});

describe('kubic audit from a subdirectory', () => {
  it('reads the ledger at the repo root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'prod-audit-sub-'));
    roots.push(root);
    mkdirSync(join(root, '.git'));
    mkdirSync(join(root, 'pkg'));
    appendToLedger(
      auditLedgerDir(root),
      decisionAudit({
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
    expect(lines.join('\n')).toContain('"posture": "approvals"');
  });
});

describe('kubic doctor: enterprise policy and detection-only', () => {
  function providerFixture(root: string, port: number): void {
    writeFileSync(
      join(root, 'models.json'),
      JSON.stringify({
        providers: [
          {
            id: 'gw',
            baseUrl: `http://127.0.0.1:${port}/v1`,
            api: 'openai-completions',
            apiKeyEnv: 'GW_API_KEY',
            models: [{ id: 'm1' }],
          },
        ],
      }),
    );
  }

  it('the default install names the lexical classes and stays exit 0', async () => {
    const root = mkdtempSync(join(tmpdir(), 'prod-doctor-default-'));
    roots.push(root);
    providerFixture(root, 9102);
    vi.stubEnv('GW_API_KEY', 'sk-doctor-not-a-real-key');
    vi.stubEnv('KUBIC_MODEL', 'gw/m1');
    vi.stubEnv('KUBIC_TRUST_PROJECT', '1');
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    const config = loadCliConfig({
      cwd: root,
      home: root,
      env: {
        ...process.env,
        GW_API_KEY: 'sk-doctor-not-a-real-key',
        KUBIC_MODEL: 'gw/m1',
        KUBIC_TRUST_PROJECT: '1',
      },
    });
    const { lines, r } = runners();
    const code = (await r.doctor({ json: true }, config)).exitCode;
    const report = JSON.parse(lines.join('\n')) as {
      checks: Array<{ id: string; status: string; detail: string }>;
    };
    const detection = report.checks.find(
      (entry) => entry.id === 'policy:detection-only',
    );
    expect(detection?.status).toBe('warn');
    expect(detection?.detail).toContain('network=none');
    // No `[policy]` section: the enterprise checks are not wired at all.
    expect(report.checks.map((entry) => entry.id)).not.toContain(
      'policy:enterprise-network',
    );
    expect(code).toBe(0);
  });

  it('a configured [policy] runs the enterprise checks in --json', async () => {
    const root = mkdtempSync(join(tmpdir(), 'prod-doctor-policy-'));
    roots.push(root);
    providerFixture(root, 9103);
    mkdirSync(join(root, '.kubic'), { recursive: true });
    writeFileSync(
      join(root, '.kubic', 'config.toml'),
      '[policy]\nnetwork_policy = "proxy"\n',
    );
    vi.stubEnv('KUBIC_TRUST_PROJECT', '1');
    vi.stubEnv('GW_API_KEY', 'sk-doctor-not-a-real-key');
    vi.stubEnv('KUBIC_MODEL', 'gw/m1');
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    const config = loadCliConfig({
      cwd: root,
      home: root,
      env: {
        ...process.env,
        KUBIC_TRUST_PROJECT: '1',
        GW_API_KEY: 'sk-doctor-not-a-real-key',
        KUBIC_MODEL: 'gw/m1',
      },
    });
    const { lines, r } = runners();
    const code = (await r.doctor({ json: true }, config)).exitCode;
    const report = JSON.parse(lines.join('\n')) as {
      checks: Array<{
        id: string;
        status: string;
        reason: string;
        detail: string;
      }>;
    };
    const network = report.checks.find(
      (entry) => entry.id === 'policy:enterprise-network',
    );
    expect(network?.status).toBe('fail');
    expect(network?.reason).toBe('policy-mismatch');
    expect(network?.detail).toContain('no domains');
    expect(report.checks.map((entry) => entry.id)).toContain(
      'policy:enterprise-enforceability',
    );
    // The unenforceable value flips the exit (fail, not warn).
    expect(code).toBe(1);
  });
});

describe('kubic doctor --session (prod wiring)', () => {
  it('refuses a session id that cannot name a session directory', async () => {
    const { errs, r } = runners();
    expect((await r.doctor({ session: '../evil' }, noConfig)).exitCode).toBe(2);
    expect(errs.join('\n')).toContain('invalid --session id');
  });
});

// Config `[session] retentionDays` reaches the runners that prune (replaces the
// source-regex wiring pins with behaviour through createProdRunners — an aged
// session is pruned, an aged entry healed).
describe('kubic sessions/journal retention (prod wiring)', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;

  // A home global layer setting `[session] retentionDays` (the project
  // layer would need a trust grant first), loaded through the
  // composition root's own config seam.
  function configWithRetention(
    days: number,
    section: 'session' | 'journal' = 'session',
  ): CliConfigResult {
    const home = mkdtempSync(join(tmpdir(), 'prod-ret-home-'));
    roots.push(home);
    mkdirSync(join(home, '.kubic'), { recursive: true });
    writeFileSync(
      join(home, '.kubic', 'config.toml'),
      `[${section}]\nretentionDays = ${days}\n`,
    );
    const cwd = mkdtempSync(join(tmpdir(), 'prod-ret-cwd-'));
    roots.push(cwd);
    const loaded = loadCliConfig({ cwd, home, env: {} });
    expect(loaded.error).toBeUndefined();
    return loaded;
  }

  // A session-state dir shaped like the prune plan reads it, aged by ageMs.
  function agedSession(root: string, id: string, ageMs: number): void {
    const dir = join(root, id);
    mkdirSync(join(dir, 'journal'), { recursive: true });
    writeFileSync(join(dir, 'main.jsonl'), '');
    writeFileSync(join(dir, 'journal', 'index.jsonl'), 'index!!');
    writeFileSync(join(dir, 'spans.jsonl'), 'spans');
    const secs = (Date.now() - ageMs) / 1000;
    utimesSync(dir, secs, secs);
  }

  it('sessions prune deletes an aged session under the configured window', async () => {
    const config = configWithRetention(30);
    // The runner reads the default sessions root (a temp HOME under test).
    const sroot = defaultSessionsRoot();
    mkdirSync(sroot, { recursive: true });
    agedSession(sroot, 'aged-prune', 31 * DAY_MS);
    const { lines, r } = runners();
    expect(
      (await r.sessions({ command: 'prune', yes: true }, config)).exitCode,
    ).toBe(0);
    expect(existsSync(join(sroot, 'aged-prune'))).toBe(false);
    expect(lines.join('\n')).toContain('pruned aged-prune');
  });

  it('journal log heals aged entries under the same window', async () => {
    const config = configWithRetention(7);
    const sroot = defaultSessionsRoot();
    const journalDir = join(sroot, 'sess-journal', 'journal');
    const store = new FileJournalStore(journalDir);
    store.append({
      path: 'aged.txt',
      op: 'write',
      before: 'old\n',
      after: 'older\n',
      bytesDelta: 0,
      sessionId: 'sess-journal',
      toolCallId: 'call-aged',
      timestamp: Date.now() - 30 * DAY_MS,
    });
    store.append({
      path: 'fresh.txt',
      op: 'write',
      before: 'new\n',
      after: 'newer\n',
      bytesDelta: 0,
      sessionId: 'sess-journal',
      toolCallId: 'call-fresh',
      timestamp: Date.now(),
    });
    const { lines, r } = runners();
    expect(
      (await r.journal({ command: 'log', session: 'sess-journal' }, config))
        .exitCode,
    ).toBe(0);
    const text = lines.join('\n');
    expect(text).toContain('fresh.txt');
    expect(text).not.toContain('aged.txt');
    expect(
      new FileJournalStore(journalDir).entries().map((entry) => entry.path),
    ).toEqual(['fresh.txt']);
  });

  it('journal prune takes its default keep window from [journal] retentionDays', async () => {
    const config = configWithRetention(7, 'journal');
    const journalDir = join(defaultSessionsRoot(), 'sess-prune', 'journal');
    const store = new FileJournalStore(journalDir);
    store.append({
      path: 'aged.txt',
      op: 'write',
      before: 'old\n',
      after: 'older\n',
      bytesDelta: 0,
      sessionId: 'sess-prune',
      toolCallId: 'call-aged',
      timestamp: Date.now() - 30 * DAY_MS,
    });
    store.append({
      path: 'fresh.txt',
      op: 'write',
      before: 'new\n',
      after: 'newer\n',
      bytesDelta: 0,
      sessionId: 'sess-prune',
      toolCallId: 'call-fresh',
      timestamp: Date.now(),
    });
    const { lines, r } = runners();
    // No --yes: the window is applied, the dry run lists the aged entry, and
    // nothing is deleted.
    expect(
      (await r.journal({ command: 'prune', session: 'sess-prune' }, config))
        .exitCode,
    ).toBe(0);
    expect(lines.join('\n')).toContain('dry run: 1 entry would be pruned');
    expect(new FileJournalStore(journalDir).entries()).toHaveLength(2);
    expect(
      (
        await r.journal(
          { command: 'prune', session: 'sess-prune', yes: true },
          config,
        )
      ).exitCode,
    ).toBe(0);
    expect(
      new FileJournalStore(journalDir).entries().map((entry) => entry.path),
    ).toEqual(['fresh.txt']);
  });
});

// The models/doctor wiring through createProdRunners: a
// broken project models.json is reported exactly once, and the roles
// probe `kubic doctor` injects is visible in its report — the two
// behaviours the deleted source-regex pins stood in for.
describe('kubic models/doctor (prod wiring)', () => {
  it('prints a broken project models.json note exactly once', async () => {
    const root = mkdtempSync(join(tmpdir(), 'prod-models-note-'));
    roots.push(root);
    writeFileSync(join(root, 'models.json'), '{ not json');
    vi.stubEnv('KUBIC_TRUST_PROJECT', '1');
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    const config = loadCliConfig({
      cwd: root,
      home: root,
      env: { ...process.env, KUBIC_TRUST_PROJECT: '1' },
    });
    expect(config.error).toBeUndefined();
    const { lines, errs, r } = runners();
    expect((await r.models({}, config)).exitCode).toBe(0);
    const notes = [...lines, ...errs].filter((line) =>
      line.includes('models.json ignored:'),
    );
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('models.json');
  });

  it('reports the roles probe: a contradictory role document fails by name', async () => {
    const root = mkdtempSync(join(tmpdir(), 'prod-doctor-roles-'));
    roots.push(root);
    mkdirSync(join(root, '.kubic', 'roles'), { recursive: true });
    writeFileSync(
      join(root, '.kubic', 'roles', 'liar.md'),
      '---\nrole: liar\ntools: [read, write]\nfilesystem: read\nshell: false\nnetwork: none\ngit: false\ncredentials: none\n---\n\n# liar\n\nGo.\n',
    );
    vi.stubEnv('KUBIC_TRUST_PROJECT', '1');
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    const config = loadCliConfig({
      cwd: root,
      home: root,
      env: { ...process.env, KUBIC_TRUST_PROJECT: '1' },
    });
    expect(config.error).toBeUndefined();
    const { lines, r } = runners();
    // A failing probe flips the exit code: the wiring carries the
    // refusal all the way to the process result, not just the report.
    expect((await r.doctor({ json: true }, config)).exitCode).toBe(6);
    const report = JSON.parse(lines.join('\n')) as {
      checks: Array<{ id: string; status: string; detail?: string }>;
    };
    const liar = report.checks.find((entry) => entry.id === 'role:liar');
    expect(liar?.status).toBe('fail');
    expect(liar?.detail ?? '').toMatch(
      /filesystem is 'read' but write tool 'write'/,
    );
  });
});
