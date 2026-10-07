// Lane journal wiring + durable next-day undo.
// The lane boots through the shared faux harness factory: the journal
// row it records is the durable `api.callId` of the model's own tool call.
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { FileJournalStore, restoreEntry } from '../../../exec/src/journal.js';
import { fauxAssistantMessage, fauxToolCall } from '../pi-boundary.js';
import { bootFauxLane, type FauxLane, fauxToolUse } from './test-harness.js';

const lanes: FauxLane[] = [];
const scratchDirs: string[] = [];
afterAll(async () => {
  for (const lane of lanes.splice(0)) {
    await lane.cleanup();
  }
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

describe('lane journal wiring', () => {
  it('records a lane write into the session journal with toolCallId', async () => {
    const journal = new FileJournalStore(scratch('j-'));
    const lane = await bootFauxLane({
      journal,
      responses: [
        fauxToolUse([
          fauxToolCall(
            'write',
            { path: 'n.txt', content: 'hi\n' },
            { id: 'call-write-1' },
          ),
        ]),
        fauxAssistantMessage('wrote it'),
      ],
    });
    lanes.push(lane);
    const outcome = await lane.run('write the file');
    expect(outcome.status).toBe('completed');
    const entries = journal.entries();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.op).toBe('create');
    // The journal row carries the model's own tool call id, not a synthetic one.
    expect(entries[0]?.toolCallId).toBe('call-write-1');
    expect(lane.env.fs.readFile('n.txt')).toBe('hi\n');
  });

  it('carries the lane turn supplier value on tool entries', async () => {
    const journal = new FileJournalStore(scratch('j-'));
    const lane = await bootFauxLane({
      journal,
      // The TUI's reconcileTurn, sampled per call: the sweep of turn 7
      // and this write share one numbering.
      currentTurn: () => 7,
      responses: [
        fauxToolUse([
          fauxToolCall(
            'write',
            { path: 'n.txt', content: 'hi\n' },
            { id: 'call-write-7' },
          ),
        ]),
        fauxAssistantMessage('wrote it'),
      ],
    });
    lanes.push(lane);
    const outcome = await lane.run('write the file');
    expect(outcome.status).toBe('completed');
    const entries = journal.entries();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.turn).toBe(7);
  });

  it('leaves tool entries turn-less with no supplier: headless by design', async () => {
    const journal = new FileJournalStore(scratch('j-'));
    const lane = await bootFauxLane({
      journal,
      responses: [
        fauxToolUse([
          fauxToolCall(
            'write',
            { path: 'n.txt', content: 'hi\n' },
            { id: 'call-write-0' },
          ),
        ]),
        fauxAssistantMessage('wrote it'),
      ],
    });
    lanes.push(lane);
    const outcome = await lane.run('write the file');
    expect(outcome.status).toBe('completed');
    const entries = journal.entries();
    expect(entries).toHaveLength(1);
    // No `turn` field at all — not null, not zero.
    expect(entries[0]).not.toHaveProperty('turn');
  });
});

describe('durable next-day undo', () => {
  it('reopens the journal from disk and restores before-content', () => {
    const dir = scratch('j-');
    const root = scratch('ws-');
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
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('original\n');
    const entries = dayTwo.entries();
    expect(entries).toHaveLength(1);
  });

  it('reports unattributed entries non-reversible instead of corrupting', () => {
    const dir = scratch('j-');
    const root = scratch('ws-');
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
      reason:
        'no before-content: no retrievable pre-image for this entry — nothing to restore',
    });
  });

  it('refuses to restore entry paths escaping the workspace root', () => {
    const dir = scratch('j-');
    const root = scratch('ws-');
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

  it('still restores dot-dot names that stay inside, and refuses symlink parents', () => {
    const dir = scratch('j-');
    const root = scratch('ws-');
    // restoreEntry verifies the disk sits at the entry's
    // recorded after-state before writing — seed the after-content so the
    // restore path is exercised rather than the staleness refusal.
    writeFileSync(join(root, '..foo'), 'after\n');
    const outside = scratch('out-');
    symlinkSync(outside, join(root, 'linked'));
    const store = new FileJournalStore(dir);
    const inside = store.append({
      path: '..foo',
      op: 'write',
      before: 'before\n',
      after: 'after\n',
      bytesDelta: 1,
      sessionId: 's1',
      agentId: 'root',
      toolCallId: 'call-1',
      timestamp: 1,
    });
    expect(restoreEntry(store, inside, root)).toEqual({ restored: true });
    expect(readFileSync(join(root, '..foo'), 'utf8')).toBe('before\n');
    const linked = store.append({
      path: 'linked/evil.txt',
      op: 'write',
      before: 'before\n',
      after: 'after\n',
      bytesDelta: 1,
      sessionId: 's1',
      agentId: 'root',
      toolCallId: 'call-1',
      timestamp: 2,
    });
    expect(restoreEntry(store, linked, root)).toEqual({
      restored: false,
      reason: 'entry path crosses a symlink: linked/evil.txt',
    });
  });
});
