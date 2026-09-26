// Shared argv flag parser (issue #127; §78). Faux-free, dependency-free:
// pure string handling, so the contract is pinned at the unit level.
//
// The rules every command used to hand-roll:
//   --name=value    value verbatim (may start with '--')
//   --name value    positional value form (refused when the value is
//                   flag-like: `missing`, today's typo-catching rule)
//   --name/-alias   boolean flags
//   --skill         repeatable value flags collect arrays in insertion order
//   --              end of flags: everything after is positional, verbatim
//   --bogus         collected in `unknown` (callers keep their strictness)
import { describe, expect, it } from 'vitest';
import { type FlagSpec, parseFlagArgs } from './flags.js';

const SPEC: readonly FlagSpec[] = [
  { name: '--prompt', takes: 'value', aliases: ['-p'] },
  { name: '--session', takes: 'value' },
  { name: '--skill', takes: 'value', repeat: true },
  { name: '--no-skills', takes: 'boolean' },
  { name: '--json', takes: 'boolean' },
];

describe('parseFlagArgs (issue #127)', () => {
  it('refuses a flag-like positional value: --prompt --help → missing', () => {
    const parsed = parseFlagArgs(['--prompt', '--help'], SPEC);
    expect(parsed.values['--prompt']).toBeUndefined();
    expect(parsed.missing).toEqual(['--prompt']);
    expect(parsed.unknown).toEqual(['--help']);
    expect(parsed.positional).toEqual([]);
  });

  it('takes an equals-form value verbatim, even a flag-like one', () => {
    const parsed = parseFlagArgs(['--prompt=--help'], SPEC);
    expect(parsed.values['--prompt']).toBe('--help');
    expect(parsed.missing).toEqual([]);
    expect(parsed.unknown).toEqual([]);
    expect(parsed.positional).toEqual([]);
  });

  it('preserves an equals-form empty value', () => {
    const parsed = parseFlagArgs(['--prompt='], SPEC);
    expect(parsed.values['--prompt']).toBe('');
    expect(parsed.missing).toEqual([]);
  });

  it('takes the equals form through an alias', () => {
    const parsed = parseFlagArgs(['-p=--help'], SPEC);
    expect(parsed.values['--prompt']).toBe('--help');
  });

  it('ends flag parsing at --: -p -- --help → --help is positional', () => {
    const parsed = parseFlagArgs(['-p', '--', '--help'], SPEC);
    expect(parsed.values['--prompt']).toBeUndefined();
    expect(parsed.missing).toEqual(['--prompt']);
    expect(parsed.positional).toEqual(['--help']);
    expect(parsed.unknown).toEqual([]);
  });

  it('preserves positionals before and after the -- terminator', () => {
    const parsed = parseFlagArgs(
      ['one', '--', '--two', '--three=4', 'five'],
      SPEC,
    );
    expect(parsed.positional).toEqual(['one', '--two', '--three=4', 'five']);
    expect(parsed.unknown).toEqual([]);
  });

  it('treats a lone -- as a terminator with nothing after it', () => {
    const parsed = parseFlagArgs(['--'], SPEC);
    expect(parsed.positional).toEqual([]);
    expect(parsed.missing).toEqual([]);
    expect(parsed.unknown).toEqual([]);
  });

  it('collects repeatable values in insertion order across both forms', () => {
    const parsed = parseFlagArgs(
      ['--skill', 'a', '--skill=b', '--skill', 'c'],
      SPEC,
    );
    expect(parsed.values['--skill']).toEqual(['a', 'b', 'c']);
  });

  it('keeps a repeatable flag absent when never given', () => {
    const parsed = parseFlagArgs([], SPEC);
    expect(parsed.values['--skill']).toBeUndefined();
    expect(parsed.missing).toEqual([]);
  });

  it('lets the last occurrence win for a non-repeatable value flag', () => {
    const parsed = parseFlagArgs(['--prompt', 'a', '--prompt', 'b'], SPEC);
    expect(parsed.values['--prompt']).toBe('b');
  });

  it('sets boolean flags true and collects unknown --flags strictly', () => {
    const parsed = parseFlagArgs(
      ['--no-skills', '--json', '--bogus', '--x=1'],
      SPEC,
    );
    expect(parsed.values['--no-skills']).toBe(true);
    expect(parsed.values['--json']).toBe(true);
    expect(parsed.unknown).toEqual(['--bogus', '--x=1']);
  });

  it('does not accept the equals form for boolean flags', () => {
    const parsed = parseFlagArgs(['--json=1'], SPEC);
    expect(parsed.values['--json']).toBeUndefined();
    expect(parsed.unknown).toEqual(['--json=1']);
  });

  it('keeps single-dash non-alias tokens positional', () => {
    const parsed = parseFlagArgs(['-x', '-5', 'plain'], SPEC);
    expect(parsed.positional).toEqual(['-x', '-5', 'plain']);
    expect(parsed.unknown).toEqual([]);
  });

  it('records a missing value flag and still parses the next token as a flag', () => {
    const parsed = parseFlagArgs(['--session', '--json'], SPEC);
    expect(parsed.missing).toEqual(['--session']);
    expect(parsed.values['--json']).toBe(true);
    expect(parsed.positional).toEqual([]);
  });

  it('records every missing value flag in encounter order', () => {
    const parsed = parseFlagArgs(['--session', '--skill', '--prompt'], SPEC);
    expect(parsed.missing).toEqual(['--session', '--skill', '--prompt']);
  });

  it('records a trailing value flag with no next token as missing', () => {
    const parsed = parseFlagArgs(['--prompt'], SPEC);
    expect(parsed.missing).toEqual(['--prompt']);
  });

  it('collects a --value token as a value when it does not start with --', () => {
    const parsed = parseFlagArgs(['--session', '-5'], SPEC);
    expect(parsed.values['--session']).toBe('-5');
    expect(parsed.missing).toEqual([]);
  });

  it('treats an empty spec as "no flags": operands only, --b stays unknown', () => {
    const parsed = parseFlagArgs(['a', '--b', '--', 'c'], []);
    expect(parsed.positional).toEqual(['a', 'c']);
    expect(parsed.unknown).toEqual(['--b']);
  });
});
