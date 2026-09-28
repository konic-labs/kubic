// Pi FileSystem line-reader adapter coverage (issue #71).
// Pi 0.87.1 adds FileSystem.openTextLineReader (+ TextLine/TextLineReader);
// the bridge adapter must expose it with correct final-line termination so
// JsonlSessionRepo can discard torn trailing records.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createNodeFileBridge } from '../../../exec/src/file-bridge.js';
import { BACKGROUND_CONTEXT } from '../pi-boundary.js';
import { bridgeToPiFileSystem } from './session-fs.js';

const scratchDirs: string[] = [];

afterAll(() => {
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function setup(files: Record<string, string>): {
  fs: ReturnType<typeof bridgeToPiFileSystem>;
} {
  const root = mkdtempSync(join(tmpdir(), 'session-fs-'));
  scratchDirs.push(root);
  const bridge = createNodeFileBridge(root);
  for (const [name, content] of Object.entries(files)) {
    bridge.writeFile(name, content);
  }
  return { fs: bridgeToPiFileSystem(bridge) };
}

describe('bridgeToPiFileSystem.openTextLineReader (issue #71)', () => {
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
