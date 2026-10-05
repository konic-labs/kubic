// Secret-reference parsing (issue #224; design §36.2). The WORKER's
// models.json parser and the HOST's request-time resolver share this one
// table through @kubic/core (same direction as secret-shapes.ts) — the
// parse shapes carry no secrets, only forms.
import { describe, expect, it } from 'vitest';
import {
  parseSecretRef,
  SecretRefError,
  splitSecretCommand,
} from './secret-refs.js';

describe('splitSecretCommand (issue #224)', () => {
  it('splits plain whitespace like before', () => {
    expect(splitSecretCommand('pass show api-key')).toEqual([
      'pass',
      'show',
      'api-key',
    ]);
    expect(splitSecretCommand('  spaced\tout  ')).toEqual(['spaced', 'out']);
  });

  it('keeps a quoted argument a single argv element', () => {
    expect(splitSecretCommand('op read "my vault/item"')).toEqual([
      'op',
      'read',
      'my vault/item',
    ]);
    expect(
      splitSecretCommand("vault kv get -field=password 'secret/path'"),
    ).toEqual(['vault', 'kv', 'get', '-field=password', 'secret/path']);
  });

  it('backslash quotes the next character anywhere', () => {
    expect(splitSecretCommand('echo my\\ vault')).toEqual(['echo', 'my vault']);
    expect(splitSecretCommand('echo "say \\"hi\\""')).toEqual([
      'echo',
      'say "hi"',
    ]);
  });

  it('an unterminated boundary quote runs to the end, never throws', () => {
    // A quote that OPENS at a word boundary is syntax (consumed); the
    // word still arrives whole, minus the quote mark.
    expect(splitSecretCommand('echo "unclosed')).toEqual(['echo', 'unclosed']);
  });

  it('treats quotes as syntax only at word boundaries (issue #224 GAP)', () => {
    // A mid-word quote is far more likely an apostrophe than grouping:
    // it stays literal so the helper receives what was written.
    expect(splitSecretCommand("echo don't")).toEqual(['echo', "don't"]);
    expect(splitSecretCommand('echo a"b')).toEqual(['echo', 'a"b']);
    expect(splitSecretCommand("echo a'b'c")).toEqual(['echo', "a'b'c"]);
    // Boundary quotes still group, and a close always closes.
    expect(splitSecretCommand('op read "my vault/item"')).toEqual([
      'op',
      'read',
      'my vault/item',
    ]);
    expect(splitSecretCommand('echo "foo"bar')).toEqual(['echo', 'foobar']);
  });

  it('yields nothing for blank input', () => {
    expect(splitSecretCommand('')).toEqual([]);
    expect(splitSecretCommand('   ')).toEqual([]);
  });
});

describe('parseSecretRef (issue #224)', () => {
  it('parses $ENV refs', () => {
    expect(parseSecretRef('$MY_KEY')).toEqual({
      kind: 'env',
      name: 'MY_KEY',
      raw: '$MY_KEY',
    });
  });

  it('splits !command quote-aware', () => {
    expect(parseSecretRef('!op read "my vault/item"')).toEqual({
      kind: 'command',
      argv: ['op', 'read', 'my vault/item'],
      raw: '!op read "my vault/item"',
    });
  });

  it('keeps the escapes and literals', () => {
    expect(parseSecretRef('\\$literal')).toEqual({
      kind: 'literal',
      value: '$literal',
    });
    expect(parseSecretRef('\\!literal')).toEqual({
      kind: 'literal',
      value: '!literal',
    });
    expect(parseSecretRef('not-needed')).toEqual({
      kind: 'literal',
      value: 'not-needed',
    });
    expect(parseSecretRef('$')).toEqual({ kind: 'literal', value: '$' });
  });

  it('refuses non-strings and empty commands by name', () => {
    expect(() => parseSecretRef(null)).toThrow(SecretRefError);
    expect(() => parseSecretRef('!')).toThrow(/empty !command/);
    expect(() => parseSecretRef('!   ')).toThrow(/empty !command/);
  });
});
