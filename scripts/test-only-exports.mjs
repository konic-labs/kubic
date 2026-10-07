// Symbol-level reachability: flags exports imported only by tests. The
// file-level gate (reachability.mjs) cannot see inside a live module; this
// check owns the inside: every export of the audited surface needs a
// non-test caller or an entry in UNWIRED_EXPORTS (dead-surface.mjs). Stale
// entries fail too — a symbol that gained a production caller or no longer
// exists must leave the list.
//
// Scope is the agent lane (lane/** plus prompts.ts and compaction.ts), not
// the whole repo. `*.test.ts` and `lane/test-harness.ts` (test support by
// design) are neither audited nor counted as callers. Matching is textual
// (word-boundary): comments and strings count as callers, so the check
// under-flags — it never invents a violation, it only misses exotic ones
// (dynamic access, re-export barrels that rename).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UNWIRED_EXPORTS } from './dead-surface.mjs';

const AUDIT_SCOPE = [
  'packages/worker/src/lane',
  'packages/worker/src/prompts.ts',
  'packages/worker/src/compaction.ts',
];

const EXCLUDED_FILES = ['test-harness.ts'];

function walk(dir, out = []) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

function scopeFiles(root) {
  const files = [];
  for (const entry of AUDIT_SCOPE) {
    const full = join(root, entry);
    if (statSync(full).isDirectory()) {
      files.push(...walk(full));
    } else {
      files.push(full);
    }
  }
  return files.filter(
    (file) =>
      !file.endsWith('.test.ts') &&
      !EXCLUDED_FILES.some((excluded) => file.endsWith(`/${excluded}`)),
  );
}

// `export function name`, `export const name`, `export class name`,
// `export interface name`, `export type name`, `export enum name`, and
// local `export { a, b as c }` (not `export ... from`, which names another
// module's symbols).
function exportedSymbols(source) {
  const names = new Set();
  const declaration =
    /^export\s+(?:async\s+function|function|const|let|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm;
  for (const match of source.matchAll(declaration)) names.add(match[1]);
  const list = /export\s*\{([^}]*)\}\s*(?:;|$)/gm;
  for (const match of source.matchAll(list)) {
    for (const part of match[1].split(',')) {
      const name = part
        .trim()
        .split(/\s+as\s+/)
        .pop()
        ?.trim();
      if (name !== undefined && name.length > 0) names.add(name);
    }
  }
  return [...names];
}

function listedKeys(unwired) {
  const keys = new Set();
  for (const [module, symbols] of Object.entries(unwired)) {
    for (const symbol of Object.keys(symbols)) keys.add(`${module}::${symbol}`);
  }
  return keys;
}

// Use inside the defining module (beyond its own export statement) counts
// as a production caller: the symbol is live on a reachable path even
// when no other module imports it (the session-lock primitives, used by
// this module's attach/fork paths, are the reason this exists). Comments
// and strings count — the check under-flags by design.
function hasInternalUse(source, symbol) {
  const occurrences = source.match(new RegExp(`\\b${symbol}\\b`, 'g')) ?? [];
  return occurrences.length >= 2;
}

export function checkTestOnlyExports({ root, unwired } = {}) {
  const repo = root ?? resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const rows = listedKeys(unwired ?? UNWIRED_EXPORTS);
  const audited = scopeFiles(repo);
  // A caller is any non-test module but the defining file itself:
  // intra-scope calls (lane calling lane) are production callers.
  const pool = walk(join(repo, 'packages'))
    .concat(walk(join(repo, 'apps')))
    .filter(
      (file) =>
        !file.endsWith('.test.ts') &&
        !EXCLUDED_FILES.some((excluded) => file.endsWith(`/${excluded}`)),
    );
  const callerSources = new Map(
    pool.map((file) => [file, readFileSync(file, 'utf8')]),
  );
  const unlisted = [];
  const stale = [];
  const seen = new Set();
  for (const file of audited) {
    const source = readFileSync(file, 'utf8');
    const rel = relative(repo, file);
    const callers = pool.filter((caller) => caller !== file);
    for (const symbol of exportedSymbols(source)) {
      const key = `${rel}::${symbol}`;
      const pattern = new RegExp(`\\b${symbol}\\b`);
      const called =
        hasInternalUse(source, symbol) ||
        callers.some((caller) => pattern.test(callerSources.get(caller) ?? ''));
      const listed = rows.has(key);
      if (!called && !listed) unlisted.push({ symbol, file: rel });
      // The symbol exists (it was just extracted from this file): an entry
      // for it is stale only when production code calls it now.
      if (called && listed) stale.push(key);
      seen.add(key);
    }
  }
  // An entry naming a symbol that no audited module exports (deleted, or
  // a module outside the scope) is stale.
  for (const key of rows) {
    if (!seen.has(key)) stale.push(key);
  }
  return { unlisted, stale };
}

// Main-module guard: import.meta.main is spelling-proof (symlinks,
// relative argv[1]) — the same guard reachability.mjs uses.
if (import.meta.main) {
  const { unlisted, stale } = checkTestOnlyExports();
  for (const { symbol, file } of unlisted) {
    console.log(
      `test-only export not listed in UNWIRED_EXPORTS: ${symbol} (${file})`,
    );
  }
  for (const key of stale) {
    console.log(`stale UNWIRED_EXPORTS entry (wired or deleted): ${key}`);
  }
  if (unlisted.length > 0 || stale.length > 0) process.exit(1);
  console.log('no test-only exports outside the list');
}
