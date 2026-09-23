// Slice F: `kubic sessions` CLI (issue #14).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createNodeFileBridge } from '../../exec/src/file-bridge.js';
import {
  createSession,
  openSessionStore,
} from '../../worker/src/lane/session-store.js';
import { BACKGROUND_CONTEXT } from '../../worker/src/pi-boundary.js';
import { runSessionsCommand } from './sessions-cli.js';

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), 'cli-'));
}

function out(): { lines: string[]; write: (line: string) => void } {
  const lines: string[] = [];
  return { lines, write: (line: string) => lines.push(line) };
}

describe('sessions CLI (issue #14, slice F)', () => {
  it('creates and lists sessions', async () => {
    const root = tmpRoot();
    const o = out();
    const created = await runSessionsCommand(['create', '--cwd', '/work'], {
      sessionsRoot: root,
      out: o.write,
    });
    expect(created).toBe(0);
    expect(o.lines.length).toBe(1);
    const listed = await runSessionsCommand(['list'], {
      sessionsRoot: root,
      out: o.write,
    });
    expect(listed).toBe(0);
    expect(o.lines.some((line) => line.includes('/work'))).toBe(true);
  });

  it('attaches and shows the transcript tail', async () => {
    const root = tmpRoot();
    const store = openSessionStore(root, createNodeFileBridge(root));
    const session = await createSession(store, '/work', BACKGROUND_CONTEXT);
    const id = session.metadata.id;
    await session.mutate(async (mutator) => {
      await mutator.commit(
        [
          {
            kind: 'entry',
            entry: {
              id: 'e-cli',
              parentId: null,
              type: 'message',
              message: {
                role: 'user',
                content: [{ type: 'text', text: 'cli hello' }],
                timestamp: Date.now(),
              },
            },
          },
        ],
        BACKGROUND_CONTEXT,
      );
    }, BACKGROUND_CONTEXT);
    await session.close(BACKGROUND_CONTEXT);
    const o = out();
    const code = await runSessionsCommand(['attach', id, '--tail', '5'], {
      sessionsRoot: root,
      out: o.write,
    });
    expect(code).toBe(0);
    expect(o.lines.some((line) => line.includes('cli hello'))).toBe(true);
  });

  it('fails cleanly for unknown sessions and bad usage', async () => {
    const root = tmpRoot();
    const o = out();
    expect(
      await runSessionsCommand(['attach', 'nope'], {
        sessionsRoot: root,
        out: o.write,
      }),
    ).toBe(1);
    expect(
      await runSessionsCommand([], { sessionsRoot: root, out: o.write }),
    ).toBe(1);
    expect(
      await runSessionsCommand(['bogus'], { sessionsRoot: root, out: o.write }),
    ).toBe(1);
  });
});
