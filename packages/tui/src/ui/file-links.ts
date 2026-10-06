// File references as links (EPIC N, issue #458; docs/ui 01-I).
//
// `src/cart.js:10` and `src/cart.js` in an answer — in prose or in inline
// code — become markdown links to `file://<abs>` when the path is a file in
// the project, so Pi's markdown renders them as OSC 8 hyperlinks the
// terminal can open. Fenced code, existing links and URLs are left alone,
// and only real project files are linked (a word that merely looks like a
// path stays text). The caller applies this only where the terminal
// supports hyperlinks: Pi's fallback prints the URL beside the text.

// A relative path with an extension, an optional `:line[:col]`, optionally
// wrapped in one pair of backticks. Not preceded by a word, path or URL
// character, not followed by one.
const REFERENCE =
  /(?<![\w/:.@~-])(`?)((?:\.\/)?(?:[\w@.+-]+\/)*[\w@+-][\w@.+-]*\.[A-Za-z0-9]{1,10})((?::\d+){0,2})\1(?![\w/])/gu;

const FENCE = /^\s*(```|~~~)/u;

function linkLine(
  line: string,
  resolve: (path: string) => string | undefined,
): string {
  // Existing links `[text](url)` are copied through untouched.
  const parts = line.split(/(\[[^\]]*\]\([^)]*\))/u);
  return parts
    .map((part, index) => {
      if (index % 2 === 1) return part;
      return part.replace(REFERENCE, (match, _tick, path: string) => {
        const url = resolve(path);
        return url === undefined ? match : `[${match}](${url})`;
      });
    })
    .join('');
}

export function linkFileReferences(
  markdown: string,
  resolve: (path: string) => string | undefined,
): string {
  let inFence = false;
  return markdown
    .split('\n')
    .map((line) => {
      if (FENCE.test(line)) {
        inFence = !inFence;
        return line;
      }
      return inFence ? line : linkLine(line, resolve);
    })
    .join('\n');
}

/** `file://` URL of `relative` under `root` (POSIX paths, percent-encoded). */
export function fileUrl(root: string, relative: string): string {
  const clean = relative.replace(/^\.\//u, '');
  const base = root.endsWith('/') ? root.slice(0, -1) : root;
  // Parentheses would end the markdown link early: escape them too.
  return `file://${encodeURI(`${base}/${clean}`).replaceAll('(', '%28').replaceAll(')', '%29')}`;
}
