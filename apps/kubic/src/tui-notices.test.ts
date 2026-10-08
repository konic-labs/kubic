// Warnings the TUI raises reach the transcript, never stderr: the alt-screen
// owns the terminal, so a raw line would paint over the frame. Covers a settled
// turn's unreadable audit ledger, an unresolvable --skill at startup and after
// /new, and the full-access notice of a lane /new boots. Real booted lane over
// temp dirs, faux models only: zero network, zero paid tokens.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  type MutableModels,
} from '../../../packages/agent/src/pi-boundary.js';
import { NodeExecutionEnv } from '../../../packages/exec/src/env.js';
import {
  AUDIT_LEDGER_FILE,
  auditLedgerDirFor,
} from '../../../packages/host/src/policy/audit-ledger.js';
import { bootScreen } from '../../../packages/tui/src/screen.js';
import { createTuiApp } from '../../../packages/tui/src/tui-app.js';
import { fakeTerminal, terminalRig } from '../../../test/fake-terminal.js';
import { bootTuiLane, runTuiCommand, TuiTurnRunner } from './tui-run.js';

const made: string[] = [];

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

function fauxModels(texts: string[]): MutableModels {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(
    texts.map((text) => async () => fauxAssistantMessage(text)),
  );
  return models;
}

// A ledger of the older format (no version marker): the settled turn's
// trajectory write cannot read it, so it warns and writes the run anyway.
function olderLedger(cwd: string): void {
  const dir = auditLedgerDirFor(cwd);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, AUDIT_LEDGER_FILE),
    `${JSON.stringify({ who: 'ege', what: 'shell', when: '2026-10-08T00:00:00.000Z', posture: 'approvals', result: 'ok' })}\n`,
  );
}

// Every byte the process wrote to stderr while the test runs.
function captureStderr(): { text: () => string; restore: () => void } {
  const chunks: string[] = [];
  const spy = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    });
  return {
    text: () => chunks.join(''),
    restore: () => spy.mockRestore(),
  };
}

async function waitFor(
  condition: () => boolean,
  deadlineMs = 10_000,
): Promise<void> {
  const start = Date.now();
  while (!condition() && Date.now() - start < deadlineMs) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  expect(condition()).toBe(true);
}

