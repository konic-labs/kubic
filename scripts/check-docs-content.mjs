// Content checks for the docs, beside the link check: every table row
// belongs to a table and no cell runs over 300 characters (GitHub renders a
// long cell as a wall of text, and a row cut off from its table as raw
// pipes); every image has alt text and a file behind it, and a local SVG is
// shown only from a <picture>'s <source>, beside a PNG in its <img> (GitHub's
// mobile apps show the <img> and no SVG); and every file in docs/assets is
// used, within the size budget, and an SVG with nothing active or outside
// inside it.
// Usage: node scripts/check-docs-content.mjs [--root <dir>]

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readerFiles } from './check-docs-links.mjs';

export const CELL_LIMIT = 300;
export const ASSET_BUDGET_BYTES = 300 * 1024;

// A table row's cells, split on pipes outside code spans and escapes.
function cells(line) {
  const out = [];
  let cur = '';
  let code = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '`') code = !code;
    if (ch === '|' && !code && line[i - 1] !== '\\') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.slice(1, -1).map((cell) => cell.trim());
}

const DELIMITER = /^\s*\|?\s*:?-{3,}/;

// Table problems on one page: a row with no header and delimiter above it,
// a line of prose inside a table, and a cell over the limit.
export function tableProblems(markdown) {
  const problems = [];
  const lines = markdown.split('\n');
  let fenced = false;
  let table = false;
  lines.forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      table = false;
      return;
    }
    if (fenced) return;
    if (!/^\s*\|/.test(line)) {
      if (table && line.trim() !== '') {
        problems.push(`line ${i + 1}: prose inside a table`);
      }
      table = false;
      return;
    }
    if (!table) {
      if (DELIMITER.test(lines[i + 1] ?? '')) table = true;
      else problems.push(`line ${i + 1}: a table row outside a table`);
    }
    for (const cell of cells(line)) {
      if (cell.length > CELL_LIMIT) {
        problems.push(
          `line ${i + 1}: a ${cell.length}-character table cell (at most ${CELL_LIMIT}: move the detail into a section)`,
        );
      }
    }
  });
  return problems;
}

// The images a page shows: Markdown images and HTML <img>/<source>, with
// their targets, their kind and whether alt text is present (an empty alt is
// a decorative image, which is fine; a missing one is not).
export function pageImages(markdown) {
  const images = [];
  let fenced = false;
  for (const line of markdown.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    for (const m of line.matchAll(/!\[([^\]]*)\]\(([^)\s]+)/g)) {
      images.push({ src: m[2], alt: m[1].trim() !== '', kind: 'markdown' });
    }
    for (const m of line.matchAll(/<img\b[^>]*>/g)) {
      const src = /\ssrc="([^"]+)"/.exec(m[0]);
      if (src) {
        images.push({ src: src[1], alt: /\salt="/.test(m[0]), kind: 'img' });
      }
    }
    for (const m of line.matchAll(/<source\b[^>]*\ssrcset="([^"]+)"/g)) {
      images.push({ src: m[1], alt: true, kind: 'source' });
    }
  }
  return images;
}

function isExternal(target) {
  return /^(https?:|data:)/.test(target);
}

function filesUnder(dir) {
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? filesUnder(full) : [full];
  });
}

// What an SVG must not carry: scripts, and anything it would fetch.
export function svgProblems(svg) {
  const problems = [];
  if (/<script\b/i.test(svg)) problems.push('a script');
  if (/<[^>]*\son[a-z]+\s*=/i.test(svg)) problems.push('an event handler');
  if (/(?:href|src)\s*=\s*"(?:https?:|\/\/)/i.test(svg)) {
    problems.push('an outside reference');
  }
  if (/@import|url\(\s*['"]?(?:https?:|\/\/)/i.test(svg)) {
    problems.push('an outside stylesheet or font');
  }
  return problems;
}

export function checkDocsContent(root) {
  const problems = [];
  const used = new Set();
  for (const file of readerFiles(root)) {
    const markdown = readFileSync(file, 'utf8');
    const name = relative(root, file);
    for (const problem of tableProblems(markdown)) {
      problems.push(`${name}: ${problem}`);
    }
    for (const image of pageImages(markdown)) {
      if (!image.alt) problems.push(`${name}: ${image.src} has no alt text`);
      if (isExternal(image.src)) continue;
      if (image.kind !== 'source' && /\.svg$/i.test(image.src.split('#')[0])) {
        problems.push(
          `${name}: ${image.src} is shown as an SVG, which GitHub's mobile apps do not draw: show a PNG in the <img> and the SVG in a <picture>'s <source>`,
        );
      }
      const target = resolve(dirname(file), image.src.split('#')[0]);
      used.add(target);
      try {
        statSync(target);
      } catch {
        problems.push(`${name}: ${image.src} does not exist`);
      }
    }
  }
  for (const asset of filesUnder(join(root, 'docs', 'assets'))) {
    const name = relative(root, asset);
    const size = statSync(asset).size;
    if (size > ASSET_BUDGET_BYTES) {
      problems.push(
        `${name}: ${size} bytes, over the ${ASSET_BUDGET_BYTES}-byte budget`,
      );
    }
    if (!used.has(asset)) problems.push(`${name}: no page shows it`);
    if (asset.endsWith('.svg')) {
      for (const problem of svgProblems(readFileSync(asset, 'utf8'))) {
        problems.push(`${name}: carries ${problem}`);
      }
    }
  }
  return problems;
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootFlag = process.argv.indexOf('--root');
const root =
  rootFlag === -1 ? join(scriptDir, '..') : resolve(process.argv[rootFlag + 1]);

if (import.meta.main) {
  const problems = checkDocsContent(root);
  if (problems.length > 0) {
    for (const problem of problems) console.error(`docs: ${problem}`);
    process.exit(1);
  }
  console.log('docs content OK: tables, images and assets');
}
