// The baseline digest cache: an unchanged file is not read again, any change
// to a file (its size, its content under a restored modification time) is
// re-read, a racily-clean file is re-read, and the persisted cache is private
// and ignored when it is corrupt or belongs to another workspace.
import { readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../../test/temp-dir.js';
import type { FileBridge } from '../file-bridge.js';
import { createNodeFileBridge } from '../file-bridge.js';
import { captureBaseline } from './baseline.js';
import { createBaselineCache } from './baseline-cache.js';

// A bridge that counts content reads, so a test can see what was re-read.
function countingBridge(): { bridge: FileBridge; reads: string[] } {
  const base = createNodeFileBridge('/');
  const reads: string[] = [];
  const bridge: FileBridge = {
    ...base,
    readTextFile: (path) => {
      reads.push(path);
      return base.readTextFile(path);
    },
    readFileRange: (path, start, end) => {
      reads.push(path);
      return base.readFileRange?.(path, start, end) ?? new Uint8Array();
    },
  };
  return { bridge, reads };
}

function tree(): string {
  const root = tempDir('baseline-cache-');
  writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(root, 'b.ts'), 'export const b = 2;\n');
  return root;
}

// A walk whose clock runs ahead of the files' own times: every file is
// settled, so the racy rule does not get in the way of a reuse test.
const SETTLED = (): number => Date.now() + 60_000;

describe('baseline digest cache', () => {
  it('reads no unchanged file on the next walk and yields the same digests', () => {
    const root = tree();
    const cache = createBaselineCache(root);
    cache.begin(SETTLED());
    const first = captureBaseline(root, { cache });
    cache.commit();
    const { bridge, reads } = countingBridge();
    cache.begin(SETTLED());
    const second = captureBaseline(root, { cache, bridge });
    cache.commit();
    expect(reads).toEqual([]);
    expect(second).toEqual(first);
  });

  it('re-reads a file whose size changed, and only that file', () => {
    const root = tree();
    const cache = createBaselineCache(root);
    cache.begin(SETTLED());
    captureBaseline(root, { cache });
    cache.commit();
    writeFileSync(join(root, 'a.ts'), 'export const a = 100;\n');
    const { bridge, reads } = countingBridge();
    cache.begin(SETTLED());
    const second = captureBaseline(root, { cache, bridge });
    expect(reads).toEqual([join(root, 'a.ts')]);
    expect(second['a.ts']).toBe(captureBaseline(root)['a.ts']);
  });

  it('re-reads a same-size change even when the modification time is restored', () => {
    const root = tree();
    const path = join(root, 'a.ts');
    const before = statSync(path);
    const cache = createBaselineCache(root);
    cache.begin(SETTLED());
    captureBaseline(root, { cache });
    cache.commit();
    writeFileSync(path, 'export const a = 9;\n');
    utimesSync(path, before.atime, before.mtime);
    const { bridge, reads } = countingBridge();
    cache.begin(SETTLED());
    const second = captureBaseline(root, { cache, bridge });
    expect(reads).toEqual([path]);
    expect(second['a.ts']).toBe(captureBaseline(root)['a.ts']);
  });

  it('re-reads a racily clean file: one changed just before the walk that hashed it', () => {
    const root = tree();
    const cache = createBaselineCache(root);
    // A walk that starts right now: the files were written moments ago.
    cache.begin(Date.now());
    captureBaseline(root, { cache });
    cache.commit();
    const { bridge, reads } = countingBridge();
    cache.begin(SETTLED());
    captureBaseline(root, { cache, bridge });
    expect(reads.sort()).toEqual([join(root, 'a.ts'), join(root, 'b.ts')]);
  });

  it('persists privately and is reused by a later run', () => {
    const root = tree();
    const dir = join(tempDir('baseline-cache-dir-'), 'cache');
    const path = join(dir, 'ws.json');
    const first = createBaselineCache(root, path);
    first.begin(SETTLED());
    captureBaseline(root, { cache: first });
    first.commit();
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    const later = createBaselineCache(root, path);
    const { bridge, reads } = countingBridge();
    later.begin(SETTLED());
    captureBaseline(root, { cache: later, bridge });
    expect(reads).toEqual([]);
  });

  it('ignores a corrupt cache file and one written for another workspace', () => {
    const root = tree();
    const dir = tempDir('baseline-cache-dir-');
    const corrupt = join(dir, 'corrupt.json');
    writeFileSync(corrupt, '{not json');
    const foreign = join(dir, 'foreign.json');
    const other = createBaselineCache(tree(), foreign);
    other.begin(SETTLED());
    other.commit();
    expect(JSON.parse(readFileSync(foreign, 'utf8')).root).not.toBe(root);
    for (const path of [corrupt, foreign]) {
      const cache = createBaselineCache(root, path);
      const { bridge, reads } = countingBridge();
      cache.begin(SETTLED());
      captureBaseline(root, { cache, bridge });
      expect(reads.length).toBe(2);
    }
  });
});
