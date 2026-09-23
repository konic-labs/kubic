// Link check for the docs/ scaffold (issue #61, EPIC G #60).
// Verifies every internal relative link in docs/**/*.md resolves.
// External URLs (http/https/mailto) and same-page anchors are skipped.
// Usage: node scripts/check-docs-links.mjs [--root <dir>]

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listInternalEdges } from './dep-lint.mjs';

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

// Docs neighbour lists cross-checked against dep-lint edges (issue #63
// review: neighbour drift must fail CI, not just dangling links).
//
// Semantics (deliberately one-sided so allowlists may stay broad):
// - "May import" must cover every real edge: an actual owner->target edge
//   missing from the owner's May-import list is drift (e.g. agents->exec
//   while the diagram says "core only").
// - "Imported by" must not fabricate: a claimed importer with no actual
//   edge to the page's package fails (e.g. trajectory imports nothing,
//   so any "Imported by trajectory" claim is fabricated).
// Only non-test sources count: test scaffolding (e.g. host prod-path
// tests driving apps/kubic) must not rewrite package neighbour docs.

const DOC_TO_PKG = {
  'core.md': 'core',
  'exec.md': 'exec',
  'worker.md': 'worker',
  'host.md': 'host',
  'agents-pkg.md': 'agents',
  'trajectory.md': 'trajectory',
  'eval.md': 'eval',
  'tui.md': 'tui',
  'extensions.md': 'extensions',
};

const LINK_FILE_TO_PKG = {
  'core.md': 'core',
  'exec.md': 'exec',
  'worker.md': 'worker',
  'host.md': 'host',
  'agents-pkg.md': 'agents',
  'agents.md': 'agents',
  'trajectory.md': 'trajectory',
  'eval.md': 'eval',
  'tui.md': 'tui',
  'extensions.md': 'extensions',
};

const KNOWN_PKGS = new Set([
  'core',
  'exec',
  'worker',
  'host',
  'agents',
  'trajectory',
  'eval',
  'tui',
  'extensions',
  'kubic',
]);

function neighbourSection(content) {
  const start = content.indexOf('## Dep-direction neighbours');
  if (start === -1) return '';
  const rest = content.slice(start);
  const fence = rest.indexOf('```');
  // Bullets live above the diagram fence; the fence itself names
  // packages (e.g. "core ──→ agents") and must not parse as claims.
  return fence === -1 ? rest : rest.slice(0, fence);
}

function bulletBlock(section, label) {
  const re = new RegExp(`-\\s*${label}:([\\s\\S]*?)(?=\\n- |\\n## |$)`);
  const m = section.match(re);
  return m ? m[1] : null;
}

