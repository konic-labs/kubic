// Slice F: `kubic sessions` CLI (issue #14).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createNodeFileBridge } from '../../exec/src/file-bridge.js';
import {
  createSession,
  openSessionStore,
} from '../../worker/src/lane/session-store.js';
import { BACKGROUND_CONTEXT } from '../../worker/src/pi-boundary.js';
import { runSessionsCommand } from './sessions-cli.js';

const made: string[] = [];

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cli-'));
  made.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function out(): { lines: string[]; write: (line: string) => void } {
  const lines: string[] = [];
  return { lines, write: (line: string) => lines.push(line) };
}

describe('sessions CLI (issue #14, slice F)', () => {
  it('creates and lists sessions', async () => {
    const root = tmpRoot();
    const o = out();
    const created = await runSessionsCommand(
      { command: 'create', cwd: '/work' },
      {
        sessionsRoot: root,
        out: o.write,
      },
    );
    expect(created).toBe(0);
    expect(o.lines.length).toBe(1);
    const id = o.lines[0] ?? '';
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
    // A separate sink: the listing itself must carry the session and its cwd.
    const listing = out();
    const listed = await runSessionsCommand(
      { command: 'list' },
      {
        sessionsRoot: root,
        out: listing.write,
      },
    );
    expect(listed).toBe(0);
    expect(
      listing.lines.some((line) => line.includes(id) && line.includes('/work')),
    ).toBe(true);
  });

  it('list --json prints [] when there are no sessions', async () => {
    const o = out();
    const code = await runSessionsCommand(
      { command: 'list', json: true },
      {
        sessionsRoot: tmpRoot(),
        out: o.write,
      },
    );
    expect(code).toBe(0);
    expect(o.lines).toEqual(['[]']);
  });

  it('list --json emits one {id, cwd} object per session', async () => {
    const root = tmpRoot();
    const o = out();
    await runSessionsCommand(
      { command: 'create', cwd: '/work' },
      {
        sessionsRoot: root,
        out: o.write,
      },
    );
    const listing = out();
    await runSessionsCommand(
      { command: 'list', json: true },
      {
        sessionsRoot: root,
        out: listing.write,
      },
    );
    expect(JSON.parse(listing.lines.join('\n'))).toEqual([
      { id: o.lines[0], cwd: '/work' },
    ]);
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
    const code = await runSessionsCommand(
      { command: 'attach', id: id, tail: 5 },
      {
        sessionsRoot: root,
        out: o.write,
      },
    );
    expect(code).toBe(0);
    expect(o.lines.some((line) => line.includes('cli hello'))).toBe(true);
  });

  it('fails cleanly for unknown sessions and unsafe ids', async () => {
    const root = tmpRoot();
    const o = out();
    expect(
      await runSessionsCommand(
        { command: 'attach', id: 'nope' },
        {
          sessionsRoot: root,
          out: o.write,
        },
      ),
    ).toBe(1);
    expect(o.lines.join('\n')).toContain('error:');
    // The id is a path segment: a traversal is refused before any store I/O.
    expect(
      await runSessionsCommand(
        { command: 'attach', id: '../x' },
        {
          sessionsRoot: root,
          out: o.write,
        },
      ),
    ).toBe(2);
  });
});

describe('sessions CLI approvals posture (issue #16, slice D)', () => {
  it('records full-access on create with the flag and indicates on attach', async () => {
    const root = tmpRoot();
    const o = out();
    const created = await runSessionsCommand(
      { command: 'create', cwd: '/work', dangerouslySkipApprovals: true },
      { sessionsRoot: root, out: o.write },
    );
    expect(created).toBe(0);
    expect(o.lines.some((line) => line.includes('full-access'))).toBe(true);
    const id = o.lines[0] ?? '';
    const o2 = out();
    const attached = await runSessionsCommand(
      { command: 'attach', id: id, tail: 0 },
      {
        sessionsRoot: root,
        out: o2.write,
      },
    );
    expect(attached).toBe(0);
    expect(o2.lines.some((line) => line.includes('posture: full-access'))).toBe(
      true,
    );
  });

  it('defaults to approvals enforced and rejects bad ids', async () => {
    const root = tmpRoot();
    const o = out();
    expect(
      await runSessionsCommand(
        { command: 'create', cwd: '/work' },
        {
          sessionsRoot: root,
          out: o.write,
        },
      ),
    ).toBe(0);
    const id = o.lines[0] ?? '';
    const o2 = out();
    expect(
      await runSessionsCommand(
        { command: 'attach', id: id, tail: 0 },
        {
          sessionsRoot: root,
          out: o2.write,
        },
      ),
    ).toBe(0);
    expect(
      o2.lines.some((line) => line.includes('posture: approvals enforced')),
    ).toBe(true);
    const o3 = out();
    expect(
      await runSessionsCommand(
        { command: 'attach', id: '../../etc', tail: 0 },
        {
          sessionsRoot: root,
          out: o3.write,
        },
      ),
    ).toBe(2);
    expect(o3.lines.some((line) => line.includes('invalid session id'))).toBe(
      true,
    );
  });
});
