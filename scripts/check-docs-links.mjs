// Link check for the docs: every relative link in docs/**/*.md, the root
// markdown files and the package markdown resolves to a file, and every
// anchor, on the same page or another, names a heading there (by GitHub's
// slug) or an explicit `<a id>`. External URLs (http/https/mailto) are not
// fetched.
// Usage: node scripts/check-docs-links.mjs [--root <dir>]

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const LINK_RE = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

// The private development notes are local files, not part of the docs.
const LOCAL_FILES = new Set(['AGENTS.md', 'CLAUDE.md', 'CLAUDE.local.md']);

function mdFiles(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e === 'node_modules' || e === 'dist') continue;
    const full = join(dir, e);
    if (statSync(full).isDirectory()) mdFiles(full, out);
    else if (e.endsWith('.md')) out.push(full);
  }
  return out;
}

// The markdown files a reader reaches: docs/, the root files and each
// package's and app's own pages.
export function readerFiles(root) {
  const files = mdFiles(join(root, 'docs'));
  for (const e of readdirSync(root)) {
    if (e.endsWith('.md') && !LOCAL_FILES.has(e)) files.push(join(root, e));
  }
  for (const top of ['packages', 'apps']) {
    let names = [];
    try {
      names = readdirSync(join(root, top));
    } catch {
      continue;
    }
    for (const name of names) {
      const dir = join(root, top, name);
      if (!statSync(dir).isDirectory()) continue;
      for (const e of readdirSync(dir)) {
        if (e.endsWith('.md')) files.push(join(dir, e));
      }
    }
  }
  return files;
}

function isExternal(target) {
  return /^(https?:|mailto:)/.test(target);
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

// The anchors a page offers: GitHub's heading slugs (lower case,
// punctuation dropped, spaces to hyphens, a repeat suffixed -1, -2, …) and
// any explicit `<a id>` / `<a name>`. Headings inside fenced code are not
// headings.
export function pageAnchors(markdown) {
  const anchors = new Set();
  const seen = new Map();
  let fenced = false;
  for (const line of markdown.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const heading = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      const base = heading[1]
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s_-]/gu, '')
        .replace(/\s/g, '-');
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      anchors.add(n === 0 ? base : `${base}-${n}`);
    }
    for (const id of line.matchAll(/<a\s+(?:id|name)="([^"]+)"/g)) {
      anchors.add(id[1]);
    }
  }
  return anchors;
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

// The file a link names: the path itself, the path with `.md`, a folder's
// README, or the folder (GitHub shows its listing).
function targetFile(file, bare) {
  const abs = resolve(dirname(file), bare);
  if (isFile(abs)) return abs;
  if (isFile(`${abs}.md`)) return `${abs}.md`;
  if (isFile(join(abs, 'README.md'))) return join(abs, 'README.md');
  if (isDirectory(abs)) return abs;
  return undefined;
}

// Returns a "file: target" description when broken, null when it resolves.
function brokenLink(file, target, anchorsOf) {
  const at = target.indexOf('#');
  const bare = at === -1 ? target : target.slice(0, at);
  const anchor = at === -1 ? '' : target.slice(at + 1);
  const page = bare === '' ? file : targetFile(file, bare);
  if (page === undefined) return `${file}: ${target}`;
  if (anchor === '' || !page.endsWith('.md')) return null;
  if (anchorsOf(page).has(decodeURIComponent(anchor))) return null;
  return `${file}: ${target} (no such heading)`;
}

export function checkDocsLinks(root) {
  const files = readerFiles(root);
  const cache = new Map();
  const anchorsOf = (page) => {
    if (!cache.has(page))
      cache.set(page, pageAnchors(readFileSync(page, 'utf8')));
    return cache.get(page);
  };
  const broken = [];
  let links = 0;
  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    for (const match of content.matchAll(LINK_RE)) {
      const target = match[1];
      if (isExternal(target)) continue;
      links += 1;
      const bad = brokenLink(file, target, anchorsOf);
      if (bad) broken.push(bad);
    }
  }
  return { files: files.length, links, broken };
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootFlag = process.argv.indexOf('--root');
const root =
  rootFlag === -1 ? join(scriptDir, '..') : resolve(process.argv[rootFlag + 1]);

if (import.meta.main) {
  const result = checkDocsLinks(root);
  if (result.broken.length > 0) {
    for (const bad of result.broken) console.error(`dangling link: ${bad}`);
    process.exit(1);
  }
  console.log(
    `docs links OK: ${result.files} files, ${result.links} internal links`,
  );
}
