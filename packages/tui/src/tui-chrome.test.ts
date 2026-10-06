// The app's chrome (EPIC N, issue #453): the header facts, the status
// line's state word and journal count, and the key-hint row per context.
// Headless renders of the real app at colour depth none.
import { describe, expect, it } from 'vitest';
import { createTuiApp, type TuiAppSeed } from './tui-app.js';

const seed = (over: Partial<TuiAppSeed> = {}) =>
  createTuiApp({
    sessionId: '01a1c0de-7a6b-4c1e-9f00-3d2a5e9cb6b8',
    model: 'faux/m',
    mode: 'solo',
    approvalsSkipped: false,
    ...over,
  });

const promptEntry = (id: string, seq: number, text: string) => ({
  id,
  seq,
  type: 'message' as const,
  message: { role: 'user', content: [{ type: 'text', text }] },
});

describe('header facts (issue #453)', () => {
  it('names the session by its short id, then by its first committed prompt', () => {
    const app = seed();
    expect(app.render(120)[0]).toContain('session 01a1…b6b8 │ [SOLO]');
    app.applyLaneEntries([
      promptEntry('u1', 1, 'run npm test and fix the failing test'),
    ]);
    expect(app.render(120)[0]).toContain(
      'session run npm test and fix th… │ [SOLO]',
    );
    // Later prompts never rename the session.
    app.applyLaneEntries([
      promptEntry('u1', 1, 'run npm test and fix the failing test'),
      promptEntry('u2', 2, 'now something else'),
    ]);
    expect(app.render(120)[0]).toContain('session run npm test and fix th…');
    // A new session starts from its own id again.
    app.resetSession({ sessionId: 'fresh-session-id-0001', model: 'faux/m' });
    expect(app.render(120)[0]).toContain('session fres…0001');
  });

  it('shows the workspace and the clock the composition root supplies', () => {
    const app = seed({
      workspace: { project: 'kubic-playground', branch: 'main', dirty: 2 },
      clock: () => '14:02',
    });
    expect(app.render(120)[0]).toMatch(
      /^ ■ KUBIC │ kubic-playground {2}⎇ main ●2 .* │ 14:02 $/,
    );
    app.setWorkspace({ project: 'kubic-playground', branch: 'fix', dirty: 0 });
    const header = app.render(120)[0] ?? '';
    expect(header).toContain('⎇ fix ');
    expect(header).not.toContain('●');
    // A directory name never reaches the terminal with its control bytes.
    app.setWorkspace({ project: 'evil\u001b[2Jdir', branch: 'main' });
    expect(app.render(120)[0]).not.toContain('\u001b[2J');
  });

  it('carries the lane notice in the welcome block, per mode, wrapped whole', () => {
    const notices = {
      solo: 'solo: no isolation - in-process with your authority (files, network, credentials); controls: approvals + journal',
      orchestrator: 'orchestrator: worktrees separate writers only',
    };
    const app = seed({ laneNotice: (mode) => notices[mode] });
    const narrow = app.render(60).join('\n');
    expect(narrow).toContain('controls: approvals + journal');
    expect(narrow).not.toContain('orchestrator: worktrees');
    app.setMode('orchestrator');
    const doc = app.render(100).join('\n');
    expect(doc).toContain(notices.orchestrator);
    expect(doc).not.toContain('no isolation');
  });
});

