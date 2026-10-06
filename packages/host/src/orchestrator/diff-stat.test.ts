// The worker change summary (issue #464), counted from the run's per-file
// `git diff` hunks.
import { describe, expect, it } from 'vitest';
import { diffStatOfHunks } from './diff-stat.js';

const NEW_FILE = [
  'diff --git a/a.txt b/a.txt',
  'new file mode 100644',
  'index 0000000..abc1234',
  '--- /dev/null',
  '+++ b/a.txt',
  '@@ -0,0 +1,2 @@',
  '+alpha',
  '++plus-prefixed content',
  '',
].join('\n');

const EDIT = [
  'diff --git a/src/cart.js b/src/cart.js',
  'index 1111111..2222222 100644',
  '--- a/src/cart.js',
  '+++ b/src/cart.js',
  '@@ -9,3 +9,3 @@ function total(items) {',
  '   let sum = 0;',
  '-  sum = 1;',
  '---removed dashes',
  '+  sum += 1;',
  '\\ No newline at end of file',
  '',
].join('\n');

describe('diffStatOfHunks (issue #464)', () => {
  it('counts body lines, never the file headers', () => {
    expect(
      diffStatOfHunks([
        { path: 'a.txt', hunk: NEW_FILE },
        { path: 'src/cart.js', hunk: EDIT },
      ]),
    ).toEqual({ files: 2, added: 3, removed: 2 });
  });

  it('counts a file with no line body as changed', () => {
    expect(
      diffStatOfHunks([
        {
          path: 'logo.png',
          hunk: 'diff --git a/logo.png b/logo.png\nBinary files differ\n',
        },
      ]),
    ).toEqual({ files: 1, added: 0, removed: 0 });
  });

  it('reads no hunks as no change', () => {
    expect(diffStatOfHunks([])).toEqual({ files: 0, added: 0, removed: 0 });
  });
});
