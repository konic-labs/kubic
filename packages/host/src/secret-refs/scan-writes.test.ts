import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createNodeFileBridge } from '@kubic/exec/file-bridge';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../../test/temp-dir.js';
import { scanBridgeWrites } from './scan-writes.js';

const LINE = 'API_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\n';

describe('scanBridgeWrites', () => {
  it('scans what a session stores and leaves the journal verbatim', () => {
    const root = tempDir('scan-writes-');
    const found: number[] = [];
    const bridge = scanBridgeWrites(createNodeFileBridge(root), (count) =>
      found.push(count),
    );
    bridge.createDir(join('s1', 'journal'), true);
    bridge.appendFile(join('s1', 'main.jsonl'), LINE);
    bridge.writeFile(join('s1', 'trajectory.json'), LINE);
    bridge.appendFile(join('s1', 'journal', 'index.jsonl'), LINE);
    expect(readFileSync(join(root, 's1', 'main.jsonl'), 'utf8')).toBe(
      'API_KEY=[redacted-secret]\n',
    );
    expect(readFileSync(join(root, 's1', 'trajectory.json'), 'utf8')).toBe(
      'API_KEY=[redacted-secret]\n',
    );
    expect(
      readFileSync(join(root, 's1', 'journal', 'index.jsonl'), 'utf8'),
    ).toBe(LINE);
    expect(found).toEqual([1, 1]);
  });
});
