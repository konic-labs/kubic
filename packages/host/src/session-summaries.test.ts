// The sessions the TUI's `/resume` picker lists: this project's
// sessions, newest first, with their first prompt, turns and cost, read
// without a lock; a session held live is listed but never opened.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createSession,
  openSessionStore,
} from '@kubic/agent/lane/session-store';
import {
  BACKGROUND_CONTEXT,
  createModels,
  createRegistry,
  fauxAssistantMessage,
  fauxProvider,
  Harness,
  type Storage,
} from '@kubic/agent/pi-boundary';
import { createNodeFileBridge } from '@kubic/exec/file-bridge';
import { afterEach, describe, expect, it } from 'vitest';
import { summarizeProjectSessions } from './session-summaries.js';

const made: string[] = [];
const open: Harness[] = [];

afterEach(async () => {
  for (const harness of open.splice(0)) {
    await harness.close(BACKGROUND_CONTEXT).catch(() => undefined);
  }
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'session-summaries-'));
  made.push(dir);
  return dir;
}

async function run(
  storage: Storage,
  prompts: readonly string[],
): Promise<void> {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const harness = await Harness.open(
    storage,
    { models, registry: createRegistry() },
    BACKGROUND_CONTEXT,
  );
  open.push(harness);
  const conversation = await harness.root(BACKGROUND_CONTEXT, {
    agent: { model: { provider: 'faux', modelId: 'faux-1' } },
  });
  faux.setResponses(prompts.map(() => fauxAssistantMessage('ok')));
  for (const prompt of prompts) {
    await (
      await conversation.submit(
        { type: 'input', content: prompt },
        BACKGROUND_CONTEXT,
      )
    ).wait(BACKGROUND_CONTEXT);
  }
  await harness.close(BACKGROUND_CONTEXT);
  open.splice(open.indexOf(harness), 1);
}

async function stored(
  root: string,
  id: string,
  cwd: string,
  prompts: readonly string[],
): Promise<void> {
  const store = openSessionStore(root, createNodeFileBridge(root));
  const session = await createSession(store, { id, cwd }, BACKGROUND_CONTEXT);
  if (prompts.length > 0) await run(session.adopt(), prompts);
  await session.release(BACKGROUND_CONTEXT);
}

describe('session summaries for /resume', () => {
  it('lists this project newest first with title, turns and cost', async () => {
    const root = tmpRoot();
    await stored(root, 'older', '/proj', [
      'fix the cart\nwith details',
      'and test it',
    ]);
    await stored(root, 'other', '/elsewhere', ['not ours']);
    await stored(root, 'newer', '/proj/pkg', ['add a test']);
    await stored(root, 'asking', '/proj', ['the current one']);
    const summaries = await summarizeProjectSessions({
      sessionsRoot: root,
      workspace: '/proj',
      exclude: 'asking',
    });
    expect(summaries.map((summary) => summary.id)).toEqual(['newer', 'older']);
    expect(summaries[1]).toMatchObject({
      id: 'older',
      title: 'fix the cart',
      turns: 2,
      state: 'ready',
    });
    expect(typeof summaries[1]?.costUsd).toBe('number');
    expect(summaries[1]?.createdAt).toMatch(/^\d{4}-/u);
  });

  it('lists a session held live without opening it', async () => {
    const root = tmpRoot();
    await stored(root, 'held', '/proj', ['busy elsewhere']);
    // A live holder: this very process's pid in the session's lock.
    writeFileSync(
      join(root, 'held', 'lock.json'),
      JSON.stringify({ pid: process.pid }),
    );
    const [held] = await summarizeProjectSessions({
      sessionsRoot: root,
      workspace: '/proj',
    });
    expect(held).toEqual({
      id: 'held',
      createdAt: expect.any(String),
      state: 'live',
    });
  });
});
