import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkDocsLinks } from './check-docs-links.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), 'docs-links-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

describe('check-docs-links', () => {
  it('passes on the real docs/ scaffold (no dangling internal links)', () => {
    const result = checkDocsLinks(ROOT);
    assert.deepEqual(result.broken, []);
    assert.ok(
      result.files >= 19,
      `expected >=19 docs pages, got ${result.files}`,
    );
    assert.ok(result.links > 0, 'expected at least one internal link');
  });

  it('reports a dangling relative link', () => {
    const dir = fixture({ 'docs/a.md': '[gone](./missing.md)\n' });
    const result = checkDocsLinks(dir);
    assert.equal(result.broken.length, 1);
    assert.match(result.broken[0], /missing\.md/);
  });

  it('ignores external URLs and same-page anchors', () => {
    const dir = fixture({
      'docs/a.md':
        '[web](https://example.com/x) [mail](mailto:a@b.c) [here](#section)\n',
    });
    const result = checkDocsLinks(dir);
    assert.deepEqual(result.broken, []);
  });
});
