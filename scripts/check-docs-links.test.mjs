import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkDocsLinks } from './check-docs-links.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const CLI = join(ROOT, 'scripts', 'check-docs-links.mjs');

const scratchDirs = [];
after(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), 'docs-links-'));
  scratchDirs.push(dir);
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

describe('check-docs-links CLI (npm run docs:check)', () => {
  it('exits 1 naming the dangling link', () => {
    const dir = fixture({ 'docs/a.md': '[gone](./missing.md)\n' });
    const result = spawnSync(process.execPath, [CLI, '--root', dir], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 1, 'a dangling link must fail the gate');
    assert.match(result.stderr, /dangling link: .*missing\.md/);
    assert.doesNotMatch(result.stdout, /docs links OK/);
  });

  it('exits 0 on a clean fixture', () => {
    const dir = fixture({ 'docs/a.md': '[b](./b.md)\n', 'docs/b.md': '# b\n' });
    const result = spawnSync(process.execPath, [CLI, '--root', dir], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /docs links OK/);
  });
});
