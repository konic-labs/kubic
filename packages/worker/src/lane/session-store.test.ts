// Slice A: JSONL session store — create, attach restores, jq-inspectable.
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createNodeFileBridge } from '../../../exec/src/file-bridge.js';
import { BACKGROUND_CONTEXT, type Session } from '../pi-boundary.js';
import {
  attachSession,
  createSession,
  openSessionStore,
} from './session-store.js';

const openSessions: Session[] = [];

afterAll(async () => {
  for (const session of openSessions.splice(0)) {
    await session.close(BACKGROUND_CONTEXT);
  }
});

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), 'sessions-'));
}

describe('JSONL session store (issue #14, slice A)', () => {
  it('creates a session with cwd metadata', async () => {
    const root = tmpRoot();
    const store = openSessionStore(root, createNodeFileBridge(root));
    const session = await createSession(store, '/work', BACKGROUND_CONTEXT);
    openSessions.push(session);
    expect(session.metadata.cwd).toBe('/work');
    expect(session.metadata.id.length).toBeGreaterThan(0);
  });

  it('attach restores transcript after close', async () => {
    const root = tmpRoot();
    const bridge = createNodeFileBridge(root);
    const store = openSessionStore(root, bridge);
    const session = await createSession(store, '/work', BACKGROUND_CONTEXT);
    const id = session.metadata.id;
    await session.mutate(async (mutator) => {
      await mutator.commit(
        [
          {
            kind: 'entry',
            entry: {
              id: 'e-hello',
              parentId: null,
              type: 'message',
              message: {
                role: 'user',
                content: [{ type: 'text', text: 'hello' }],
                timestamp: Date.now(),
              },
            },
          },
        ],
        BACKGROUND_CONTEXT,
      );
    }, BACKGROUND_CONTEXT);
    await session.close(BACKGROUND_CONTEXT);

    const store2 = openSessionStore(root, createNodeFileBridge(root));
    const attached = await attachSession(store2, id, BACKGROUND_CONTEXT);
    openSessions.push(attached);
    const entries = await attached.findEntries(undefined, BACKGROUND_CONTEXT);
    expect(JSON.stringify(entries)).toContain('hello');
  });

  it('writes jq-inspectable JSONL under the sessions root', async () => {
    const root = tmpRoot();
    const store = openSessionStore(root, createNodeFileBridge(root));
    const session = await createSession(store, '/work', BACKGROUND_CONTEXT);
    openSessions.push(session);
    const jsonlFiles: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, name.name);
        if (name.isDirectory()) walk(full);
        else if (name.name.endsWith('.jsonl')) jsonlFiles.push(full);
      }
    };
    walk(root);
    expect(jsonlFiles.length).toBeGreaterThan(0);
    let lines = 0;
    for (const file of jsonlFiles) {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (line.trim().length === 0) continue;
        lines += 1;
        expect(() => JSON.parse(line)).not.toThrow();
      }
    }
    expect(lines).toBeGreaterThan(0);
  });
});
