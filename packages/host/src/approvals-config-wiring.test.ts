// Config `[approvals]` reaches the solo lanes (issue #230; §41.2, §40.3).
// Before this issue `kubic run` and `kubic tui` installed the solo policy with
// the hardcoded defaults (route ask-user, maxPendingMs 60 000, no
// autoApprove), while `kubic config` and doctor's `policy:approvals` printed
// the configured values — two contradictory green lines.
//
// Faux provider only: zero network, zero paid tokens. Every temp dir and env
// stub is undone in afterEach.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  installedPolicyDeps,
  loadCliConfig,
  runtimeApprovalDeps,
  runtimeRunDeps,
} from '../../../apps/kubic/src/config-runtime.js';
import { runHeadlessPrompt } from '../../../apps/kubic/src/headless-run.js';
import { bootTuiLane } from '../../../apps/kubic/src/tui-run.js';
import { NodeExecutionEnv } from '../../exec/src/env.js';
import { driveToSettled } from '../../worker/src/lane/solo.js';
import {
  BACKGROUND_CONTEXT,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type MutableModels,
} from '../../worker/src/pi-boundary.js';
import {
  type ApprovalRequest,
  type ApprovalVerdict,
  installedPolicyPosture,
  installSoloPolicy,
} from './approvals.js';
import { collectDoctorChecks } from './doctor.js';
import { auditLedgerDir, readAuditLedger } from './policy/audit-ledger.js';
import { mapTerminusToExitCode } from './run-cli.js';

const made: string[] = [];

function tmpRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `kubic-230-${prefix}`));
  made.push(dir);
  return dir;
}

