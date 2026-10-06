// `kubic sessions fork` (issue #265; §22.3): the CLI over the store's fork —
// the printed id is a real session usable at once, --json prints
// {id, source, at}, a live-locked source exits 1 like attach, and the flags
// reach the runner through commander. Faux provider; temp dirs cleaned up.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLineLogger } from '../../../packages/core/src/cli/logger.js';
import { createNodeFileBridge } from '../../../packages/exec/src/file-bridge.js';
import {
  runSessionsCommand,
  type SessionsInvocation,
} from '../../../packages/host/src/sessions-cli.js';
import {
  attachSession,
  openSessionStore,
} from '../../../packages/worker/src/lane/session-store.js';
import { bootFauxLane } from '../../../packages/worker/src/lane/test-harness.js';
import {
  BACKGROUND_CONTEXT,
  fauxAssistantMessage,
} from '../../../packages/worker/src/pi-boundary.js';
import { dispatchCommand } from './dispatch.js';
import { createProdRunners } from './prod-runners.js';

const made: string[] = [];

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kubic-265-'));
  made.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

async function sourceSession(root: string): Promise<string> {
  const lane = await bootFauxLane({
    storage: 'jsonl',
    root,
    responses: [fauxAssistantMessage('answer')],
  });
  await lane.run('prompt');
  await lane.cleanup();
  return lane.sessionId;
}

function cli(root: string) {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    run: (invocation: SessionsInvocation) =>
      runSessionsCommand(invocation, {
        sessionsRoot: root,
        out: (line) => out.push(line),
        logger: createLineLogger((line: string) => err.push(line)),
      }),
  };
}

describe('kubic sessions fork (issue #265)', () => {
  it('prints a new session id that attaches at once', async () => {
    const root = tmpRoot();
    const source = await sourceSession(root);
    const c = cli(root);
    expect(await c.run({ command: 'fork', id: source })).toBe(0);
    const forkId = c.out[0] ?? '';
    expect(forkId).not.toBe(source);
    const store = openSessionStore(root, createNodeFileBridge(root));
    const handle = await attachSession(store, forkId, BACKGROUND_CONTEXT);
    await handle.release(BACKGROUND_CONTEXT);
  });

  it('--json prints {id, source, at}', async () => {
    const root = tmpRoot();
    const source = await sourceSession(root);
    const c = cli(root);
    expect(await c.run({ command: 'fork', id: source, json: true })).toBe(0);
    const doc = JSON.parse(c.out.join('\n')) as {
      id: string;
      source: string;
      at: number | null;
    };
    expect(doc.source).toBe(source);
    expect(typeof doc.at).toBe('number');
    expect(doc.id).not.toBe(source);
  });

  it('refuses a live-locked source with exit 1, naming the holder', async () => {
    const root = tmpRoot();
    const source = await sourceSession(root);
    const store = openSessionStore(root, createNodeFileBridge(root));
    const live = await attachSession(store, source, BACKGROUND_CONTEXT);
    try {
      const c = cli(root);
      expect(await c.run({ command: 'fork', id: source })).toBe(1);
      expect(c.out).toEqual([]);
      expect(c.err.join('\n')).toMatch(/attached by pid \d+/);
    } finally {
      await live.release(BACKGROUND_CONTEXT);
    }
  });

  it('attach --ids shows the entry ids that fork --at takes', async () => {
    const root = tmpRoot();
    const source = await sourceSession(root);
    const c = cli(root);
    expect(await c.run({ command: 'attach', id: source, ids: true })).toBe(0);
    const userLine = c.out.find((line) => / user: prompt$/.test(line)) ?? '';
    const match = /^#(\d+) user: prompt$/.exec(userLine);
    expect(match).not.toBeNull();
    const at = Number(match?.[1]);
    const forked = cli(root);
    expect(
      await forked.run({ command: 'fork', id: source, at, json: true }),
    ).toBe(0);
    const doc = JSON.parse(forked.out.join('\n')) as { id: string; at: number };
    expect(doc.at).toBe(at);
    const attached = cli(root);
    expect(await attached.run({ command: 'attach', id: doc.id })).toBe(0);
    // Cut at the user prompt: the fork has the prompt, not the answer.
    expect(attached.out).toContain('user: prompt');
    expect(attached.out.some((line) => line.startsWith('assistant:'))).toBe(
      false,
    );
  });

  it('--at with --tree is a usage error (exit 2)', async () => {
    const c = cli(tmpRoot());
    expect(
      await c.run({ command: 'fork', id: 'sess-1', at: 3, tree: true }),
    ).toBe(2);
  });

  it('commander parses `sessions fork <id> --at <n> --json` into the invocation', async () => {
    const seen: SessionsInvocation[] = [];
    const code = await dispatchCommand(
      'sessions',
      ['fork', 'sess-1', '--at', '7', '--json'],
      {
        out: () => undefined,
        err: () => undefined,
        loadConfig: () => ({}) as never,
        version: () => '9.9.9',
        ensureRuntimeExclude: () => undefined,
        runners: {
          ...createProdRunners({
            out: () => undefined,
            debug: () => undefined,
          }),
          sessions: async (invocation: SessionsInvocation) => {
            seen.push(invocation);
            return 0;
          },
        },
      },
    );
    expect(code).toBe(0);
    expect(seen).toEqual([
      { command: 'fork', id: 'sess-1', at: 7, json: true },
    ]);
  });
});
