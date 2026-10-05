// The in-session full-access toggle on the real `kubic tui` loop (issue
// #309; §41.4, §80). The prod boot (`bootTuiLane`) is driven through the real
// alt-screen key path: Alt+A asks, Ctrl-S confirms, and the posture file, the
// §60 ledger, the installed policy and the status-bar indicator all move.
// Zero network, zero paid tokens; every temp dir is removed in afterEach.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  bootTuiLane,
  runTuiCommand,
  type TuiRunDeps,
} from '../../../apps/kubic/src/tui-run.js';
import { fakeTerminal } from '../../../test/fake-terminal.js';
import { NodeExecutionEnv } from '../../exec/src/env.js';
import { fauxToolUse } from '../../worker/src/lane/test-harness.js';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type MutableModels,
} from '../../worker/src/pi-boundary.js';
import { FileApprovalStore } from './approvals.js';
import { auditLedgerDir, readAuditLedger } from './policy/audit-ledger.js';

const made: string[] = [];

function tmpRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `kubic-309-${prefix}`));
  made.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function models(): MutableModels {
  const models = createModels();
  const faux = fauxProvider({
    provider: 'faux',
    models: [{ id: 'big', contextWindow: 200000 }],
  });
  faux.setResponses([fauxAssistantMessage('ok')]);
  models.setProvider(faux.provider);
  return models;
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 800 && !condition(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  expect(condition()).toBe(true);
}

function postureRows(workspace: string) {
  return readAuditLedger(auditLedgerDir(workspace)).filter((record) =>
    record.what.startsWith('posture:'),
  );
}

describe('the TUI full-access toggle (issue #309)', () => {
  it('asks, then flips posture.json, the ledger and the indicator in one frame', async () => {
    const workspace = tmpRoot('ws-');
    const sessionsRoot = tmpRoot('sessions-');
    const fake = fakeTerminal(120, 30);
    let sessionId = '';
    const bootLane: TuiRunDeps['bootLane'] = async (sid, answer) => {
      const boot = await bootTuiLane(sid, {
        sessionsRoot,
        models: models(),
        env: new NodeExecutionEnv(workspace),
        ...(answer === undefined ? {} : { answer }),
      });
      sessionId = boot.sessionId;
      return boot;
    };
    const pending = runTuiCommand(
      {},
      {
        out: () => undefined,
        createTerminal: () => fake,
        bootLane,
      },
    );
    await waitFor(() => fake.started === 1);
    // Enforced from the first frame.
    await waitFor(() => fake.output().includes('approvals:on'));

    // Alt+A asks: the dialog names the consequence and its deliberate key.
    fake.inject('\u001ba');
    await waitFor(() =>
      fake.output().includes('enable full access for this session?'),
    );
    expect(fake.output()).toContain(
      'every challenged call in this session will run without asking',
    );
    expect(fake.output()).toContain('[Ctrl-S] confirm');
    // Nothing is recorded before the verdict.
    expect(postureRows(workspace)).toHaveLength(0);

    // Ctrl-S confirms: the file, the ledger and the bar all move.
    fake.inject('\u0013');
    await waitFor(() =>
      fake.output().includes('full access ON for this session'),
    );
    expect(fake.output()).toContain('approvals OFF (full-access)');
    expect(
      new FileApprovalStore(join(sessionsRoot, sessionId)).loadPosture()
        .fullAccess,
    ).toBe(true);
    expect(postureRows(workspace).map((row) => row.what)).toEqual([
      'posture:full-access',
    ]);
    expect(postureRows(workspace)[0]?.posture).toBe('full-access');

    // Alt+A again disables immediately — no dialog.
    const before = fake.writes.length;
    fake.inject('\u001ba');
    await waitFor(() =>
      fake.output().includes('enforced again — the next challenged call asks'),
    );
    expect(fake.writes.slice(before).join('')).not.toContain(
      'enable full access',
    );
    expect(fake.output()).toContain('approvals:on');
    expect(
      new FileApprovalStore(join(sessionsRoot, sessionId)).loadPosture()
        .fullAccess,
    ).toBe(false);
    // Two rows, in order, with the posture each flip recorded.
    expect(postureRows(workspace).map((row) => row.what)).toEqual([
      'posture:full-access',
      'posture:approvals',
    ]);
    expect(postureRows(workspace).map((row) => row.posture)).toEqual([
      'full-access',
      'approvals',
    ]);

    fake.inject('\u0003');
    expect(await pending).toBe(0);
  });

  it('a printable letter typed ahead cannot accept the dialog (issue #309)', async () => {
    const workspace = tmpRoot('ws-');
    const sessionsRoot = tmpRoot('sessions-');
    const fake = fakeTerminal(120, 30);
    let sessionId = '';
    const pending = runTuiCommand(
      {},
      {
        out: () => undefined,
        createTerminal: () => fake,
        bootLane: async (sid, answer) => {
          const boot = await bootTuiLane(sid, {
            sessionsRoot,
            models: models(),
            env: new NodeExecutionEnv(workspace),
            ...(answer === undefined ? {} : { answer }),
          });
          sessionId = boot.sessionId;
          return boot;
        },
      },
    );
    await waitFor(() => fake.started === 1);
    fake.inject('\u001ba');
    await waitFor(() =>
      fake.output().includes('enable full access for this session?'),
    );
    // `y`, `yes` and a bare Enter are all swallowed: the dialog stays and
    // nothing is recorded.
    for (const key of ['y', 'e', 's', '\r']) fake.inject(key);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fake.output()).toContain('enable full access for this session?');
    expect(
      new FileApprovalStore(join(sessionsRoot, sessionId)).loadPosture()
        .fullAccess,
    ).toBe(false);
    expect(postureRows(workspace)).toHaveLength(0);
    // The dialog is modal: those keys never reached the editor either, so
    // no prompt was submitted while it was up.
    expect(fake.output()).not.toContain('› yes');

    // Esc cancels: still enforced, nothing written.
    fake.inject('\u001b');
    await waitFor(() => fake.output().includes('approvals: unchanged'));
    expect(fake.output()).toContain('approvals:on');
    expect(postureRows(workspace)).toHaveLength(0);

    fake.inject('\u0003');
    expect(await pending).toBe(0);
  });

  it('answers /approvals on|off and reports the live posture (issue #309)', async () => {
    const workspace = tmpRoot('ws-');
    const sessionsRoot = tmpRoot('sessions-');
    const fake = fakeTerminal(120, 30);
    let sessionId = '';
    const pending = runTuiCommand(
      {},
      {
        out: () => undefined,
        createTerminal: () => fake,
        bootLane: async (sid, answer) => {
          const boot = await bootTuiLane(sid, {
            sessionsRoot,
            models: models(),
            env: new NodeExecutionEnv(workspace),
            ...(answer === undefined ? {} : { answer }),
          });
          sessionId = boot.sessionId;
          return boot;
        },
      },
    );
    await waitFor(() => fake.started === 1);
    const run = (command: string): void => {
      fake.inject('\u0015');
      for (const ch of command) fake.inject(ch);
      fake.inject('\r');
    };
    run('/approvals');
    await waitFor(() =>
      fake.output().includes('approvals: enforced — challenged calls ask'),
    );
    // Issue #309 review finding 1: `off` while already off is a REPORT — no
    // dialog, no second posture row for a change that did not happen.
    const beforeOff = fake.writes.length;
    run('/approvals off');
    await waitFor(() =>
      fake.output().includes('approvals: enforced — nothing to change'),
    );
    expect(postureRows(workspace)).toHaveLength(0);
    expect(fake.writes.slice(beforeOff).join('')).not.toContain(
      'posture:approvals',
    );
    // A malformed argument is refused by name.
    run('/approvals maybe');
    await waitFor(() =>
      fake.output().includes("approvals: expected 'on' or 'off'"),
    );
    // `on` opens the same confirmation; Ctrl-S confirms it.
    run('/approvals on');
    await waitFor(() =>
      fake.output().includes('enable full access for this session?'),
    );
    fake.inject('\u0013');
    await waitFor(() =>
      fake.output().includes('full access ON for this session'),
    );
    run('/approvals');
    await waitFor(() =>
      fake.output().includes('approvals: full access ON for this session'),
    );
    // Finding 1's mirror: `on` while already on is a report — it must NOT
    // toggle off, and it must not open a dialog that would.
    const beforeOn = fake.writes.length;
    run('/approvals on');
    await waitFor(() =>
      fake.output().includes('approvals: full access already ON'),
    );
    expect(fake.writes.slice(beforeOn).join('')).not.toContain(
      'enable full access for this session?',
    );
    expect(
      new FileApprovalStore(join(sessionsRoot, sessionId)).loadPosture()
        .fullAccess,
    ).toBe(true);
    expect(postureRows(workspace).map((row) => row.what)).toEqual([
      'posture:full-access',
    ]);
    // And the explicit direction still turns it off, immediately.
    run('/approvals off');
    await waitFor(() =>
      fake.output().includes('enforced again — the next challenged call asks'),
    );
    expect(postureRows(workspace).map((row) => row.what)).toEqual([
      'posture:full-access',
      'posture:approvals',
    ]);
    fake.inject('\u0003');
    expect(await pending).toBe(0);
  });

  it('refuses to open the confirmation over a pending approval (issue #309 review)', async () => {
    const workspace = tmpRoot('ws-');
    const sessionsRoot = tmpRoot('sessions-');
    const fake = fakeTerminal(120, 30);
    const models = createModels();
    const faux = fauxProvider({
      provider: 'faux',
      models: [{ id: 'big', contextWindow: 200000 }],
    });
    faux.setResponses([
      fauxToolUse(
        fauxAssistantMessage([
          fauxToolCall('bash', { command: 'rm -rf build/' }),
        ]).content,
      ),
      fauxAssistantMessage('done'),
    ]);
    models.setProvider(faux.provider);
    const pending = runTuiCommand(
      {},
      {
        out: () => undefined,
        createTerminal: () => fake,
        approvalArmingMs: 0,
        bootLane: async (sid, answer) =>
          bootTuiLane(sid, {
            sessionsRoot,
            models,
            env: new NodeExecutionEnv(workspace),
            ...(answer === undefined ? {} : { answer }),
          }),
      },
    );
    await waitFor(() => fake.started === 1);
    for (const ch of 'clean up') fake.inject(ch);
    fake.inject('\r');
    // The approval overlay owns the keys: the challenged command is on it.
    await waitFor(() => fake.output().includes('Approval required'));
    const before = fake.writes.length;
    fake.inject('\u001ba');
    await waitFor(() =>
      fake.output().includes('approvals: answer the pending request first'),
    );
    // No dialog was opened, so Ctrl-S and Esc still belong to the approval:
    // nothing was recorded for a flip that never started.
    expect(fake.writes.slice(before).join('')).not.toContain(
      'enable full access for this session?',
    );
    expect(postureRows(workspace)).toHaveLength(0);
    // Esc answers the pending request (denies it) rather than a dialog.
    fake.inject('\u001b');
    await waitFor(() => fake.output().includes('denied'));
    expect(postureRows(workspace)).toHaveLength(0);
    fake.inject('\u0003');
    expect(await pending).toBe(0);
  });
});
