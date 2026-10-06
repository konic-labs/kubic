// Issue #332 (§22.1, §66 session.fork; the EPIC K re-baseline): pi-durable
// branches by forking, so `/fork <entry>` and `/tree` fork the live session
// into a NEW session and switch the TUI to it. The next prompt continues from
// the fork; the abandoned path stays in the original session. Faux provider,
// the real boot path; temp dirs cleaned up in afterEach.
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NodeExecutionEnv } from '../../../packages/exec/src/env.js';
import { createNodeFileBridge } from '../../../packages/exec/src/file-bridge.js';
import {
  attachSession,
  openSessionStore,
} from '../../../packages/worker/src/lane/session-store.js';
import { bootFauxLane } from '../../../packages/worker/src/lane/test-harness.js';
import { readSessionEntries } from '../../../packages/worker/src/lane/transcript.js';
import {
  BACKGROUND_CONTEXT,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
} from '../../../packages/worker/src/pi-boundary.js';
import { terminalRig } from '../../../test/fake-terminal.js';
import { bootTuiLane, runTuiCommand, type TuiRunDeps } from './tui-run.js';

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

async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 5000 && !condition(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  expect(condition()).toBe(true);
}

const csi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, 'g');
const plain = (text: string): string => text.replace(csi, '');

function textOf(entry: { model?: unknown }): string {
  const content = (entry.model as Array<{ content?: unknown }> | undefined)?.[0]
    ?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content))
    return content
      .map((part) => (part as { text?: string }).text ?? '')
      .join('');
  return '';
}

async function transcriptOf(root: string, id: string): Promise<string[]> {
  const store = openSessionStore(root, createNodeFileBridge(root));
  const handle = await attachSession(store, id, BACKGROUND_CONTEXT);
  try {
    return (await readSessionEntries(handle.storage, BACKGROUND_CONTEXT))
      .map(textOf)
      .filter((text) => text !== '');
  } finally {
    await handle.release(BACKGROUND_CONTEXT);
  }
}

/** A released two-turn session: first → one, second → two. */
async function twoTurnSource(root: string, workspace: string) {
  const lane = await bootFauxLane({
    storage: 'jsonl',
    root,
    cwd: workspace,
    responses: [fauxAssistantMessage('one'), fauxAssistantMessage('two')],
  });
  await lane.run('first');
  await lane.run('second');
  const entries = await readSessionEntries(
    lane.session.storage,
    BACKGROUND_CONTEXT,
  );
  const answerOne = entries.find((entry) => textOf(entry) === 'one');
  await lane.cleanup();
  return { id: lane.sessionId, answerOneId: Number(answerOne?.id) };
}

function openTui(
  sessionsRoot: string,
  workspace: string,
  session: string,
  responses: string[],
) {
  const models = createModels();
  const faux = fauxProvider();
  faux.setResponses(responses.map((text) => fauxAssistantMessage(text)));
  models.setProvider(faux.provider);
  const bootLane: TuiRunDeps['bootLane'] = async (sid, answer) =>
    bootTuiLane(sid, {
      sessionsRoot,
      models,
      env: new NodeExecutionEnv(workspace),
      ...(answer === undefined ? {} : { answer }),
    });
  const fake = terminalRig(140, 30);
  const exit = runTuiCommand(
    { session },
    {
      out: () => undefined,
      createTerminal: () => fake.terminal,
      colorLevel: 'none',
      bootLane,
    },
  );
  const type = (text: string): void => {
    for (const ch of text) fake.feed(ch);
    fake.feed('\r');
  };
  return { fake, exit, type };
}

function sessionDirs(root: string): string[] {
  return readdirSync(root).filter((entry) => !entry.startsWith('.'));
}

describe('/fork and /tree in the TUI (issue #332)', () => {
  it('/fork <entry> switches to a new session; the next prompt continues from the fork', {
    timeout: 30000,
  }, async () => {
    const sessionsRoot = tmpRoot('tui-332-sessions-');
    const workspace = tmpRoot('tui-332-ws-');
    const source = await twoTurnSource(sessionsRoot, workspace);
    const tui = openTui(sessionsRoot, workspace, source.id, ['three']);
    await waitFor(() => tui.fake.counts.started === 1);
    tui.type(`/fork ${source.answerOneId}`);
    await waitFor(() =>
      plain(tui.fake.frame).includes(`from ${source.id} at #`),
    );
    tui.type('third');
    await waitFor(() => plain(tui.fake.frame).includes('three'));
    tui.fake.feed('\x1b');
    expect(await tui.exit).toBe(0);

    const [forkId] = sessionDirs(sessionsRoot).filter((id) => id !== source.id);
    expect(forkId).toBeDefined();
    const fork = await transcriptOf(sessionsRoot, forkId as string);
    expect(fork).toEqual(['first', 'one', 'third', 'three']);
    // The abandoned path is still in the original session.
    expect(await transcriptOf(sessionsRoot, source.id)).toEqual([
      'first',
      'one',
      'second',
      'two',
    ]);
  });

  it('/tree forks before the picked prompt and puts it back in the editor', {
    timeout: 30000,
  }, async () => {
    const sessionsRoot = tmpRoot('tui-332-tree-sessions-');
    const workspace = tmpRoot('tui-332-tree-ws-');
    const source = await twoTurnSource(sessionsRoot, workspace);
    const tui = openTui(sessionsRoot, workspace, source.id, ['retried']);
    await waitFor(() => tui.fake.counts.started === 1);
    tui.type('/tree');
    // The picker lists the prompts newest first; Enter takes `second`.
    await waitFor(() =>
      plain(tui.fake.frame).includes('fork before this prompt'),
    );
    tui.fake.feed('\r');
    await waitFor(() =>
      plain(tui.fake.frame).includes('(edit the prompt and press enter)'),
    );
    // The editor holds the picked prompt: Enter resubmits it on the fork.
    tui.fake.feed('\r');
    await waitFor(() => plain(tui.fake.frame).includes('retried'));
    tui.fake.feed('\x1b');
    expect(await tui.exit).toBe(0);

    const [forkId] = sessionDirs(sessionsRoot).filter((id) => id !== source.id);
    expect(await transcriptOf(sessionsRoot, forkId as string)).toEqual([
      'first',
      'one',
      'second',
      'retried',
    ]);
  });
});
