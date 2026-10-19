// The index file over a temp directory: appends, torn-tail repair, reading
// legacy lines, and the rewrite a retention pass makes.
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createNodeFileBridge } from '../file-bridge.js';
import { IndexFile, serializeEntry } from './index-file.js';
import type { JournalEntry } from './types.js';

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function indexPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'journal-index-'));
  made.push(dir);
  return join(dir, 'index.jsonl');
}

const bridge = createNodeFileBridge('/');

function entry(n: number): JournalEntry {
  return {
    path: `f${n}.txt`,
    op: 'write',
    beforeHash: null,
    afterHash: `h${n}`,
    deltaHash: null,
    bytesDelta: 1,
    sessionId: 's',
    source: 'tool',
    toolCallId: `c${n}`,
    timestamp: n,
  };
}

const line = (e: JournalEntry): string => `${serializeEntry(e)}\n`;

describe('IndexFile', () => {
  it('appends lines and reads them back', () => {
    const path = indexPath();
    const index = new IndexFile(path, true);
    index.append(bridge, line(entry(1)));
    index.append(bridge, line(entry(2)));
    expect(index.read(bridge)).toEqual({
      entries: [entry(1), entry(2)],
      corruptLines: 0,
      unknownVersionLines: 0,
    });
  });

  it('closes a torn tail before appending, so neither line is lost', () => {
    const path = indexPath();
    writeFileSync(path, `${line(entry(1))}{"path":"torn`);
    const index = new IndexFile(path, true);
    index.append(bridge, line(entry(2)));
    expect(index.read(bridge)).toEqual({
      entries: [entry(1), entry(2)],
      corruptLines: 1,
      unknownVersionLines: 0,
    });
  });

  it('reads a line without a source by the writer it names', () => {
    const path = indexPath();
    const { source: _source, ...legacy } = entry(1);
    writeFileSync(
      path,
      [
        JSON.stringify({ ...legacy, agentId: 'kubic-undo' }),
        JSON.stringify({ ...legacy, agentId: 'root', unattributed: true }),
        JSON.stringify({ ...legacy, agentId: 'root' }),
      ].join('\n'),
    );
    const read = new IndexFile(path, true).read(bridge);
    expect(read.entries.map((e) => e.source)).toEqual([
      'undo',
      'sweep',
      'tool',
    ]);
    expect(read.entries.every((e) => !('agentId' in e))).toBe(true);
  });

  it('tracks its size once seeded, and rewrites onto the kept entries', () => {
    const path = indexPath();
    const index = new IndexFile(path, false);
    index.append(bridge, line(entry(1)));
    expect(index.bytes).toBeNull();
    index.bytes = index.fileSize(bridge);
    index.append(bridge, line(entry(2)));
    expect(index.bytes).toBe(readFileSync(path).byteLength);
    const outcome = index.rewrite(bridge, [entry(2)], index.fileSize(bridge));
    expect(outcome).toEqual({ outcome: 'written' });
    expect(readFileSync(path, 'utf8')).toBe(line(entry(2)));
    expect(index.bytes).toBe(Buffer.byteLength(line(entry(2))));
  });

  // Each line carries the record version: a line without one predates the
  // field and reads as version 1; a line of another version is never read
  // as an entry, is counted, and survives a rewrite verbatim.
  it('reads version-1 and unversioned lines, and sets aside an unknown version', () => {
    const path = indexPath();
    const future = JSON.stringify({
      v: 2,
      path: 'f.txt',
      op: 'write',
      shape: 'new',
    });
    writeFileSync(
      path,
      [
        serializeEntry(entry(1)),
        JSON.stringify(entry(2)),
        future,
        JSON.stringify({ v: 1, ...entry(3), addedLater: true }),
        '',
      ].join('\n'),
    );
    const index = new IndexFile(path, false);
    const read = index.read(bridge);
    expect(read.entries.map((e) => e.path)).toEqual([
      'f1.txt',
      'f2.txt',
      'f3.txt',
    ]);
    expect(read.entries.every((e) => !('v' in e))).toBe(true);
    expect(read.unknownVersionLines).toBe(1);
    expect(read.corruptLines).toBe(0);
    expect(index.rewrite(bridge, [entry(3)], index.fileSize(bridge))).toEqual({
      outcome: 'written',
    });
    expect(readFileSync(path, 'utf8')).toBe(
      `${serializeEntry(entry(3))}\n${future}\n`,
    );
  });

  it('abandons a rewrite when the index changed under the pass', () => {
    const path = indexPath();
    const index = new IndexFile(path, false);
    index.append(bridge, line(entry(1)));
    const sizeAtRead = index.fileSize(bridge);
    // Another writer appends after the pass read the index.
    appendFileSync(path, line(entry(2)));
    expect(index.rewrite(bridge, [], sizeAtRead)).toEqual({
      outcome: 'changed',
    });
    expect(index.read(bridge).entries).toEqual([entry(1), entry(2)]);
    expect(index.bytes).toBeNull();
  });
});