// Package names mentioned positively in a neighbour bullet: @kubic/*
// refs, page links ([..](worker.md)), apps/kubic, and bare words.
// Exclusion clauses ("never …", "(no …)") are stripped first so
// "core only (no worker/host/…)" claims just {core}.
function mentionedPkgs(block, { bareWords = true } = {}) {
  if (block === null) return null;
  let text = block;
  const neverAt = text.search(/\bnever\b/i);
  if (neverAt !== -1) text = text.slice(0, neverAt);
  text = text.replace(/\(no [^)]*\)/gi, ' ');
  const found = new Set();
  for (const m of text.matchAll(/@kubic\/([a-z0-9-]+)/g)) {
    if (KNOWN_PKGS.has(m[1])) found.add(m[1]);
  }
  for (const m of text.matchAll(/\(([^()\s#]+\.md)(?:#[^()]*)?\)/g)) {
    const file = m[1].split('/').pop();
    if (LINK_FILE_TO_PKG[file]) found.add(LINK_FILE_TO_PKG[file]);
  }
  if (/apps\/kubic/.test(text)) found.add('kubic');
  // Bare words only for May-import allowlists ("core, exec, …"): in
  // Imported-by bullets they false-positive on prose ("wires host + tui").
  if (bareWords) {
    for (const m of text.matchAll(
      /\b(core|exec|worker|host|agents|trajectory|eval|tui|extensions)\b/g,
    )) {
      found.add(m[1]);
    }
  }
  return found;
}

export function checkDocsDeps(rootDir) {
  const mismatches = [];
  const prodEdges = listInternalEdges(rootDir).filter(
    (e) => !e.file.endsWith('.test.ts'),
  );
  const actualDeps = new Map(); // owner -> Set(target)
  for (const e of prodEdges) {
    if (!actualDeps.has(e.from)) actualDeps.set(e.from, new Set());
    actualDeps.get(e.from).add(e.to);
  }

  const docsDir = join(rootDir, 'docs', 'packages');
  let pages = [];
  try {
    pages = readdirSync(docsDir).filter((e) => DOC_TO_PKG[e]);
  } catch {
    return { edges: prodEdges.length, mismatches };
  }
  for (const page of pages) {
    const pkg = DOC_TO_PKG[page];
    const section = neighbourSection(readFileSync(join(docsDir, page), 'utf8'));
    if (!section) {
      mismatches.push(`${page}: missing Dep-direction neighbours section`);
      continue;
    }
    const mayImport = mentionedPkgs(bulletBlock(section, 'May import'));
    if (mayImport === null) {
      mismatches.push(`${page}: missing May-import bullet`);
    } else {
      for (const target of actualDeps.get(pkg) ?? []) {
        if (!KNOWN_PKGS.has(target)) continue;
        if (target === 'kubic') continue; // app root is never a doc neighbour
        if (!mayImport.has(target)) {
          mismatches.push(
            `${page}: May-import missing actual edge ${pkg} -> ${target}`,
          );
        }
      }
    }
    const importedBy = mentionedPkgs(bulletBlock(section, 'Imported by'), {
      bareWords: false,
    });
    if (importedBy !== null) {
      for (const importer of importedBy) {
        if (!KNOWN_PKGS.has(importer) || importer === pkg) continue;
        if (!(actualDeps.get(importer) ?? new Set()).has(pkg)) {
          mismatches.push(
            `${page}: claims Imported-by ${importer} but no ${importer} -> ${pkg} edge in tree`,
          );
        }
      }
    }
  }

  // README diagram: no line may label a package "core only" while the
  // tree shows it importing beyond core (the agents->exec drift).
  try {
    const readme = readFileSync(join(docsDir, 'README.md'), 'utf8');
    const fence = readme.match(/```text\n([\s\S]*?)```/);
    if (fence) {
      for (const line of fence[1].split('\n')) {
        if (!/core only/i.test(line)) continue;
        for (const [pkg, deps] of actualDeps) {
          if (pkg === 'kubic') continue;
          // README subjects use the @kubic/<pkg> form; bare substrings
          // false-positive (e.g. "host" in the tui line's "(never host/…)").
          if (!line.includes(`@kubic/${pkg}`)) continue;
          const beyondCore = [...deps].filter((d) => d !== 'core');
          if (beyondCore.length > 0) {
            mismatches.push(
              `README.md: diagram says "core only" for ${pkg} but tree has ${pkg} -> ${beyondCore.sort().join(', ')}`,
            );
          }
        }
      }
    }
  } catch {
    // No README diagram to check.
  }

  return { edges: prodEdges.length, mismatches };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = checkDocsLinks(root);
  if (result.broken.length > 0) {
    for (const bad of result.broken) console.error(`dangling link: ${bad}`);
    process.exit(1);
  }
  console.log(
    `docs links OK: ${result.files} files, ${result.links} internal links`,
  );
  const deps = checkDocsDeps(root);
  if (deps.mismatches.length > 0) {
    for (const m of deps.mismatches) console.error(`docs drift: ${m}`);
    process.exit(1);
  }
  console.log(`docs deps OK: ${deps.edges} internal edges cross-checked`);
}
