// The #106 docs are load-bearing (issue #106; §45.2, §49.1, §50, §44.1).
//
// `docs/cli/commands.md` and `docs/architecture/orchestrator.md` both stated
// the pre-#106 truth: conflicts stop the queue, parallel counts are not
// surfaced, retained worktrees report nothing. After #106 that text is false,
// so the replacement claims are pinned here — the way clean-docs.test.ts pins
// the `kubic clean` claim and orchestrator-docs-honesty.test.ts pins the
// claims that had to disappear. Two rules from those precedents:
//   - match on NORMALIZED whitespace (a claim split across a line break is
//     still the claim — raw matching would let it through), and
//   - assert the file list is non-empty, so an absence scan cannot pass
//     vacuously the way an earlier path bug let it.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// packages/host/src/ → the repo root is three levels up. Pinned by the
// non-empty file-list assertion below: a wrong depth would otherwise make
// every absence scan pass vacuously (the precedent that assertion exists for).
const ROOT = join(import.meta.dirname, '..', '..', '..');
const COMMANDS_PAGE = join(ROOT, 'docs', 'cli', 'commands.md');
const ARCHITECTURE_PAGE = join(ROOT, 'docs', 'architecture', 'orchestrator.md');
const LEDGER = join(ROOT, 'docs', 'dead-surface.md');

function prose(page: string): string {
  return page
    .split('\n')
    .map((line) => line.replace(/^\s*>\s?/, ''))
    .join(' ')
    .replace(/\s+/g, ' ');
}

function section(page: string, heading: string): string {
  const start = page.indexOf(heading);
  expect(start, `missing section ${heading}`).toBeGreaterThan(-1);
  const rest = page.slice(start);
  const end = rest.indexOf('\n## ', 1);
  return end === -1 ? rest : rest.slice(0, end);
}

/** Every tracked markdown file — `git ls-files`, never a directory walk. */
function trackedDocs(): string[] {
  const out = execFileSync('git', ['ls-files', 'docs', 'README.md', '*.md'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.endsWith('.md'));
}

describe('#106 docs describe what ships (issue #106)', () => {
  it('the orchestrate section documents the new output rows', () => {
    const body = prose(
      section(readFileSync(COMMANDS_PAGE, 'utf8'), '## `kubic orchestrate'),
    );
    // The three surfaces this issue wired, each named where an operator looks.
    expect(body).toMatch(/parallel: running/);
    expect(body).toMatch(/queued/);
    expect(body).toMatch(/maxConcurrency|cap \d|\bcap\b/);
    expect(body).toMatch(/tree:/);
    expect(body).toMatch(/retained: /);
    expect(body).toMatch(/clean=unknown/);
    expect(body).toMatch(/revolver|resolver/i);
    // The claims that are now false must be gone from this section.
    expect(body).not.toMatch(/counts are not surfaced/i);
    expect(body).not.toMatch(/surfaces none of it/i);
    expect(body).not.toMatch(
      /never reporting whether a retained worktree is dirty/i,
    );
  });

  it('the architecture page states the shipped conflict/parallel/retain model', () => {
    const page = readFileSync(ARCHITECTURE_PAGE, 'utf8');
    const body = prose(page);
    // A genuine conflict is delegated to a spawned resolver, never resolved
    // by the manager — and only a successful re-merge settles the candidate.
    expect(body).toMatch(
      /spawns? a resolver|resolver (subagent|child|process)/i,
    );
    expect(body).toMatch(
      /never resolv(e|es) (a|the) conflict itself|manager never resolves/i,
    );
    // The admission counts reach the operator now.
    expect(body).toMatch(/running.*queued.*cap|running\/queued/i);
    // A retained worktree reports whether it is dirty.
    expect(body).toMatch(/retained worktree.{0,80}(dirty|clean)/i);
    // The page may no longer call these unreachable, and may not name #106 as
    // future work.
    expect(body).not.toMatch(/are implemented and unreachable/i);
    expect(body).not.toMatch(/#106.{0,40}(future|remains?|is issue)/i);
  });

  it('no tracked doc still claims the #106 gaps', () => {
    const docs = trackedDocs();
    // Guard against a vacuous scan (the precedent: a path bug once read an
    // empty list and passed while every claim it hunts was present).
    expect(docs.length).toBeGreaterThan(20);
    expect(docs).toContain('docs/cli/commands.md');
    expect(docs).toContain('docs/architecture/orchestrator.md');
    const patterns: RegExp[] = [
      /parallel counts are not surfaced/i,
      /conflicts stop the queue and parallel counts/i,
    ];
    const offenders: string[] = [];
    for (const file of docs) {
      const text = prose(readFileSync(join(ROOT, file), 'utf8'));
      for (const pattern of patterns) {
        if (pattern.test(text)) offenders.push(`${file}: ${pattern.source}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every ledger row #106 owned is gone', () => {
    const ledger = readFileSync(LEDGER, 'utf8');
    // Rows are `<loc> | <path> | <owner> | <disposition>`; the ledger's
    // NARRATIVE legitimately names the files an issue wired (that is how the
    // dispositions are recorded as executed), so the pin is on the ROWS —
    // a row that stayed behind would also fail the reachability gate.
    const rows = new Map<string, string>();
    for (const line of ledger.split('\n')) {
      const cells = line
        .trim()
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map((cell) => cell.trim());
      if (cells.length < 4) continue;
      const path = cells[1].replace(/^`|`$/g, '');
      if (!path.startsWith('packages/')) continue;
      rows.set(path, cells.slice(2).join(' | '));
    }
    expect(rows.size).toBeGreaterThan(20);
    for (const path of [
      'packages/host/src/orchestrator/merge/conflicts.ts',
      'packages/host/src/orchestrator/parallel/visibility.ts',
      'packages/host/src/orchestrator/worktree/status.ts',
    ]) {
      expect(rows.has(path), `${path} must not keep a ledger row`).toBe(false);
    }
    // The sibling rows this issue does NOT own stay put — a sweep that took
    // them out would silently re-open a sibling issue. Only the modules that
    // are STILL dead may carry a row: `merge/telemetry.ts` is #98's and still
    // unreachable. The approvals rows that were here when this pin was
    // written are gone because #105 landed and wired them (the sibling did
    // its job) — so a row for any of those now fails the reachability gate
    // itself, which is the stronger pin. Asserted by measurement below rather
    // than by text: `approvals/request.ts` must NOT have a row (reachable),
    // `merge/telemetry.ts` must (still dead).
    expect(
      rows.has('packages/host/src/orchestrator/approvals/request.ts'),
    ).toBe(false);
    expect(rows.has('packages/host/src/orchestrator/merge/telemetry.ts')).toBe(
      true,
    );
    // The execution is recorded, not just performed.
    expect(prose(ledger)).toMatch(/#106 executed/);
  });
});
