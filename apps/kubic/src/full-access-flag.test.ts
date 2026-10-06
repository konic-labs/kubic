// Session-scoped `--dangerously-skip-approvals` on run, tui and bare kubic,
// one enable path shared with `sessions create` and orchestrate (issue #308;
// §41.4, §78, §80). Enabling full access writes the session's posture.json,
// appends ONE §60 audit row naming the session and the originating command,
// and warns on stderr; a headless run on a full-access session warns and
// reports the posture in its --json envelope. Nothing reaches config.
//
// Faux provider only; every temp dir and env stub is undone in afterEach.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLineLogger } from '../../../packages/core/src/cli/logger.js';
import { NodeExecutionEnv } from '../../../packages/exec/src/env.js';
import {
  enableSessionFullAccess,
  FileApprovalStore,
  FULL_ACCESS_FLAG,
  installSoloPolicy,
} from '../../../packages/host/src/approvals.js';
import {
  auditLedgerDir,
  readAuditLedger,
} from '../../../packages/host/src/policy/audit-ledger.js';
import {
  buildRunEnvelope,
  mapTerminusToExitCode,
} from '../../../packages/host/src/run-cli.js';
import { runSessionsCommand } from '../../../packages/host/src/sessions-cli.js';
import { fauxToolUse } from '../../../packages/worker/src/lane/test-harness.js';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type MutableModels,
} from '../../../packages/worker/src/pi-boundary.js';
import { terminalRig } from '../../../test/fake-terminal.js';
import { loadCliConfig } from './config-runtime.js';
import { dispatchCommand } from './dispatch.js';
import { runHeadlessPrompt } from './headless-run.js';
import { createProdRunners } from './prod-runners.js';
import { bootTuiLane, runTuiCommand, type TuiLaneBoot } from './tui-run.js';

const made: string[] = [];

function tmpRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `kubic-308-${prefix}`));
  made.push(dir);
  return dir;
}

