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
import { runHeadlessPrompt } from '../../../apps/kubic/src/headless-run.js';
import {
  bootTuiLane,
  runTuiCommand,
  type TuiLaneBoot,
} from '../../../apps/kubic/src/tui-run.js';
import { createLineLogger } from '../../core/src/cli/logger.js';
import { NodeExecutionEnv } from '../../exec/src/env.js';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type MutableModels,
} from '../../worker/src/pi-boundary.js';
import {
  enableSessionFullAccess,
  FileApprovalStore,
  FULL_ACCESS_FLAG,
} from './approvals.js';
import { auditLedgerDir, readAuditLedger } from './policy/audit-ledger.js';
import { buildRunEnvelope, mapTerminusToExitCode } from './run-cli.js';
import { runSessionsCommand } from './sessions-cli.js';

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
    fauxAssistantMessage([fauxToolCall('bash', { command: 'rm -rf build' })]),
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

  it('never persists the flag to any config file', async () => {
    const home = tmpRoot('home-');
    mkdirSync(join(home, '.kubic'), { recursive: true });
    writeFileSync(join(home, '.kubic', 'config.toml'), '[agent]\n');
    vi.stubEnv('HOME', home);
    const before = readdirSync(join(home, '.kubic'));
    await runHeadlessPrompt(
      'hello',
      { dangerouslySkipApprovals: true },
      {
        sessionsRoot: tmpRoot('sessions-'),
        models: modelsWith([fauxAssistantMessage('hi')]),
        env: new NodeExecutionEnv(tmpRoot('ws-')),
        warn: () => undefined,
      },
    );
    expect(readdirSync(join(home, '.kubic'))).toEqual(before);
    expect(readFileSync(join(home, '.kubic', 'config.toml'), 'utf8')).toBe(
      '[agent]\n',
    );
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
    const writes: string[] = [];
    const errors: string[] = [];
    let handler: ((data: string) => void) | undefined;
    let started = 0;
    const flags: unknown[] = [];
    const pending = runTuiCommand(
      { dangerouslySkipApprovals: true },
      {
        out: () => undefined,
        err: (line) => errors.push(line),
        createTerminal: () =>
          ({
            start: (input: (data: string) => void) => {
              started += 1;
              handler = input;
            },
            stop: () => {},
            drainInput: () => Promise.resolve(),
            write: (data: string) => writes.push(data),
            columns: 120,
            rows: 30,
            kittyProtocolActive: false,
            moveBy: () => {},
            hideCursor: () => {},
            showCursor: () => {},
            clearLine: () => {},
            clearFromCursor: () => {},
            clearScreen: () => {},
            setTitle: () => {},
            setProgress: () => {},
          }) as never,
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
    for (let i = 0; i < 200 && started === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    for (let i = 0; i < 200 && !writes.join('').includes('OFF'); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    handler?.('\x03');
    expect(await pending).toBe(0);
    expect(flags).toEqual([{ dangerouslySkipApprovals: true }]);
    expect(writes.join('')).toContain('approvals OFF (full-access)');
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