beforeEach(() => {
  vi.stubEnv('KUBIC_NO_NOTICE', '1');
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe('TUI warnings reach the transcript, not stderr', () => {
  it('a settled turn that cannot read the audit ledger warns on the screen', async () => {
    const ws = tmp('tui-notice-ws-');
    olderLedger(ws);
    const stderr = captureStderr();
    const boot = await bootTuiLane(undefined, {
      sessionsRoot: tmp('tui-notice-root-'),
      models: fauxModels(['answer']),
      env: new NodeExecutionEnv(ws),
    });
    const app = createTuiApp({
      sessionId: boot.sessionId,
      model: boot.model,
      approvalsSkipped: false,
    });
    const screen = bootScreen(fakeTerminal(120, 30), app.root);
    try {
      const runner = new TuiTurnRunner(app, boot.loop as never, boot.model);
      expect((await runner.run('hello')).status).toBe('completed');
      screen.render();
      expect(screen.tui.getScreenLines().join('\n')).toContain(
        'warning: trajectory: approvals not recorded for this run',
      );
      expect(stderr.text()).not.toContain('approvals not recorded');
    } finally {
      screen.restore();
      stderr.restore();
      await boot.close?.();
    }
  });

  it('an unresolvable --skill shows on the first frame, never on stderr', async () => {
    const home = tmp('tui-notice-home-');
    const ws = tmp('tui-notice-work-');
    const root = tmp('tui-notice-sessions-');
    const fake = terminalRig(120);
    const stderr = captureStderr();
    const errors: string[] = [];
    const pending = runTuiCommand(
      { skills: ['ghost-skill'] },
      {
        out: () => {},
        err: (line: string) => errors.push(line),
        createTerminal: () => fake.terminal,
        colorLevel: 'none',
        bootLane: (sessionId, seat, flags) =>
          bootTuiLane(sessionId, {
            sessionsRoot: root,
            models: fauxModels(['ok']),
            env: new NodeExecutionEnv(ws),
            skills: { homeDir: home, cwd: ws, trusted: false },
            skillsList: flags?.skillsList,
            answer: seat,
          }),
      },
    );
    let exitCode: number | undefined;
    try {
      await waitFor(() =>
        fake.frame.includes(
          "warning: skill skipped (unknown skill 'ghost-skill')",
        ),
      );
      expect(errors.join('\n')).not.toContain('ghost-skill');
      expect(stderr.text()).not.toContain('ghost-skill');
    } finally {
      fake.feed('\x03');
      fake.feed('\x03');
      stderr.restore();
      exitCode = (await pending).exitCode;
    }
    expect(exitCode).toBe(0);
  });

  it('a session switched with /new shows its boot warning on the new screen', async () => {
    const home = tmp('tui-notice-home-');
    const ws = tmp('tui-notice-work-');
    const root = tmp('tui-notice-sessions-');
    const fake = terminalRig(120);
    const stderr = captureStderr();
    const warning = "warning: skill skipped (unknown skill 'ghost-skill')";
    let boots = 0;
    // The first boot is clean; only the switched-to lane names the skill, so
    // the warning on screen can only come from that boot.
    const pending = runTuiCommand(
      {},
      {
        out: () => {},
        createTerminal: () => fake.terminal,
        colorLevel: 'none',
        bootLane: (sessionId, seat) => {
          boots += 1;
          return bootTuiLane(sessionId, {
            sessionsRoot: root,
            models: fauxModels(['ok']),
            env: new NodeExecutionEnv(ws),
            skills: { homeDir: home, cwd: ws, trusted: false },
            ...(boots === 1 ? {} : { skillsList: ['ghost-skill'] }),
            answer: seat,
          });
        },
      },
    );
    let exitCode: number | undefined;
    try {
      await waitFor(() => fake.frame.includes('describe a task below'));
      expect(fake.frame).not.toContain(warning);
      const mark = fake.mark();
      for (const ch of '/new') fake.feed(ch);
      fake.feed('\r');
      await waitFor(() => boots === 2 && fake.since(mark).includes(warning));
      expect(stderr.text()).not.toContain('ghost-skill');
    } finally {
      fake.feed('\x03');
      fake.feed('\x03');
      stderr.restore();
      exitCode = (await pending).exitCode;
    }
    expect(exitCode).toBe(0);
  });

  it('a /new boot whose lane carries a full-access notice shows it on the new screen, never on stderr', async () => {
    const home = tmp('tui-notice-home-');
    const ws = tmp('tui-notice-work-');
    const root = tmp('tui-notice-sessions-');
    const fake = terminalRig(120);
    const stderr = captureStderr();
    const errors: string[] = [];
    const notice = 'full-access approvals skipped';
    // The flag is forwarded to every boot, so the lane /new boots carries it.
    const pending = runTuiCommand(
      { dangerouslySkipApprovals: true },
      {
        out: () => {},
        err: (line: string) => errors.push(line),
        createTerminal: () => fake.terminal,
        colorLevel: 'none',
        bootLane: (sessionId, seat, flags) =>
          bootTuiLane(sessionId, {
            sessionsRoot: root,
            models: fauxModels(['ok']),
            env: new NodeExecutionEnv(ws),
            skills: { homeDir: home, cwd: ws, trusted: false },
            ...(flags?.dangerouslySkipApprovals === true
              ? { dangerouslySkipApprovals: true }
              : {}),
            answer: seat,
          }),
      },
    );
    let exitCode: number | undefined;
    try {
      // Startup prints its own full-access notice on stderr before the screen.
      await waitFor(() => fake.frame.includes('describe a task below'));
      const errorsBefore = errors.length;
      const mark = fake.mark();
      for (const ch of '/new') fake.feed(ch);
      fake.feed('\r');
      await waitFor(() => fake.since(mark).includes(notice));
      expect(errors.slice(errorsBefore)).toEqual([]);
      expect(stderr.text()).not.toContain(notice);
    } finally {
      fake.feed('\x03');
      fake.feed('\x03');
      stderr.restore();
      exitCode = (await pending).exitCode;
    }
    expect(exitCode).toBe(0);
  });
});
