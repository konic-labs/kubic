// File references as links.
import { describe, expect, it } from 'vitest';
import { fileUrl, linkFileReferences } from './file-links.js';

const files = new Set(['src/cart.js', 'README.md', 'docs/a (b).md']);
const resolve = (path: string): string | undefined => {
  const clean = path.replace(/^\.\//, '');
  return files.has(clean) ? fileUrl('/work/pg', clean) : undefined;
};

describe('file links', () => {
  it('links project paths in prose and inline code, with their line numbers', () => {
    expect(
      linkFileReferences('Fixed src/cart.js:10 and see `README.md`.', resolve),
    ).toBe(
      'Fixed [src/cart.js:10](file:///work/pg/src/cart.js) and see [`README.md`](file:///work/pg/README.md).',
    );
    expect(linkFileReferences('open ./src/cart.js:3:7 now', resolve)).toBe(
      'open [./src/cart.js:3:7](file:///work/pg/src/cart.js) now',
    );
  });

  it('leaves unknown paths, URLs, existing links and fenced code alone', () => {
    const text = [
      'missing/file.ts stays',
      'https://example.com/src/cart.js stays',
      '[cart](src/cart.js) stays',
      '```',
      'src/cart.js stays',
      '```',
    ].join('\n');
    expect(linkFileReferences(text, resolve)).toBe(text);
  });

  it('percent-encodes the URL so it cannot break the link', () => {
    expect(fileUrl('/work/pg/', 'docs/a (b).md')).toBe(
      'file:///work/pg/docs/a%20%28b%29.md',
    );
  });
});