beforeEach(() => {
  vi.stubEnv('KUBIC_NO_NOTICE', '1');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

// A home whose global config carries `approvalsToml` under [approvals],
// loaded through the composition root's own config seam.
function loadedWith(
  approvalsToml: string,
  env: Record<string, string> = {},
): ReturnType<typeof loadCliConfig> {
  const home = tmpRoot('home-');
  mkdirSync(join(home, '.kubic'), { recursive: true });
  writeFileSync(
    join(home, '.kubic', 'config.toml'),
    `[approvals]\n${approvalsToml}\n`,
  );
  const loaded = loadCliConfig({ home, cwd: tmpRoot('cwd-'), env });
  expect(loaded.error).toBeUndefined();
  return loaded;
}

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

describe('config route=deny reaches kubic run (issue #230)', () => {
  it('denies a destructive call by policy route, exit 4', async () => {
    const loaded = loadedWith('route = "deny"');
    const result = await runHeadlessPrompt(
      'clean the build dir',
      {},
      {
        sessionsRoot: tmpRoot('sessions-'),
        models: destructiveThenDone(),
        env: new NodeExecutionEnv(tmpRoot('ws-')),
        ...runtimeRunDeps(loaded),
      },
    );
    expect(result.terminus).toBe('approval_denied');
    expect(mapTerminusToExitCode(result.terminus)).toBe(4);
    expect(result.summary).toContain('denied by policy route');
  });

  it('KUBIC_APPROVALS_ROUTE=deny takes effect in solo', async () => {
    const home = tmpRoot('home-');
    const loaded = loadCliConfig({
      home,
      cwd: tmpRoot('cwd-'),
      env: { KUBIC_APPROVALS_ROUTE: 'deny' },
    });
    expect(loaded.error).toBeUndefined();
    const result = await runHeadlessPrompt(
      'clean the build dir',
      {},
      {
        sessionsRoot: tmpRoot('sessions-'),
        models: destructiveThenDone(),
        env: new NodeExecutionEnv(tmpRoot('ws-')),
        ...runtimeRunDeps(loaded),
      },
    );
    expect(result.terminus).toBe('approval_denied');
    expect(result.summary).toContain('denied by policy route');
  });
});

describe('config route=deny reaches kubic tui (issue #230)', () => {
  it('never asks the seat', async () => {
    const loaded = loadedWith('route = "deny"');
    let asks = 0;
    const boot = await bootTuiLane(undefined, {
      sessionsRoot: tmpRoot('sessions-'),
      env: new NodeExecutionEnv(tmpRoot('ws-')),
      models: destructiveThenDone(),
      approvals: runtimeApprovalDeps(loaded),
      answer: async () => {
        asks += 1;
        return { approved: true, by: 'allow-once' };
      },
    });
    try {
      const loop = boot.loop;
      if (loop === undefined) throw new Error('the boot carries no loop');
      const admission = await loop.accept(
        'clean the build dir',
        BACKGROUND_CONTEXT,
      );
      if (!admission.ok) throw new Error('admission refused');
      await driveToSettled(
        loop.lane,
        admission.value.operationId,
        BACKGROUND_CONTEXT,
        { sleep: async () => new Promise((r) => setTimeout(r, 5)) },
      );
      const entries = JSON.stringify(
        await loop.findEntries(undefined, BACKGROUND_CONTEXT),
      );
      expect(asks).toBe(0);
      expect(entries).toContain('denied by policy route');
    } finally {
      await boot.close?.();
    }
  });
});

describe('config autoApprove reaches the headless path (issue #230)', () => {
  it("autoApprove=['install'] lets npm install through, audited by:'autoApprove'", async () => {
    const workspace = tmpRoot('ws-');
    const loaded = loadedWith('autoApprove = ["install"]');
    const installed = installSoloPolicy({
      workspace,
      ...installedPolicyDeps(loaded),
    });
    const verdict = await installed.ask({
      toolName: 'bash',
      args: { command: 'npm install' },
      toolCallId: 'c1',
    });
    expect(verdict).toEqual({ approved: true, challenged: true });
    const records = readAuditLedger(auditLedgerDir(workspace));
    expect(records).toHaveLength(1);
    expect(JSON.stringify(records[0])).toContain('approved by autoApprove');
  });

  it('an autoApprove capability is refused without justification when requireJustification is set', async () => {
    const workspace = tmpRoot('ws-');
    const loaded = loadedWith(
      'autoApprove = ["install"]\nrequireJustification = true',
    );
    const installed = installSoloPolicy({
      workspace,
      ...installedPolicyDeps(loaded),
    });
    const verdict = await installed.ask({
      toolName: 'bash',
      args: { command: 'npm install' },
      toolCallId: 'c1',
    });
    expect(verdict).toEqual({
      approved: false,
      reason: 'approval requires justification',
    });
  });

  it('autoApprove is explicit-only: without it the headless ask still refuses', async () => {
    const installed = installSoloPolicy({ workspace: tmpRoot('ws-') });
    const verdict = await installed.ask({
      toolName: 'bash',
      args: { command: 'npm install' },
      toolCallId: 'c1',
    });
    expect(verdict.approved).toBe(false);
  });
});

describe('config maxPendingMs bounds the TUI seat (issue #230)', () => {
  it('a seat that never answers denies at about the configured 500 ms', async () => {
    vi.useFakeTimers();
    const loaded = loadedWith('maxPendingMs = 500');
    const installed = installSoloPolicy({
      workspace: tmpRoot('ws-'),
      sessionDir: tmpRoot('session-'),
      ...installedPolicyDeps(loaded),
      answer: (_request: ApprovalRequest) =>
        new Promise<ApprovalVerdict | undefined>(() => undefined),
    });
    expect(installed.posture.maxPendingMs).toBe(500);
    let settled: unknown;
    void installed
      .ask({
        toolName: 'bash',
        args: { command: 'rm -rf build' },
        toolCallId: 'c1',
      })
      .then((value) => {
        settled = value;
      });
    await vi.advanceTimersByTimeAsync(499);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toMatchObject({ approved: false });
    expect(String((settled as { reason: string }).reason)).toContain('500ms');
  });
});

describe('sessionScoped=false is refused by name (issue #230)', () => {
  it('the config load refuses it instead of silently running session-scoped', () => {
    const home = tmpRoot('home-');
    mkdirSync(join(home, '.kubic'), { recursive: true });
    writeFileSync(
      join(home, '.kubic', 'config.toml'),
      '[approvals]\nsessionScoped = false\n',
    );
    const loaded = loadCliConfig({ home, cwd: tmpRoot('cwd-'), env: {} });
    expect(loaded.runtime).toBeUndefined();
    expect(loaded.error).toContain('sessionScoped');
  });
});

describe('doctor: one derivation for the config and the installed route (issue #230)', () => {
  function doctorChecks(loaded: ReturnType<typeof loadCliConfig>) {
    return collectDoctorChecks(
      {
        out: () => undefined,
        err: () => undefined,
        probeProviders: () => [],
        checkDeps: () => [],
        loadPolicy: () => loaded.runtime?.approvals.policy,
        installedPolicy: () =>
          installedPolicyPosture({
            workspace: '/fake',
            ...installedPolicyDeps(loaded),
          }),
      } as never,
      [],
    );
  }

  it('policy:approvals and policy:installed report the same route and maxPendingMs', () => {
    const loaded = loadedWith('route = "deny"\nmaxPendingMs = 5000');
    const checks = doctorChecks(loaded);
    const approvals = checks.find((c) => c.id === 'policy:approvals');
    const installed = checks.find((c) => c.id === 'policy:installed');
    expect(approvals?.status).toBe('pass');
    expect(installed?.status).toBe('pass');
    expect(approvals?.detail).toContain('route=deny');
    expect(approvals?.detail).toContain('maxPendingMs=5000');
    expect(installed?.detail).toContain('route=deny');
    expect(installed?.detail).toContain('maxPendingMs=5000');
  });

  it('prints autoApprove on the installed line', () => {
    const loaded = loadedWith('autoApprove = ["install"]');
    const installed = doctorChecks(loaded).find(
      (c) => c.id === 'policy:installed',
    );
    expect(installed?.detail).toContain('autoApprove=install');
  });

  it('fails policy-mismatch when the installed route differs from config', () => {
    const loaded = loadedWith('route = "deny"');
    const checks = collectDoctorChecks(
      {
        out: () => undefined,
        err: () => undefined,
        probeProviders: () => [],
        checkDeps: () => [],
        loadPolicy: () => loaded.runtime?.approvals.policy,
        installedPolicy: () => installedPolicyPosture({ workspace: '/fake' }),
      } as never,
      [],
    );
    const installed = checks.find((c) => c.id === 'policy:installed');
    expect(installed?.status).toBe('fail');
    expect(installed?.reason).toBe('policy-mismatch');
    expect(installed?.detail).toContain('route');
  });
});
