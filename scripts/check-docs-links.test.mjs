import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkDocsLinks, pageAnchors } from './check-docs-links.mjs';

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

  it('ignores external URLs', () => {
    const dir = fixture({
      'docs/a.md': '[web](https://example.com/x) [mail](mailto:a@b.c)\n',
    });
    assert.deepEqual(checkDocsLinks(dir).broken, []);
  });

  it('checks anchors on the same page and on another one', () => {
    const dir = fixture({
      'docs/a.md':
        '# A\n\n## The `kubic run` flags\n\n[ok](#the-kubic-run-flags) [ok](b.md#b-part) [bad](#gone) [bad](b.md#gone)\n',
      'docs/b.md': '# B part\n',
    });
    const broken = checkDocsLinks(dir).broken.map((b) =>
      b.replace(`${dir}/`, ''),
    );
    assert.deepEqual(broken, [
      'docs/a.md: #gone (no such heading)',
      'docs/a.md: b.md#gone (no such heading)',
    ]);
  });

  it('checks the root markdown and accepts a link to a directory', () => {
    const dir = fixture({
      'README.md': '[docs](docs/) [src](src/) [gone](docs/missing.md)\n',
      'docs/README.md': '# Docs\n',
      'src/x.ts': '',
    });
    const broken = checkDocsLinks(dir).broken.map((b) =>
      b.replace(`${dir}/`, ''),
    );
    assert.deepEqual(broken, ['README.md: docs/missing.md']);
  });
});

describe('pageAnchors', () => {
  it('slugs headings the way GitHub does, repeats and ids included', () => {
    assert.deepEqual(
      [
        ...pageAnchors(
          '# `kubic trust [--revoke] [path]`\n## Notes\n## Notes\n```\n# not a heading\n```\n<a id="custom"></a>\n',
        ),
      ],
      ['kubic-trust---revoke-path', 'notes', 'notes-1', 'custom'],
    );
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
