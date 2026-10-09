// `/new`, `/resume` and `/undo` on the real `kubic tui` loop.
// The prod boot (`bootTuiLane`) is driven through the real alt-screen key
// path with a temp sessions root and a temp workspace, so `/new` really
// boots a second session, `/resume` really lists the store, and `/undo`
// really restores a journaled file. Zero network, zero paid tokens.
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@kubic/agent/pi-boundary';
import { fauxToolUse } from '@kubic/agent/test-support/lane-harness';
import { NodeExecutionEnv } from '@kubic/exec/env';
import { afterEach, describe, expect, it } from 'vitest';
import { terminalRig } from '../../../test/fake-terminal.js';
import { bootTuiLane } from './tui/boot.js';
import type { TuiRunDeps } from './tui/options.js';
import { runTuiCommand } from './tui/run.js';

const made: string[] = [];

function tmpRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function fakeTerminal(width: number) {
  return terminalRig(width, 30);
}

// A prod boot (real harness, JSONL storage, a lane per session) is slower
// than the faux-only loops: give these tests a wider window.
async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 5000 && !condition(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  expect(condition()).toBe(true);
}

function type(fake: ReturnType<typeof fakeTerminal>, text: string): void {
  for (const ch of text) fake.feed(ch);
  fake.feed('\r');
}

// One faux provider answering in order; the messages are consumed per turn.
function providers(responses: ReturnType<typeof fauxAssistantMessage>[]) {
  const models = createModels();
  const faux = fauxProvider({
    provider: 'faux',
    models: [{ id: 'big', contextWindow: 200000 }],
  });
  faux.setResponses(
    responses.map((message) =>
      message.content.some((part) => part.type === 'toolCall')
        ? fauxToolUse(message.content)
        : message,
    ),
  );
  models.setProvider(faux.provider);
  return models;
}

function sessionIds(root: string): string[] {
  return readdirSync(root).filter((entry) => entry.startsWith('0'));
}

