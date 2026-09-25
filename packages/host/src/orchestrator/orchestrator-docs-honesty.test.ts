// Honest-claims pin for the orchestrator docs (review findings F1/F2 on #95).
//
// The re-scope existed to remove doc claims the binary contradicts. Two
// survived it and were found by an independent review:
//   F1 — "the orchestrator never stages or commits": it runs `git add -A` and
//        `git commit` per worker in apps/kubic/src/orchestrate-run.ts.
//   F2 — "the admission cap starts to matter as soon as `--agents` exceeds it":
//        the loop is sequential and never approaches the cap.
// Rewording alone rots, so each claim is pinned absent across every TRACKED
// doc, and the two behavioural facts the docs now assert are pinned by tests in
// orchestrate-cli.test.ts.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = join(import.meta.dirname, '..', '..', '..', '..');

/** Every tracked markdown file — `git ls-files`, never a directory walk:
 *  docs/design/ is gitignored and legitimately describes design intent. */
function trackedDocs(): string[] {
  const out = execFileSync('git', ['ls-files', 'docs', 'README.md', '*.md'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.endsWith('.md'));
}

/**
 * Prose wraps, claims do not. Every pattern below is matched against text with
 * runs of whitespace collapsed, because a claim split across two lines
 * ("starts to\nmatter as soon as") is still the claim — matching raw text would
 * let it through and the test would pass vacuously.
 */
function prose(file: string): string {
  return readFileSync(join(repoRoot, file), 'utf8').replace(/\s+/g, ' ');
}

function scan(patterns: RegExp[]): string[] {
  const offenders: string[] = [];
  for (const file of trackedDocs()) {
    const text = prose(file);
    for (const pattern of patterns) {
      if (pattern.test(text)) offenders.push(`${file}: ${pattern.source}`);
    }
  }
  return offenders;
}

describe('orchestrator docs do not claim what the code does not do (#95 review)', () => {
  it('no tracked doc says the orchestrator never stages or commits', () => {
    expect(
      scan([
        /never stages or commits/i,
        /orchestrator never commits/i,
        /CLI never stages or commits/i,
        /sole committer on its own branch/i,
      ]),
    ).toEqual([]);
  });

  it('no tracked doc claims the admission cap gates a run', () => {
    expect(
      scan([
        /starts to matter as soon as/i,
        /makes the queue and its limits observable/i,
        /cap (?:is|as) what (?:bounds|gates) (?:a|the) run/i,
      ]),
    ).toEqual([]);
  });

  it('the docs state the real authorship rule', () => {
    // The replacement claim, so the removal above cannot be satisfied by
    // simply deleting the sentence: the truth must be present somewhere.
    const orchestratorDoc = prose('docs/architecture/orchestrator.md');
    expect(orchestratorDoc).toMatch(/stages whatever it left/i);
    expect(orchestratorDoc).toMatch(/kubic-worker/);
    expect(orchestratorDoc).toMatch(
      /worker child is `kubic run`, which does not run `git commit`/i,
    );
  });

  it('the docs state the real concurrency rule', () => {
    const commandsDoc = prose('docs/cli/commands.md');
    expect(commandsDoc).toMatch(/bounds a run today/);
    expect(commandsDoc).toMatch(/strictly sequential/);
  });

  it('the absence scan is not vacuous: it sees the tracked docs at all', () => {
    // A path bug once made this suite read an empty file list and pass while
    // every claim it hunts was present. Pin the substrate, not just the result.
    const docs = trackedDocs();
    expect(docs.length).toBeGreaterThan(20);
    expect(docs).toContain('docs/architecture/orchestrator.md');
    expect(docs).toContain('docs/cli/commands.md');
    expect(docs).toContain('README.md');
  });
});
