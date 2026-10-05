// Deterministic manifest encoding (design §74). canonicalJson is what
// makes RL manifests and verifier digests reproducible, so its edge cases
// are pinned directly: key order at every depth, dropped undefined values,
// the non-finite and uncapturable throws, and JSON.stringify escaping
// parity. A refactor that breaks any of these must fail here.
import { describe, expect, it } from 'vitest';
import { canonicalJson } from './manifest.js';

describe('canonicalJson (design §74)', () => {
  it('sorts keys at every depth and drops undefined object values', () => {
    expect(canonicalJson({ b: { d: 1, c: 2 }, a: [2, 1], u: undefined })).toBe(
      '{"a":[2,1],"b":{"c":2,"d":1}}',
    );
    expect(
      canonicalJson({ z: { b: { y: 1, x: 2 }, a: [{ q: 1, p: 2 }] } }),
    ).toBe('{"z":{"a":[{"p":2,"q":1}],"b":{"x":2,"y":1}}}');
  });

  it('sorts keys ascending in UTF-16 code-unit order, whatever the insertion order', () => {
    for (const value of [
      { a: 1, b: 1, c: 1 },
      { c: 1, b: 1, a: 1 },
      { b: 1, c: 1, a: 1 },
    ]) {
      expect(canonicalJson(value)).toBe('{"a":1,"b":1,"c":1}');
    }
    // String order, not numeric: '10' precedes '2'.
    expect(canonicalJson({ 2: 'two', 10: 'ten' })).toBe(
      '{"10":"ten","2":"two"}',
    );
    // A prefix sorts before the longer key.
    expect(canonicalJson({ ab: 1, aa: 2, a: 3 })).toBe('{"a":3,"aa":2,"ab":1}');
    // ASCII before non-ASCII code units.
    expect(canonicalJson({ é: 1, z: 2 })).toBe('{"z":2,"é":1}');
  });

  it('keeps array order', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
    expect(canonicalJson({ a: [{ b: 1, a: 2 }, 'z'] })).toBe(
      '{"a":[{"a":2,"b":1},"z"]}',
    );
  });

  it('matches JSON.stringify on null, booleans and numbers, including -0', () => {
    for (const value of [null, true, false, 0, -0, 42, -1.5, 1e21, 0.1]) {
      expect(canonicalJson(value)).toBe(JSON.stringify(value));
    }
  });

  it('matches JSON.stringify string escaping', () => {
    for (const value of [
      'plain',
      'say "hi"',
      'back\\slash',
      'line\nbreak\ttab\rreturn',
      '\u0000\u001f',
      'caf\u00e9 \u2603',
      '\ud83d\ude80',
      '\u2028\u2029',
    ]) {
      expect(canonicalJson(value)).toBe(JSON.stringify(value));
    }
  });

  it('throws on every non-finite number, at any depth', () => {
    for (const value of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]) {
      expect(() => canonicalJson(value)).toThrow('non-finite number');
      expect(() => canonicalJson({ a: [value] })).toThrow('non-finite number');
    }
  });

  it('throws the uncapturable-value error on functions, bigints and symbols', () => {
    expect(() => canonicalJson(() => 1)).toThrow(
      'uncapturable value of type function',
    );
    expect(() => canonicalJson({ a: 1n })).toThrow(
      'uncapturable value of type bigint',
    );
    expect(() => canonicalJson([Symbol('s')])).toThrow(
      'uncapturable value of type symbol',
    );
  });

  it('refuses a top-level undefined instead of emitting an empty manifest', () => {
    expect(() => canonicalJson(undefined)).toThrow(
      'uncapturable value of type undefined',
    );
    expect(() => canonicalJson([undefined])).toThrow(
      'uncapturable value of type undefined',
    );
  });
});
