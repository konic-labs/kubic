// Pi FileSystem over the exec file bridge (Pi 1.0 surface).
//
// 1.0 `FileSystem` adds `id`, `truncateFile` and `flushFile`; the adapter must
// implement the whole interface over the exec bridge, and the portable JSONL
// storage core must be able to run its whole contract through it.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  createNodeFileBridge,
  type FileBridge,
} from '../../../exec/src/file-bridge.js';
import {
  BACKGROUND_CONTEXT,
  JsonlStorage,
  registerStorageConformance,
} from '../pi-boundary.js';
import { bridgeToPiFileSystem } from './session-fs.js';

const scratchDirs: string[] = [];

afterAll(() => {
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

function setup(files: Record<string, string>): {
  fs: ReturnType<typeof bridgeToPiFileSystem>;
} {
  const root = scratch('session-fs-');
  const bridge = createNodeFileBridge(root);
  for (const [name, content] of Object.entries(files)) {
    bridge.writeFile(name, content);
  }
  return { fs: bridgeToPiFileSystem(bridge) };
}

describe('bridgeToPiFileSystem 1.0 surface', () => {
  it('reports the local node file namespace', () => {
    const root = scratch('session-fs-');
    expect(bridgeToPiFileSystem(createNodeFileBridge(root)).id).toBe(
      'node:local',
    );
  });

  it('truncates a file to exactly the requested size', async () => {
    const { fs } = setup({ 'a.txt': 'keep\ndrop\n' });
    const truncated = await fs.truncateFile('a.txt', 5, BACKGROUND_CONTEXT);
    if (!truncated.ok) throw truncated.error;
    const read = await fs.readTextFile('a.txt', BACKGROUND_CONTEXT);
    if (!read.ok) throw read.error;
    expect(read.value).toBe('keep\n');
  });

  it('flushes through the bridge', async () => {
    const root = scratch('session-fs-');
    const inner = createNodeFileBridge(root);
    inner.writeFile('a.txt', 'content');
    let flushes = 0;
    const fs = bridgeToPiFileSystem({
      ...inner,
      flushFile: (path: string): void => {
        flushes += 1;
        inner.flushFile?.(path);
      },
    } as FileBridge);
    const flushed = await fs.flushFile('a.txt', BACKGROUND_CONTEXT);
    expect(flushed.ok).toBe(true);
    expect(flushes).toBe(1);
  });

  it('maps a bridge without the new primitives to not_supported', async () => {
    const root = scratch('session-fs-');
    const inner = createNodeFileBridge(root);
    inner.writeFile('a.txt', 'content');
    const { flushFile: _flush, truncateFile: _truncate, ...rest } = inner;
    const fs = bridgeToPiFileSystem(rest as FileBridge);
    const flushed = await fs.flushFile('a.txt', BACKGROUND_CONTEXT);
    expect(flushed.ok).toBe(false);
    if (flushed.ok) throw new Error('expected failure');
    expect(flushed.error.code).toBe('not_supported');
    const truncated = await fs.truncateFile('a.txt', 1, BACKGROUND_CONTEXT);
    expect(truncated.ok).toBe(false);
    if (truncated.ok) throw new Error('expected failure');
    expect(truncated.error.code).toBe('not_supported');
  });
});

describe('bridgeToPiFileSystem.openTextLineReader', () => {
  it('reads terminated lines with terminated=true', async () => {
    const { fs } = setup({ 'a.txt': 'one\ntwo\n' });
    const opened = await fs.openTextLineReader('a.txt', BACKGROUND_CONTEXT);
    if (!opened.ok) throw opened.error;
    const reader = opened.value;
    const first = await reader.readLine(BACKGROUND_CONTEXT);
    const second = await reader.readLine(BACKGROUND_CONTEXT);
    const end = await reader.readLine(BACKGROUND_CONTEXT);
    if (!first.ok || first.value === undefined) throw new Error('line 1');
    if (!second.ok || second.value === undefined) throw new Error('line 2');
    expect(first.value).toEqual({ text: 'one', terminated: true });
    expect(second.value).toEqual({ text: 'two', terminated: true });
    expect(end.ok && end.value).toBeUndefined();
    await reader.close(BACKGROUND_CONTEXT);
  });

  it('marks a torn final line terminated=false', async () => {
    const { fs } = setup({ 'b.txt': 'one\ntwo' });
    const opened = await fs.openTextLineReader('b.txt', BACKGROUND_CONTEXT);
    if (!opened.ok) throw opened.error;
    const reader = opened.value;
    const first = await reader.readLine(BACKGROUND_CONTEXT);
    const second = await reader.readLine(BACKGROUND_CONTEXT);
    if (!first.ok || first.value === undefined) throw new Error('line 1');
    if (!second.ok || second.value === undefined) throw new Error('line 2');
    expect(first.value).toEqual({ text: 'one', terminated: true });
    expect(second.value).toEqual({ text: 'two', terminated: false });
    await reader.close(BACKGROUND_CONTEXT);
  });

  it('returns undefined immediately for an empty file', async () => {
    const { fs } = setup({ 'empty.txt': '' });
    const opened = await fs.openTextLineReader('empty.txt', BACKGROUND_CONTEXT);
    if (!opened.ok) throw opened.error;
    const line = await opened.value.readLine(BACKGROUND_CONTEXT);
    expect(line.ok && line.value).toBeUndefined();
    await opened.value.close(BACKGROUND_CONTEXT);
  });

  it('maps a missing file to not_found instead of throwing', async () => {
    const { fs } = setup({});
    const opened = await fs.openTextLineReader(
      'missing.txt',
      BACKGROUND_CONTEXT,
    );
    expect(opened.ok).toBe(false);
    if (opened.ok) throw new Error('expected failure');
    expect(opened.error.code).toBe('not_found');
  });
});

// The adapter is what the session storage writes through, so pi-durable's own
// storage contract has to hold over the exec bridge: the whole portable JSONL
// suite runs against a real temp directory and the node bridge.
describe('JSONL storage over the exec bridge', () => {
  registerStorageConformance(
    { describe, expect, it },
    'bridgeToPiFileSystem + JsonlStorage',
    async (use) => {
      const dir = scratch('session-conformance-');
      const bridge = createNodeFileBridge(dir);
      const storage = await JsonlStorage.open(
        dir,
        bridgeToPiFileSystem(bridge),
        BACKGROUND_CONTEXT,
      );
      try {
        await use(storage);
      } finally {
        await storage.close(BACKGROUND_CONTEXT);
      }
    },
  );
});
