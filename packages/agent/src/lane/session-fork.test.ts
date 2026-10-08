// Session fork (on pi-durable — the re-baseline):
// a NEW session (own directory, lock and journal) whose lane runs a
// pi-durable fork of the source's lane at an entry. Faux provider, real
// JSONL sessions under a temp root; everything is cleaned up in afterEach.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createNodeFileBridge } from '../../../exec/src/file-bridge.js';
import {
  BACKGROUND_CONTEXT,
  fauxAssistantMessage,
  UsageDoc,
} from '../pi-boundary.js';
import {
  attachSession,
  createSession,
  forkSession,
  listSessions,
  openSessionStore,
  readSessionMetadata,
  SessionLockError,
} from './session-store.js';
import { bootFauxLane } from './test-harness.js';
import { readSessionEntries } from './transcript.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function tmpRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'kubic-fork-'));
  roots.push(root);
  return root;
}

function textOf(entry: { model?: unknown }): string {
  const message = (
    entry.model as Array<{ content?: unknown }> | undefined
  )?.[0];
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part as { text?: string }).text ?? '')
      .join('');
  }
  return '';
}

/** A finished two-turn source session, released (no live lock). */
async function twoTurnSource(root: string) {
  const lane = await bootFauxLane({
    storage: 'jsonl',
    root,
    responses: [
      fauxAssistantMessage('first answer'),
      fauxAssistantMessage('second answer'),
    ],
  });
  await lane.run('first prompt');
  await lane.run('second prompt');
  const entries = await readSessionEntries(
    lane.session.storage,
    BACKGROUND_CONTEXT,
  );
  const firstAnswer = entries.find((entry) => textOf(entry) === 'first answer');
  await lane.cleanup();
  return { id: lane.sessionId, firstAnswerId: Number(firstAnswer?.id) };
}

describe('kubic sessions fork: the store', () => {
  it('a branch fork sees history through the cut, not after it, and runs on its own', async () => {
    const root = tmpRoot();
    const source = await twoTurnSource(root);
    const store = openSessionStore(root, createNodeFileBridge(root));
    const fork = await forkSession(
      store,
      source.id,
      { at: source.firstAnswerId },
      BACKGROUND_CONTEXT,
    );
    expect(fork).toMatchObject({ source: source.id, at: source.firstAnswerId });
    expect(fork.id).not.toBe(source.id);

    const handle = await attachSession(store, fork.id, BACKGROUND_CONTEXT);
    const meta = await readSessionMetadata(handle.storage, BACKGROUND_CONTEXT);
    expect(meta?.forkedFrom).toEqual({
      session: source.id,
      at: source.firstAnswerId,
    });
    const texts = (
      await readSessionEntries(handle.storage, BACKGROUND_CONTEXT)
    ).map(textOf);
    expect(texts).toContain('first prompt');
    expect(texts).toContain('first answer');
    expect(texts).not.toContain('second prompt');
    // The fork boots and runs a turn of its own on its recorded lane.
    const lane = await bootFauxLane({
      handle,
      responses: [fauxAssistantMessage('forked answer')],
    });
    try {
      await lane.run('fork prompt');
      const after = (await lane.entries()).map(textOf);
      expect(after).toContain('forked answer');
      expect(after).not.toContain('second answer');
    } finally {
      await lane.cleanup();
    }
  });

  it('copies no usage: the fork starts at zero spend', async () => {
    const root = tmpRoot();
    const source = await twoTurnSource(root);
    const store = openSessionStore(root, createNodeFileBridge(root));
    const fork = await forkSession(
      store,
      source.id,
      { at: source.firstAnswerId },
      BACKGROUND_CONTEXT,
    );
    const handle = await attachSession(store, fork.id, BACKGROUND_CONTEXT);
    try {
      // Every conversation's `pi.usage` document in the fork is empty — the
      // same documents `kubic cost` sums.
      const storage = handle.storage;
      const conversations = await storage.scanConversations(
        {},
        256,
        undefined,
        BACKGROUND_CONTEXT,
      );
      expect(conversations.items.length).toBeGreaterThanOrEqual(2);
      for (const conversation of conversations.items) {
        const record = await storage.findDocument(
          {
            kind: UsageDoc.definition.kind,
            scope: { kind: 'conversation', conversationId: conversation.id },
          },
          'current',
          BACKGROUND_CONTEXT,
        );
        if (record === undefined) continue;
        const stored = await storage.document(
          record.id,
          'current',
          BACKGROUND_CONTEXT,
        );
        expect(stored?.value).toMatchObject({ models: {}, tools: {} });
      }
    } finally {
      await handle.release(BACKGROUND_CONTEXT);
    }
  });

  it('--tree keeps every conversation and the whole lane history', async () => {
    const root = tmpRoot();
    const source = await twoTurnSource(root);
    const store = openSessionStore(root, createNodeFileBridge(root));
    const fork = await forkSession(
      store,
      source.id,
      { tree: true },
      BACKGROUND_CONTEXT,
    );
    expect(fork.at).toBeUndefined();
    const handle = await attachSession(store, fork.id, BACKGROUND_CONTEXT);
    try {
      const texts = (
        await readSessionEntries(handle.storage, BACKGROUND_CONTEXT)
      ).map(textOf);
      expect(texts).toContain('second answer');
    } finally {
      await handle.release(BACKGROUND_CONTEXT);
    }
  });

  it('refuses to fork a live-locked session, and writes nothing', async () => {
    const root = tmpRoot();
    const source = await twoTurnSource(root);
    const store = openSessionStore(root, createNodeFileBridge(root));
    const live = await attachSession(store, source.id, BACKGROUND_CONTEXT);
    try {
      await expect(
        forkSession(store, source.id, { id: 'fork-live' }, BACKGROUND_CONTEXT),
      ).rejects.toBeInstanceOf(SessionLockError);
      expect(store.bridge.exists(join(root, 'fork-live', 'main.jsonl'))).toBe(
        false,
      );
    } finally {
      await live.release(BACKGROUND_CONTEXT);
    }
  });

  it("a fork keeps the source's workspace and cwd", async () => {
    const root = tmpRoot();
    const store = openSessionStore(root, createNodeFileBridge(root));
    const source = await createSession(
      store,
      { id: 'src-1', cwd: '/repo/pkg', workspace: '/repo' },
      BACKGROUND_CONTEXT,
    );
    await source.release(BACKGROUND_CONTEXT);
    const forked = await forkSession(
      store,
      'src-1',
      { id: 'src-1-fork', tree: true },
      BACKGROUND_CONTEXT,
    );
    expect(forked.id).toBe('src-1-fork');
    // The listing header agrees with the copied document before any attach.
    const listed = await listSessions(store, BACKGROUND_CONTEXT);
    expect(
      listed.find((entry) => entry.id === 'src-1-fork')?.meta,
    ).toMatchObject({ cwd: '/repo/pkg', workspace: '/repo' });
  });
});
