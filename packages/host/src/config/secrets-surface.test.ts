// Every export of secrets.ts has a runtime caller or a dead-surface row
// (issue #359). The reachability gate is file-level — secrets.ts is
// reachable through parseSecretRef — so this pins the export level: an
// export is LIVE when a non-test source outside secrets.ts names it, or when
// a live export of secrets.ts names it (fixpoint). Every other export must
// own a row in docs/dead-surface.md's "Unwired exports" table, and no row
// may name a live export (a disposition executed must leave the table).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
);
const SECRETS = join(ROOT, 'packages', 'host', 'src', 'config', 'secrets.ts');
const DEAD_SURFACE = join(ROOT, 'docs', 'dead-surface.md');

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) out.push(path);
  }
  return out;
}

function mentions(text: string, name: string): boolean {
  return new RegExp(`\\b${name}\\b`).test(text);
}

// Code only: comments and quoted strings name things without calling them.
function codeOf(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''");
}

// Source-text scans skip under Stryker (instrumented sources).
const scan = process.env.STRYKER_MUTATOR_WORKER === undefined ? it : it.skip;

describe('secrets.ts export surface (issue #359)', () => {
  scan('every export has a non-test caller or a dead-surface row', () => {
    const text = readFileSync(SECRETS, 'utf8');
    const chunks = new Map<string, string>();
    const pattern =
      /^export (?:async )?(?:const|function|class|interface|type) (\w+)/gm;
    const starts = [...text.matchAll(pattern)];
    expect(starts.length).toBeGreaterThan(10);
    starts.forEach((match, index) => {
      const end = starts[index + 1]?.index ?? text.length;
      chunks.set(match[1] as string, codeOf(text.slice(match.index, end)));
    });
    const outside = [
      ...sources(join(ROOT, 'packages')),
      ...sources(join(ROOT, 'apps')),
    ]
      .filter((path) => path !== SECRETS)
      .map((path) => codeOf(readFileSync(path, 'utf8')))
      .join('\n');
    const live = new Set(
      [...chunks.keys()].filter((name) => mentions(outside, name)),
    );
    for (let grew = true; grew; ) {
      grew = false;
      for (const name of chunks.keys()) {
        if (live.has(name)) continue;
        const usedByLive = [...live].some((user) => {
          const body = (chunks.get(user) ?? '').replace(/^[^\n]*\n/, '');
          return mentions(body, name);
        });
        if (usedByLive) {
          live.add(name);
          grew = true;
        }
      }
    }
    const dead = [...chunks.keys()].filter((name) => !live.has(name)).sort();
    const doc = readFileSync(DEAD_SURFACE, 'utf8');
    const table = doc.slice(
      doc.indexOf('## Unwired exports of reachable modules'),
    );
    const rows = [
      ...table.matchAll(
        /^\| `(\w+)` \| `packages\/host\/src\/config\/secrets\.ts` \|/gm,
      ),
    ]
      .map((match) => match[1] as string)
      .sort();
    // The live path this issue wired is live...
    for (const name of [
      'parseSecretRef',
      'resolveSecretRef',
      'redactSecretValues',
      'createModelKeyResolver',
    ]) {
      expect(live.has(name), name).toBe(true);
    }
    // ...and the ledger names exactly the rest.
    expect(rows).toEqual(dead);
  });
});
