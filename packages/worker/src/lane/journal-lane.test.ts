// Slice D: lane journal wiring + durable next-day undo (issue #17; §42.4).
// RED: SoloBootOptions has no journal; restoreEntry does not exist.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { FakeExecutionEnv } from '../../../exec/src/env.js';
import { FileJournalStore, restoreEntry } from '../../../exec/src/journal.js';
import {
  BACKGROUND_CONTEXT,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  MemorySessionRepo,
  type Session,
} from '../pi-boundary.js';
import { bootSoloLane, driveToSettled } from './solo.js';

const openSessions: Session[] = [];
afterAll(async () => {
  for (const session of openSessions) {
    await session.close(BACKGROUND_CONTEXT);
  }
});

describe('lane journal wiring (issue #17, slice D)', () => {
  it('records a lane write into the session journal with toolCallId', async () => {
    const journal = new FileJournalStore(mkdtempSync(join(tmpdir(), 'j-')));
    const env = new FakeExecutionEnv({});
    const repo = new MemorySessionRepo();
    const session = await repo.create({}, BACKGROUND_CONTEXT);
    openSessions.push(session);
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall('write', { path: 'n.txt', content: 'hi\n' }),
      ]),
      fauxAssistantMessage('wrote it'),
    ]);
    const { lane } = await bootSoloLane({
      session,
      models,
      model: faux.getModel(),
      env,
      sessionId: session.metadata.id,
      agentId: 'root',
      journal,
    });
    const admission = await lane.accept(
      { kind: 'prompt', prompt: 'write the file' },
      BACKGROUND_CONTEXT,
    );
    if (!admission.ok) throw new Error('accept failed');
    const outcome = await driveToSettled(
      lane,
      admission.value.operationId,
      BACKGROUND_CONTEXT,
    );
    expect(outcome.kind).toBe('settled');
    const entries = journal.entries();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.op).toBe('create');
    expect(entries[0]?.toolCallId).toMatch(/^.+$/);
  });
});

describe('durable next-day undo (issue #17, slice D)', () => {
  it('reopens the journal from disk and restores before-content', () => {
    const dir = mkdtempSync(join(tmpdir(), 'j-'));
    const root = mkdtempSync(join(tmpdir(), 'ws-'));
    writeFileSync(join(root, 'a.txt'), 'original\n');
    const dayOne = new FileJournalStore(dir);
    const recorded = dayOne.append({
      path: 'a.txt',
      op: 'write',
      before: 'original\n',
      after: 'changed\n',
      bytesDelta: 1,
      sessionId: 's1',
      agentId: 'root',
      toolCallId: 'call-1',
      timestamp: 1700000000000,
    });
    // Next day: a fresh store on the same directory, terminal long closed.
    const dayTwo = new FileJournalStore(dir);
    expect(dayTwo.entries()).toHaveLength(1);
    writeFileSync(join(root, 'a.txt'), 'changed\n');
    const result = restoreEntry(dayTwo, recorded, root);
    expect(result).toEqual({ restored: true });
    const entries = dayTwo.entries();
    expect(entries).toHaveLength(1);
  });

  it('reports unattributed entries non-reversible instead of corrupting', () => {
    const dir = mkdtempSync(join(tmpdir(), 'j-'));
    const root = mkdtempSync(join(tmpdir(), 'ws-'));
    const store = new FileJournalStore(dir);
    const recorded = store.append({
      path: 'x.txt',
      op: 'write',
      before: null,
      after: 'mystery\n',
      bytesDelta: 8,
      sessionId: 's1',
      agentId: 'root',
      toolCallId: null,
      timestamp: 1,
      unattributed: true,
    });
    expect(restoreEntry(store, recorded, root)).toEqual({
      restored: false,
      reason: 'no before-content: unattributed entry is not reversible',
    });
  });

  it('refuses to restore entry paths escaping the workspace root', () => {
    const dir = mkdtempSync(join(tmpdir(), 'j-'));
    const root = mkdtempSync(join(tmpdir(), 'ws-'));
    const store = new FileJournalStore(dir);
    const recorded = store.append({
      path: '../evil.txt',
      op: 'write',
      before: 'original\n',
      after: 'changed\n',
      bytesDelta: 1,
      sessionId: 's1',
      agentId: 'root',
      toolCallId: 'call-1',
      timestamp: 1,
    });
    expect(restoreEntry(store, recorded, root)).toEqual({
      restored: false,
      reason: 'entry path escapes the workspace root: ../evil.txt',
    });
  });
});
