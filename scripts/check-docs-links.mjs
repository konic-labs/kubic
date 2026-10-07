// Link check for the docs/ scaffold.
// Verifies every internal relative link in docs/**/*.md resolves.
// External URLs (http/https/mailto) and same-page anchors are skipped.
// Usage: node scripts/check-docs-links.mjs [--root <dir>]

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const LINK_RE = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

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

function isExternal(target) {
  return /^(https?:|mailto:|#)/.test(target);
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

// Returns a "file: target" description when broken, null when it resolves.
function brokenLink(file, target) {
  const bare = target.split('#')[0];
  if (bare === '') return null; // same-page anchor
  const abs = resolve(dirname(file), bare);
  if (isFile(abs)) return null;
  if (isFile(`${abs}.md`)) return null;
  if (isFile(join(abs, 'README.md'))) return null;
  return `${file}: ${target}`;
}

export function checkDocsLinks(root) {
  const files = mdFiles(join(root, 'docs'));
  const broken = [];
  let links = 0;
  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    for (const match of content.matchAll(LINK_RE)) {
      const target = match[1];
      if (isExternal(target)) continue;
      links += 1;
      const bad = brokenLink(file, target);
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
