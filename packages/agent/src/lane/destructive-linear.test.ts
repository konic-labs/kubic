// The destructive matcher runs synchronously before EVERY bash call, so a
// model-generated command must never be able to stall it. Its git/dd/find/
// chmod shapes are not one gapped regex each (`\bgit\b[^|;&]*\spush\b…`),
// which backtracks polynomially: `git push ` repeated 2000 times took 13 s,
// `git checkout ` 19 s and `git restore --staged ` 50 s. They are a
// leftmost-first walk per command segment — linear — and the differential
// sweep below pins that exactly the same commands are recognised.
import { describe, expect, it } from 'vitest';
import { defaultIsDestructive } from './interceptors/index.js';

const LINEAR_BOUND_MS = 500;

function timed(command: string): { destructive: boolean; ms: number } {
  const started = performance.now();
  const destructive = defaultIsDestructive(command, '/work');
  return { destructive, ms: performance.now() - started };
}

describe('defaultIsDestructive stays linear on repeated verbs', () => {
  it.each([
    'git ',
    'git --namespace ',
    'git push ',
    'git reset ',
    'git commit ',
    'git checkout ',
    'git restore --staged ',
    'git restore ',
    'git clean ',
    'dd ',
    'find ',
    'chmod ',
    'chown ',
  ])('%s repeated 5000 times classifies in well under a second', (unit) => {
    const { ms } = timed(`${unit.repeat(5000)}x`);
    expect(ms).toBeLessThan(LINEAR_BOUND_MS);
  });

  it('a separator-heavy command stays linear too', () => {
    for (const unit of [';', 'git ;', 'git push;', '&& ', '| git ']) {
      const { ms } = timed(unit.repeat(20_000));
      expect(ms, unit).toBeLessThan(LINEAR_BOUND_MS);
    }
  });

  it('a long chain still reaches its tail: the verdicts are unchanged', () => {
    const many = 5000;
    expect(timed(`${'git push '.repeat(many)}x`).destructive).toBe(false);
    expect(timed(`${'git push '.repeat(many)}--force`).destructive).toBe(true);
    expect(timed(`${'git push '.repeat(many)}origin +main`).destructive).toBe(
      true,
    );
    expect(timed(`${'git reset '.repeat(many)}--hard`).destructive).toBe(true);
    expect(timed(`${'git checkout '.repeat(many)}-f`).destructive).toBe(true);
    expect(timed(`${'git checkout '.repeat(many)}x`).destructive).toBe(false);
    // A staged-only restore is not destructive; one unstaged restore is.
    expect(timed(`${'git restore --staged '.repeat(many)}x`).destructive).toBe(
      false,
    );
    expect(
      timed(`${'git restore --staged '.repeat(many)}git restore x`).destructive,
    ).toBe(true);
    expect(timed(`${'git clean '.repeat(many)}-fd`).destructive).toBe(true);
    expect(timed(`${'dd '.repeat(many)}of=/dev/sda`).destructive).toBe(true);
    expect(timed(`${'find '.repeat(many)}. -delete`).destructive).toBe(true);
    expect(timed(`${'chmod '.repeat(many)}-R 777`).destructive).toBe(true);
  });
});

// The matcher's shapes as one gapped regex each. A gap stops at `|`, `;`, `&`
// and a line break, and the whitespace that opens a step is `[^\S\n\r]`, so
// no step reaches past the end of its line either. Exponential/polynomial
// only on long repeats, so a seeded sweep of short commands is cheap and pins
// that the segment walk recognises EXACTLY what they do — the `+\S` that may
// eat a separator, the `(\s|$)` end anchors and the negative lookahead of
// `git restore` included. No `rm` in the vocabulary: that half of the matcher
// is tested on its own.
const ORIGINAL_PATTERNS = [
  /\bmkfs\b/i,
  /\bdd\b[^|;&\n\r]*\bof=[^\S\n\r]*\/dev\//i,
  /\bshred\b/i,
  /\bgit[^\S\n\r]+clean[^\S\n\r]+[^|;&\n\r]*-[a-zA-Z]*f/i,
  /\b(chmod|chown)\b[^|;&\n\r]*[^\S\n\r]-[a-zA-Z]*R/i,
  /:\(\)\s*\{\s*:\|:&\s*\}\s*;/,
  /\bgit\b[^|;&\n\r]*[^\S\n\r]push\b[^|;&\n\r]*[^\S\n\r](--force(-with-lease|-if-includes)?\b|-[a-zA-Z]*f[a-zA-Z]*\b|\+\S)/i,
  /\bfind\b[^|;&\n\r]*[^\S\n\r]-delete\b/i,
  /\bgit\b[^|;&\n\r]*[^\S\n\r]reset\b[^|;&\n\r]*[^\S\n\r]--hard\b/i,
  /\bgit\b[^|;&\n\r]*[^\S\n\r]commit\b[^|;&\n\r]*[^\S\n\r]--amend\b/i,
  /\bgit\b[^|;&\n\r]*[^\S\n\r]checkout\b[^|;&\n\r]*[^\S\n\r](--(\s|$)|\.(\s|$)|-f\b|--force\b)/i,
  /\bgit\b[^|;&\n\r]*[^\S\n\r]restore\b(?![^|;&\n\r]*[^\S\n\r](--staged|-S)\b)/i,
  /\bgit\b[^|;&\n\r]*[^\S\n\r]restore\b[^|;&\n\r]*[^\S\n\r](--worktree|-W)\b/i,
];