describe('status line state word (issue #453)', () => {
  const stateOf = (app: ReturnType<typeof seed>): string =>
    (app.render(100).at(-2) ?? '').trimEnd().split('  ').at(-1)?.trim() ?? '';

  it('reads ready, working, cancelling and error through a turn', () => {
    const app = seed();
    expect(stateOf(app)).toBe('ready');
    app.setBusy(true);
    expect(stateOf(app)).toBe('working');
    app.setCancelling(true);
    expect(stateOf(app)).toBe('cancelling…');
    app.setTurnOutcome('cancelled');
    app.setBusy(false);
    expect(stateOf(app)).toBe('ready');
    app.setBusy(true);
    app.setTurnOutcome('failed');
    app.setBusy(false);
    expect(stateOf(app)).toBe('error');
    // The next turn clears the error.
    app.setBusy(true);
    expect(stateOf(app)).toBe('working');
  });

  it('never marks an idle session as cancelling', () => {
    const app = seed();
    app.setCancelling(true);
    expect(stateOf(app)).toBe('ready');
  });

  it('reads needs approval while a request waits, and shows its keys', async () => {
    const app = seed();
    app.setBusy(true);
    const decision = app.requestApproval({
      key: 'bash:rm',
      capability: 'destructive-shell',
      toolName: 'bash',
      summary: 'rm -rf /tmp/x',
    });
    const rows = app.render(100);
    expect(rows.at(-2)?.endsWith(' needs approval ')).toBe(true);
    expect(rows.at(-1)).toContain('a allow once   ^S allow for session');
    app.handleInput('\x1b');
    await decision;
    expect(stateOf(app)).toBe('working');
  });

  it('counts the session journal', () => {
    const app = seed();
    const change = (path: string) => ({
      path,
      op: 'edit' as const,
      agentId: 'root',
      toolCallId: 'tc-1',
      sessionId: 's',
      timestamp: 1,
      unattributed: false,
      reversible: true,
      before: 'a',
      after: 'b',
    });
    app.setJournalChanges([change('a.ts'), change('b.ts')]);
    expect(app.render(120).at(-2)).toContain('journal 2 changes');
    app.resetSession({ sessionId: 's2', model: 'faux/m' });
    expect(app.render(120).at(-2)).not.toContain('journal');
  });
});

describe('key-hint row (issue #453)', () => {
  it('switches between idle and working sets', () => {
    const app = seed();
    expect(app.render(100).at(-1)).toMatch(/^ ⏎ send {3}\^J newline/);
    expect(app.render(100).at(-1)?.endsWith(' ^C ^C quit ')).toBe(true);
    app.setBusy(true);
    expect(app.render(100).at(-1)).toMatch(/^ esc interrupt {3}⏎ queue/);
    expect(app.render(100).at(-1)?.endsWith(' ^C ^C quit ')).toBe(true);
  });

  it('names the file key only when @-mentions complete files', () => {
    expect(seed().render(100).at(-1)).not.toContain('@ file');
    expect(
      seed({ listFiles: () => [] })
        .render(100)
        .at(-1),
    ).toContain('@ file');
  });
});

describe('tool cards on the app (issue #455)', () => {
  const call = (id: string) => ({
    id: 'a1',
    seq: 1,
    type: 'message' as const,
    message: {
      role: 'assistant',
      content: [
        {
          type: 'toolCall',
          id,
          name: 'bash',
          arguments: { command: 'rm -rf dist' },
        },
      ],
    },
  });
  const lanes = (status: 'running' | 'done', durationMs?: number) => ({
    session: { sessionId: 's', mode: 'solo' as const, approvalsSkipped: false },
    agents: new Map(),
    lanes: new Map([
      [
        '01a1c0de-7a6b-4c1e-9f00-3d2a5e9cb6b8',
        {
          laneId: '01a1c0de-7a6b-4c1e-9f00-3d2a5e9cb6b8',
          agentId: 'root',
          status: 'running' as const,
          tools: [
            {
              toolCallId: 'tc1',
              toolName: 'bash',
              status,
              isError: false,
              ...(durationMs === undefined ? {} : { durationMs }),
            },
          ],
          queued: [],
          compacting: false,
        },
      ],
    ]),
    workers: new Map(),
    approvals: [],
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    connection: { status: 'connected' as const },
  });

  it('marks the call an approval holds, then shows its duration', async () => {
    const app = seed();
    app.applyLaneEntries([call('tc1')]);
    app.applyPresentation(lanes('running'));
    expect(app.transcript.render(100).join('\n')).toMatch(
      /bash {2}rm -rf dist .*running/,
    );
    const decision = app.requestApproval({
      key: 'bash:rm',
      capability: 'destructive-shell',
      toolName: 'bash',
      summary: 'rm -rf dist',
    });
    expect(app.transcript.render(100).join('\n')).toContain('◆ bash');
    expect(app.transcript.render(100).join('\n')).toContain(
      'waiting for approval',
    );
    app.handleInput('\x1b');
    await decision;
    app.applyLaneEntries([
      call('tc1'),
      {
        id: 'r1',
        seq: 2,
        type: 'message',
        message: {
          role: 'toolResult',
          toolCallId: 'tc1',
          content: [
            { type: 'text', text: '[bash exit 0 (bash)]\n(no output)' },
          ],
        },
      },
    ]);
    app.applyPresentation(lanes('done', 410));
    const doc = app.transcript.render(100).join('\n');
    expect(doc).toContain('✓ exit 0 · 410ms');
    expect(doc).not.toContain('waiting');
  });
});