describe('/new, /resume and /undo on the kubic tui path', () => {
  it('starts a fresh session with /new without leaving the alt-screen', {
    timeout: 20000,
  }, async () => {
    const workspace = tmpRoot('tui-session-commands-new-ws-');
    const sessionsRoot = tmpRoot('tui-session-commands-new-sessions-');
    const lines: string[] = [];
    const fake = fakeTerminal(120);
    // ONE catalog per process, like the real boot: the shared faux script is
    // consumed across sessions (the second session's turn takes response 2).
    const models = providers([
      fauxAssistantMessage('from faux'),
      fauxAssistantMessage('from the new session'),
    ]);
    const bootLane: TuiRunDeps['bootLane'] = async (sid, answer) =>
      bootTuiLane(sid, {
        sessionsRoot,
        models,
        env: new NodeExecutionEnv(workspace),
        ...(answer === undefined ? {} : { answer }),
      });
    const pending = runTuiCommand(
      {},
      {
        out: (line: string) => lines.push(line),
        createTerminal: () => fake.terminal,
        bootLane,
      },
    );
    await waitFor(() => fake.counts.started === 1);
    type(fake, 'first prompt');
    await waitFor(() => fake.frame.includes('from faux'));
    expect(sessionIds(sessionsRoot)).toHaveLength(1);

    type(fake, '/new');
    await waitFor(() => fake.frame.includes('(new)'));
    // The session is a different one, and the store now holds both.
    expect(sessionIds(sessionsRoot)).toHaveLength(2);
    // The TUI never left the alt-screen and never re-entered it.
    expect(fake.counts.stopped).toBe(0);
    expect(fake.counts.started).toBe(1);
    // The fresh session still works: a prompt runs on the new lane and its
    // own answer lands (the shared faux script's second response).
    type(fake, 'second prompt');
    await waitFor(() => fake.frame.includes('from the new session'));
    fake.feed('\x03');
    fake.feed('\x03');
    expect((await pending).exitCode).toBe(0);
    expect(fake.counts.stopped).toBe(1);
    // The layout at quit is the NEW session's: the old transcript is gone.
    const doc = lines.join('\n');
    expect(doc).toContain('▌ second prompt');
    expect(doc).not.toContain('▌ first prompt');
  });

  it('lists the store with /resume and loads the chosen transcript', {
    timeout: 20000,
  }, async () => {
    const workspace = tmpRoot('tui-session-commands-resume-ws-');
    const sessionsRoot = tmpRoot('tui-session-commands-resume-sessions-');
    const lines: string[] = [];
    const fake = fakeTerminal(120);
    const models = providers([
      fauxAssistantMessage('first answer'),
      fauxAssistantMessage('second answer'),
    ]);
    const bootLane: TuiRunDeps['bootLane'] = async (sid, answer) =>
      bootTuiLane(sid, {
        sessionsRoot,
        models,
        env: new NodeExecutionEnv(workspace),
        ...(answer === undefined ? {} : { answer }),
      });
    const pending = runTuiCommand(
      {},
      {
        out: (line: string) => lines.push(line),
        createTerminal: () => fake.terminal,
        bootLane,
      },
    );
    await waitFor(() => fake.counts.started === 1);
    type(fake, 'the first session prompt');
    await waitFor(() => fake.frame.includes('first answer'));
    type(fake, '/new');
    await waitFor(() => fake.frame.includes('(new)'));
    const [first, second] = sessionIds(sessionsRoot);
    expect(first).toBeDefined();
    expect(second).toBeDefined();

    // `/resume` lists the OTHER session (the current one is not a choice),
    // titled by its first prompt with its turns.
    const mark = fake.writes.length;
    type(fake, '/resume');
    await waitFor(() =>
      fake.writes.slice(mark).join('').includes('the first session prompt'),
    );
    expect(fake.writes.slice(mark).join('')).toContain('┌─ Session');
    expect(fake.writes.slice(mark).join('')).toContain('1 turn');
    // Select the first row: the older session.
    fake.feed('\r');
    await waitFor(() => fake.frame.includes('(resumed)'));
    // The chosen session's transcript is what the screen now shows.
    fake.feed('\x03');
    fake.feed('\x03');
    expect((await pending).exitCode).toBe(0);
    const doc = lines.join('\n');
    expect(doc).toContain('▌ the first session prompt');
    expect(doc).toContain('first answer');
  });

  it('restores the journaled change with /undo', {
    timeout: 20000,
  }, async () => {
    const workspace = tmpRoot('tui-session-commands-undo-ws-');
    const sessionsRoot = tmpRoot('tui-session-commands-undo-sessions-');
    const lines: string[] = [];
    const fake = fakeTerminal(120);
    writeFileSync(join(workspace, 'a.txt'), 'before\n');
    const bootLane: TuiRunDeps['bootLane'] = async (sid, answer) =>
      bootTuiLane(sid, {
        sessionsRoot,
        models: providers([
          fauxAssistantMessage(
            [fauxToolCall('write', { path: 'a.txt', content: 'after\n' })],
            { stopReason: 'toolUse' },
          ),
          fauxAssistantMessage('wrote it'),
        ]),
        env: new NodeExecutionEnv(workspace),
        ...(answer === undefined ? {} : { answer }),
      });
    const pending = runTuiCommand(
      {},
      {
        out: (line: string) => lines.push(line),
        createTerminal: () => fake.terminal,
        bootLane,
      },
    );
    await waitFor(() => fake.counts.started === 1);
    type(fake, 'change the file');
    await waitFor(() => fake.frame.includes('wrote it'));
    expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('after\n');

    type(fake, '/undo');
    await waitFor(() => fake.frame.includes('undo: 1 restored'));
    expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('before\n');
    fake.feed('\x03');
    fake.feed('\x03');
    expect((await pending).exitCode).toBe(0);
    expect(lines.join('\n')).toContain('undo: 1 restored, 0 skipped');
  });
});