describe('defaultIsDestructive recognises exactly what it did', () => {
  const words = [
    'git',
    'GIT',
    'push',
    'Push',
    'reset',
    'commit',
    '--amend',
    'checkout',
    'restore',
    'clean',
    '--force',
    '--force-with-lease',
    '--force-if-includes',
    '--forceful',
    '-f',
    '-uf',
    '-fu',
    '-u',
    '+main',
    '+',
    '--hard',
    '--soft',
    '--staged',
    '-S',
    '-s',
    '-W',
    '--worktree',
    '.',
    '--',
    'dd',
    'of=/dev/sda',
    'of=/tmp/x',
    'find',
    '-delete',
    'chmod',
    'chown',
    '-R',
    '-r',
    '-x',
    'x',
    'origin',
    'mkfs',
    'shred',
    ':(){',
    ':|:&',
    '};',
  ];
  const separators = [';', '|', '&', '&&', '||', ';;', '\n', '\r\n'];
  const joiners = [' ', ' ', ' ', '', '\t', '\n'];

  it('agrees with the original patterns on a seeded sweep (separators, anchors and lookahead included)', () => {
    let seed = 0x1b873593;
    const next = (bound: number): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % bound;
    };
    let destructive = 0;
    const runs = 20_000;
    for (let run = 0; run < runs; run += 1) {
      const length = 1 + next(12);
      let command = '';
      for (let index = 0; index < length; index += 1) {
        const token =
          next(5) === 0
            ? (separators[next(separators.length)] ?? ';')
            : (words[next(words.length)] ?? 'x');
        command += token + (joiners[next(joiners.length)] ?? ' ');
      }
      const expected = ORIGINAL_PATTERNS.some((pattern) =>
        pattern.test(command),
      );
      if (expected) destructive += 1;
      expect(
        defaultIsDestructive(command, '/work'),
        JSON.stringify(command),
      ).toBe(expected);
    }
    // Both outcomes must be well represented, or the sweep proves nothing.
    expect(destructive).toBeGreaterThan(runs * 0.05);
    expect(destructive).toBeLessThan(runs * 0.95);
  });

  it.each([
    ['a separator swallowed by +\\S', 'git push origin +;', true],
    ['a plus refspec followed by a separator word', 'git push +&x', true],
    ['checkout . at the end of the command', 'git checkout .', true],
    [
      'checkout . before a separator is not the end',
      'git checkout .; echo',
      false,
    ],
    ['checkout -- with trailing space', 'git checkout -- ', true],
    ['staged-only restore', 'git restore --staged a', false],
    [
      'restore --staged then an unstaged restore',
      'git restore --staged a restore b',
      true,
    ],
    [
      'unstaged restore then --staged',
      'git restore a restore --staged b',
      false,
    ],
    ['restore staged in another segment', 'git restore a; echo --staged', true],
    [
      'restore --worktree even when staged',
      'git restore --staged --worktree a',
      true,
    ],
    ['gap cannot cross a separator', 'git push; echo --force', false],
    ['gap cannot cross a pipe', 'git push | grep -f x', false],
    ['gap cannot cross a line break', 'git push\necho --force', false],
    ['gap cannot cross a CRLF', 'git reset\r\necho --hard', false],
    ['git on a later line', 'echo a\ngit push --force', true],
    ['git in a later segment', 'echo a; git push --force', true],
    ['a later git after a separator', 'git status; git reset --hard', true],
    ['uppercase', 'GIT PUSH --FORCE', true],
    ['dd to a device', 'dd if=/dev/zero of=/dev/sda', true],
    ['dd to a file', 'dd if=/dev/zero of=./file', false],
    ['find -delete', 'find . -name x -delete', true],
    ['chmod -R', 'chmod -R 777 .', true],
    ['git clean -fd', 'git clean -fd', true],
    ['git clean -n', 'git clean -n', false],
    ['fork bomb spans separators', ':(){ :|:& };', true],
  ])('%s', (_name, command, expected) => {
    expect(defaultIsDestructive(command, '/work')).toBe(expected);
    expect(ORIGINAL_PATTERNS.some((pattern) => pattern.test(command))).toBe(
      expected,
    );
  });
});
