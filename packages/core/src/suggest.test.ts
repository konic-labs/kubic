// "Did you mean …?".
import { describe, expect, it } from 'vitest';
import { editDistance, suggest } from './suggest.js';

describe('editDistance', () => {
  it('counts inserts, deletes, substitutions and adjacent swaps', () => {
    expect(editDistance('status', 'status')).toBe(0);
    expect(editDistance('stauts', 'status')).toBe(1);
    expect(editDistance('gpt-x', 'gpt-5')).toBe(1);
    expect(editDistance('antropic', 'anthropic')).toBe(1);
    expect(editDistance('', 'abc')).toBe(3);
    expect(editDistance('Doctor', 'doctor')).toBe(0);
  });
});

describe('suggest', () => {
  const commands = ['run', 'tui', 'status', 'diff', 'doctor', 'models'];
  it('names the closest candidate within the threshold', () => {
    expect(suggest('stauts', commands)).toEqual(['status']);
    expect(suggest('docter', commands)).toEqual(['doctor']);
    expect(suggest('modles', commands)).toEqual(['models']);
  });
  it('keeps the candidate order on ties and honours the limit', () => {
    expect(suggest('rux', ['run', 'tui', 'rua'], 2)).toEqual(['run', 'rua']);
  });
  it('falls back to the only candidate containing the input', () => {
    expect(suggest('sonnet', ['claude-opus-5-5', 'claude-sonnet-5-5'])).toEqual(
      ['claude-sonnet-5-5'],
    );
    expect(suggest('claude', ['claude-opus-5-5', 'claude-sonnet-5-5'])).toEqual(
      [],
    );
  });
  it('suggests nothing for far-off, empty or exact input', () => {
    expect(suggest('xyzzy', commands)).toEqual([]);
    expect(suggest('', commands)).toEqual([]);
    expect(suggest('status', commands)).toEqual([]);
    expect(suggest('abc', [])).toEqual([]);
  });
});
