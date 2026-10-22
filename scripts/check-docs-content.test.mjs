// The docs content check: table shape and cell length, no <picture>, image
// alt text and targets, and the assets' budget, use and safety.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  ASSET_BUDGET_BYTES,
  CELL_LIMIT,
  checkDocsContent,
  pageImages,
  pictureProblems,
  svgProblems,
  tableProblems,
} from './check-docs-content.mjs';

describe('tableProblems', () => {
  it('passes a whole table of short cells', () => {
    assert.deepEqual(
      tableProblems('| A | B |\n| --- | --- |\n| `a\\|b` | one line |\n'),
      [],
    );
  });

  it('names a cell over the limit', () => {
    const long = 'x'.repeat(CELL_LIMIT + 1);
    assert.match(
      tableProblems(`| A | B |\n| --- | --- |\n| a | ${long} |\n`)[0],
      /^line 3: a 301-character table cell/,
    );
  });

  it('names a row cut off from its table and prose inside one', () => {
    assert.deepEqual(
      tableProblems(
        '| A | B |\n| --- | --- |\n| a | b |\nprose\n\n| c | d |\n',
      ),
      ['line 4: prose inside a table', 'line 6: a table row outside a table'],
    );
  });

  it('leaves code blocks alone', () => {
    assert.deepEqual(tableProblems('```\n| not | a table |\n```\n'), []);
  });
});

describe('pictureProblems', () => {
  it('names a <picture> outside code', () => {
    assert.deepEqual(
      pictureProblems(
        '<img src="a.svg" alt="A">\n<picture>\n  <img src="b.svg" alt="B">\n</picture>\n```html\n<picture></picture>\n```\nNever a `<picture>`.\n',
      ),
      [
        "line 2: a <picture>, which GitHub's mobile apps leave out: show the image with <img> or Markdown",
      ],
    );
  });
});

describe('pageImages', () => {
  it('reads Markdown and HTML images and whether they have alt text', () => {
    assert.deepEqual(
      pageImages(
        '![A shot](a.svg) ![](b.svg)\n<img src="c.svg" alt=""> <img src="d.svg">\n<source media="x" srcset="e.svg">\n',
      ),
      [
        { src: 'a.svg', alt: true },
        { src: 'b.svg', alt: false },
        { src: 'c.svg', alt: true },
        { src: 'd.svg', alt: false },
        { src: 'e.svg', alt: true },
      ],
    );
  });
});

describe('svgProblems', () => {
  it('passes a self-contained SVG', () => {
    assert.deepEqual(
      svgProblems(
        '<svg xmlns="http://www.w3.org/2000/svg"><style>.a{fill:red}</style><use href="#r0"/></svg>',
      ),
      [],
    );
  });

  it('names scripts, handlers and anything fetched from outside', () => {
    assert.deepEqual(
      svgProblems(
        '<svg onload="x()"><script>x()</script><image href="https://e.com/a.png"/><style>@import "x.css"</style></svg>',
      ),
      [
        'a script',
        'an event handler',
        'an outside reference',
        'an outside stylesheet or font',
      ],
    );
  });
});

describe('checkDocsContent', () => {
  let root;
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function fixture(files) {
    root = mkdtempSync(join(tmpdir(), 'docs-content-'));
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(root, path, '..'), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    return root;
  }

  it('passes when every asset is shown, small and self-contained', () => {
    fixture({
      'README.md': '![Kubic](docs/assets/a.svg)\n',
      'docs/assets/a.svg': '<svg></svg>',
    });
    assert.deepEqual(checkDocsContent(root), []);
  });

  it('names a missing image, an unused asset and one over the budget', () => {
    fixture({
      'README.md': '![Gone](docs/assets/gone.svg)\n',
      'docs/assets/unused.png': 'x'.repeat(ASSET_BUDGET_BYTES + 1),
    });
    assert.deepEqual(checkDocsContent(root), [
      'README.md: docs/assets/gone.svg does not exist',
      `docs/assets/unused.png: ${ASSET_BUDGET_BYTES + 1} bytes, over the ${ASSET_BUDGET_BYTES}-byte budget`,
      'docs/assets/unused.png: no page shows it',
    ]);
  });
});