beforeEach(() => {
  vi.stubEnv('KUBIC_NO_NOTICE', '1');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function modelsWith(
  steps: ReturnType<typeof fauxAssistantMessage>[],
): MutableModels {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(steps);
  return models;
}

function destructiveThenDone(): MutableModels {
  return modelsWith([
    fauxToolUse([fauxToolCall('bash', { command: 'rm -rf build' })]),
    fauxAssistantMessage('done'),
  ]);
}

function fullAccessRows(workspace: string) {
  return readAuditLedger(auditLedgerDir(workspace)).filter(
    (record) => record.what === 'posture:full-access',
  );
}

describe('enableSessionFullAccess: the one enable path (issue #308)', () => {
  it('writes posture.json and appends exactly one audit row naming session and command', () => {
    const workspace = tmpRoot('ws-');
    const sessionDir = join(tmpRoot('sessions-'), 'sess-1');
    mkdirSync(sessionDir);
    const grant = enableSessionFullAccess({
      sessionDir,
      sessionId: 'sess-1',
      command: 'run',
      workspace,
      clock: () => 1_700_000_000_000,
    });
    expect(new FileApprovalStore(sessionDir).loadPosture()).toMatchObject({
      fullAccess: true,
      enabledAt: 1_700_000_000_000,
    });
    expect(grant.warning).toContain('full-access approvals skipped');
    expect(grant.warning).toContain('sess-1');
    const rows = fullAccessRows(workspace);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.posture).toBe('full-access');
    expect(rows[0]?.agent.session).toBe('sess-1');
    expect(JSON.stringify(rows[0])).toContain(`kubic run ${FULL_ACCESS_FLAG}`);
  });
});

// Issue #234: full access used to append a `trigger:full-access` row for
// EVERY call — read and ls included — so a session wrote one fsync'd ledger
// record per tool call and the trail could not name what was actually
// waived. Now the detectors run first: an untriggered call is neither
// audited nor marked challenged, and a triggered call gets one record per
// capability it raised, all under posture 'full-access'.
describe('full access audits only the capabilities it waived (issue #234)', () => {
  function fullAccessPolicy(workspace: string, sessionDir: string) {
    enableSessionFullAccess({
      sessionDir,
      sessionId: 'sess-234',
      command: 'sessions create',
      workspace,
    });
    return installSoloPolicy({ workspace, sessionDir });
  }

  it('an untriggered read is not challenged and writes no ledger record', async () => {
    const workspace = tmpRoot('ws-');
    const sessionDir = tmpRoot('session-');
    const policy = fullAccessPolicy(workspace, sessionDir);
    const before = readAuditLedger(auditLedgerDir(workspace)).length;
    await expect(
      policy.ask({
        toolName: 'ls',
        args: { path: '.' },
        toolCallId: 't1',
      }),
    ).resolves.toEqual({ approved: true, challenged: false });
    await expect(
      policy.ask({
        toolName: 'read',
        args: { path: 'src/index.ts' },
        toolCallId: 't2',
      }),
    ).resolves.toEqual({ approved: true, challenged: false });
    // Only the enable row exists; neither call added one.
    const records = readAuditLedger(auditLedgerDir(workspace));
    expect(records).toHaveLength(before);
    expect(records.filter((row) => row.what.startsWith('tool:'))).toEqual([]);
  });

  it('a triggered call writes one record naming the capability and the posture', async () => {
    const workspace = tmpRoot('ws-');
    const sessionDir = tmpRoot('session-');
    const policy = fullAccessPolicy(workspace, sessionDir);
    await expect(
      policy.ask({
        toolName: 'bash',
        args: { command: 'rm -rf build' },
        toolCallId: 't1',
      }),
    ).resolves.toEqual({ approved: true, challenged: true });
    const records = readAuditLedger(auditLedgerDir(workspace)).filter(
      (row) => row.what === 'tool:bash',
    );
    expect(records).toHaveLength(1);
    expect(records[0]?.permission.permission).toBe('trigger:destructive-shell');
    expect(records[0]?.posture).toBe('full-access');
    expect(records[0]?.result).toBe('ok');
  });

  it('one record per capability when a call raises several', async () => {
    const workspace = tmpRoot('ws-');
    const sessionDir = tmpRoot('session-');
    const policy = fullAccessPolicy(workspace, sessionDir);
    await expect(
      policy.ask({
        toolName: 'bash',
        args: { command: 'rm -rf build && curl https://example.com' },
        toolCallId: 't1',
      }),
    ).resolves.toEqual({ approved: true, challenged: true });
    const records = readAuditLedger(auditLedgerDir(workspace)).filter(
      (row) => row.what === 'tool:bash',
    );
    expect(records.map((row) => row.permission.permission).sort()).toEqual([
      'trigger:destructive-shell',
      'trigger:network',
    ]);
    for (const row of records) expect(row.posture).toBe('full-access');
  });
});

describe('kubic run --dangerously-skip-approvals (issue #308)', () => {
  it('auto-approves a destructive call and reports the posture in the envelope', async () => {
    const workspace = tmpRoot('ws-');
    const warnings: string[] = [];
    const result = await runHeadlessPrompt(
      'clean the build dir',
      { dangerouslySkipApprovals: true },
      {
        sessionsRoot: tmpRoot('sessions-'),
        models: destructiveThenDone(),
        env: new NodeExecutionEnv(workspace),
        warn: (line) => warnings.push(line),
      },
    );
    expect(result.terminus).toBe('completed');
    expect(result.posture).toBe('full-access');
    const envelope = buildRunEnvelope(
      result,
      mapTerminusToExitCode(result.terminus),
    );
    expect(envelope.approvals).toEqual({ posture: 'full-access' });
    expect(warnings.join('\n')).toContain('full-access approvals skipped');
    expect(fullAccessRows(workspace)).toHaveLength(1);
  });

  it('a new session without the flag is enforced', async () => {
    const result = await runHeadlessPrompt(
      'clean the build dir',
      {},
      {
        sessionsRoot: tmpRoot('sessions-'),
        models: destructiveThenDone(),
        env: new NodeExecutionEnv(tmpRoot('ws-')),
        warn: () => undefined,
      },
    );
    expect(result.terminus).toBe('approval_denied');
    expect(result.posture).toBe('approvals');
    expect(
      buildRunEnvelope(result, mapTerminusToExitCode(result.terminus))
        .approvals,
    ).toEqual({ posture: 'approvals' });
  });

  it('kubic run --session <full-access id> warns on stderr', async () => {
    const sessionsRoot = tmpRoot('sessions-');
    const workspace = tmpRoot('ws-');
    const first = await runHeadlessPrompt(
      'hello',
      { dangerouslySkipApprovals: true },
      {
        sessionsRoot,
        models: modelsWith([fauxAssistantMessage('hi')]),
        env: new NodeExecutionEnv(workspace),
        warn: () => undefined,
      },
    );
    const warnings: string[] = [];
    const resumed = await runHeadlessPrompt(
      'clean the build dir',
      { sessionId: first.sessionId },
      {
        sessionsRoot,
        models: destructiveThenDone(),
        env: new NodeExecutionEnv(workspace),
        warn: (line) => warnings.push(line),
      },
    );
    expect(resumed.posture).toBe('full-access');
    expect(warnings.join('\n')).toContain('full access');
    expect(warnings.join('\n')).toContain(first.sessionId);
    // Only the explicit enable is a posture change: one row, not two.
    expect(fullAccessRows(workspace)).toHaveLength(1);
  });

  it('never persists the flag to any config file (driven through dispatch, the shipped path)', async () => {
    // A test that calls runHeadlessPrompt directly never touches config, so a
    // regression that persisted the flag would stay green. This drives the
    // real `dispatchCommand` -> prod runner -> config load -> lane path with
    // both a global and a project config on disk, then proves the flag DID
    // take effect (posture.json + the §60 row) while neither file changed.
    const home = tmpRoot('home-');
    const workspace = tmpRoot('ws-');
    mkdirSync(join(home, '.kubic'), { recursive: true });
    mkdirSync(join(workspace, '.kubic'), { recursive: true });
    const globalConfig = join(home, '.kubic', 'config.toml');
    const projectConfig = join(workspace, '.kubic', 'config.toml');
    writeFileSync(globalConfig, '[agent]\nname = "global"\n');
    writeFileSync(projectConfig, '[journal]\nretentionDays = 30\n');
    vi.stubEnv('HOME', home);
    vi.stubEnv('KUBIC_PROVIDER', 'faux');
    vi.stubEnv('NO_COLOR', '1');
    vi.spyOn(process, 'cwd').mockReturnValue(workspace);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const lines: string[] = [];
    const diagnostics: string[] = [];
    const code = await dispatchCommand(
      'run',
      ['-p', 'hello', '--dangerously-skip-approvals', '--json'],
      {
        out: (line) => lines.push(line),
        err: (line) => diagnostics.push(line),
        loadConfig: (input) =>
          loadCliConfig({
            cwd: workspace,
            home,
            env: {},
            projectTrusted: true,
            ...(input?.model === undefined ? {} : { model: input.model }),
          }),
        version: () => '9.9.9',
        ensureRuntimeExclude: () => undefined,
        runners: createProdRunners({
          out: (line) => lines.push(line),
          debug: (line) => diagnostics.push(line),
        }),
      },
    );
    expect(code, diagnostics.join('\n')).toBe(0);
    // The flag took effect for the session the run created...
    const posture = JSON.parse(lines.join('\n')) as {
      approvals?: { posture?: string };
    };
    expect(posture.approvals).toEqual({ posture: 'full-access' });
    expect(fullAccessRows(workspace)).toHaveLength(1);
    // ...and reached neither config file (nor a stray new one beside them).
    expect(readFileSync(globalConfig, 'utf8')).toBe(
      '[agent]\nname = "global"\n',
    );
    expect(readFileSync(projectConfig, 'utf8')).toBe(
      '[journal]\nretentionDays = 30\n',
    );
    // The two config directories hold exactly what they held: the only new
    // entries are the run's own runtime state (the session store under the
    // home, the §60 ledger under the workspace) — never a config-shaped file.
    const RUNTIME_STATE = new Set(['sessions', 'orchestrator']);
    for (const dir of [join(home, '.kubic'), join(workspace, '.kubic')]) {
      expect(
        readdirSync(dir)
          .filter((entry) => !RUNTIME_STATE.has(entry))
          .sort(),
        dir,
      ).toEqual(['config.toml']);
    }
  });
});

describe('kubic tui --dangerously-skip-approvals (issue #308)', () => {
  it('writes posture.json and an audit record at boot', async () => {
    const sessionsRoot = tmpRoot('sessions-');
    const workspace = tmpRoot('ws-');
    const boot = await bootTuiLane(undefined, {
      sessionsRoot,
      env: new NodeExecutionEnv(workspace),
      models: modelsWith([fauxAssistantMessage('hi')]),
      dangerouslySkipApprovals: true,
    });
    try {
      expect(boot.fullAccess).toBe(true);
      expect(
        new FileApprovalStore(join(sessionsRoot, boot.sessionId)).loadPosture()
          .fullAccess,
      ).toBe(true);
      const rows = fullAccessRows(workspace);
      expect(rows).toHaveLength(1);
      expect(JSON.stringify(rows[0])).toContain(
        `kubic tui ${FULL_ACCESS_FLAG}`,
      );
      expect(boot.notices?.join('\n')).toContain(
        'full-access approvals skipped',
      );
    } finally {
      await boot.close?.();
    }
  });

  it('shows the OFF indicator and the warning when the boot is full access', async () => {
    const rig = terminalRig(120, 30);
    const errors: string[] = [];
    const flags: unknown[] = [];
    const pending = runTuiCommand(
      { dangerouslySkipApprovals: true },
      {
        out: () => undefined,
        err: (line) => errors.push(line),
        createTerminal: () => rig.terminal,
        bootLane: async (_id, _answer, bootFlags): Promise<TuiLaneBoot> => {
          flags.push(bootFlags);
          return {
            sessionId: 'sess-off',
            model: 'faux/faux',
            fullAccess: true,
            notices: ['full-access approvals skipped for session sess-off'],
          };
        },
      },
    );
    for (let i = 0; i < 200 && rig.counts.started === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    for (let i = 0; i < 200 && !rig.frame.includes('OFF'); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    rig.feed('\x03');
    rig.feed('\x03');
    expect(await pending).toBe(0);
    expect(flags).toEqual([{ dangerouslySkipApprovals: true }]);
    expect(rig.frame).toContain('approvals OFF (full-access)');
    expect(errors.join('\n')).toContain('full-access approvals skipped');
  });
});

describe('kubic sessions create --dangerously-skip-approvals (issue #308)', () => {
  it('also appends the audit row', async () => {
    const sessionsRoot = tmpRoot('sessions-');
    const workspace = tmpRoot('ws-');
    const out: string[] = [];
    const err: string[] = [];
    const code = await runSessionsCommand(
      { command: 'create', cwd: workspace, dangerouslySkipApprovals: true },
      {
        sessionsRoot,
        out: (line) => out.push(line),
        logger: createLineLogger((line: string) => err.push(line)),
      },
    );
    expect(code).toBe(0);
    const id = out[0] ?? '';
    const rows = fullAccessRows(workspace);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.agent.session).toBe(id);
    expect(JSON.stringify(rows[0])).toContain(
      `kubic sessions create ${FULL_ACCESS_FLAG}`,
    );
    expect(err.join('\n')).toContain('full-access approvals skipped');
    expect(existsSync(join(sessionsRoot, id, 'posture.json'))).toBe(true);
  });
});
