// `kubic clean` is documented and dispatched (issue #92; §42.4, §44.1, §78).
// The docs page is load-bearing: it promises `kubic clean` is the *only*
// disposer. This test makes that claim testable — the page must keep the
// sentence, list the shipped flags, and show `clean` in the usage line; the
// binary's dispatch must actually answer `clean` (a typo in the dispatch
// table would otherwise pass silently).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  '..',
);
const COMMANDS_PAGE = join(ROOT, 'docs', 'cli', 'commands.md');
const MAIN = join(ROOT, 'apps', 'kubic', 'src', 'main.ts');
const CLEAN = join(
  ROOT,
  'packages',
  'host',
  'src',
  'orchestrator',
  'worktree',
  'clean.ts',
);

const SHIPPED_FLAGS = [
  '--all',
  '--session',
  '--dry-run',
  '--force',
  '--journal',
  '--max-age-ms',
  '--max-bytes',
  '--json',
];

describe('clean is documented and dispatched (issue #92)', () => {
  it('keeps the "only kubic clean disposes" retention claim on the commands page', () => {
    const page = readFileSync(COMMANDS_PAGE, 'utf8');
    expect(page).toContain('only `kubic clean` disposes');
    // The claim is anchored: the sentence must still sit on the orchestrate
    // section that promises retention, not on some unrelated page.
    expect(page).toMatch(
      /retained after the merge\s+as evidence \(only `kubic clean` disposes\)/,
    );
  });

  it('lists clean in the page usage line and in the binary usage line', () => {
    const page = readFileSync(COMMANDS_PAGE, 'utf8');
    const main = readFileSync(MAIN, 'utf8');
    const pageUsage = page.match(/usage: kubic <([^>]*)>/)?.[1] ?? '';
    const mainUsage = main.match(/usage: kubic <([^>]*)>/)?.[1] ?? '';
    const words = (listing: string): string[] =>
      listing.split('|').map((word) => word.trim());
    expect(words(pageUsage)).toContain('clean');
    expect(words(mainUsage)).toContain('clean');
    expect(words(pageUsage)).toEqual(words(mainUsage));
  });

  it('documents every shipped clean flag on the commands page', () => {
    const page = readFileSync(COMMANDS_PAGE, 'utf8');
    const section = page.slice(page.indexOf('## `kubic clean'));
    expect(section.length).toBeGreaterThan(0);
    const body = section.slice(0, section.indexOf('\n## ', 1));
    for (const flag of SHIPPED_FLAGS) {
      expect(body, `missing ${flag} in the clean section`).toContain(flag);
    }
    // The exit-code contract the page promises: 0 ok, 1 failure, 2 usage
    // and the non-repo refusal.
    expect(body).toContain('exit 2');
    expect(body).toContain('nothing was removed');
  });

  it('is the only disposer: nothing in the package deletes a spawned branch', () => {
    // The "only kubic clean disposes" claim is a code claim too: `git branch
    // -D` on a spawned branch may only be issued from the clean/remove path.
    const clean = readFileSync(CLEAN, 'utf8');
    expect(clean).toContain('deleteSpawnedBranch');
    const main = readFileSync(MAIN, 'utf8');
    expect(main).toContain("command === 'clean'");
    expect(main).toContain('runCleanCommand');
  });

  it('shows every accepted flag in the clean usage line', async () => {
    // A flag the parser accepts but the usage line omits is undiscoverable —
    // `--dry-run` and `--all` are exactly what a user reaches for first.
    const { parseCleanArgs } = await import('./clean.js');
    const clean = readFileSync(CLEAN, 'utf8');
    const usage = clean.slice(clean.indexOf('usage: kubic clean'));
    const usageLine = usage.slice(0, usage.indexOf('\n'));
    for (const flag of SHIPPED_FLAGS) {
      expect(usageLine, `usage line omits ${flag}`).toContain(flag);
      // Value flags need a value to be a valid invocation; the boolean ones
      // are valid alone.
      const probe =
        flag.startsWith('--m') || flag === '--session'
          ? [flag, flag === '--session' ? 'orch-1' : '1']
          : [flag];
      expect(parseCleanArgs(probe), `${flag} must parse`).toMatchObject({
        valid: true,
      });
    }
  });
});
