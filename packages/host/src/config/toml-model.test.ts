// The `[model]` table writer behind `kubic setup`.
import { describe, expect, it } from 'vitest';
import { upsertModelTable } from './toml-model.js';

const VALUES = { provider: 'anthropic', id: 'claude-sonnet', thinking: 'high' };

describe('upsertModelTable', () => {
  it('creates the table in an empty file', () => {
    expect(upsertModelTable('', VALUES)).toBe(
      '[model]\nprovider = "anthropic"\nid = "claude-sonnet"\nthinking = "high"\n',
    );
  });

  it('appends the table after existing content, separated by a blank line', () => {
    const text = '# my config\n[ui]\ntheme = "dark"\n';
    expect(upsertModelTable(text, VALUES)).toBe(
      '# my config\n[ui]\ntheme = "dark"\n\n[model]\nprovider = "anthropic"\nid = "claude-sonnet"\nthinking = "high"\n',
    );
  });

  it('updates keys in place and keeps comments and other keys', () => {
    const text = [
      '[model]',
      '# pinned for work',
      'provider = "openai"',
      '  id = "gpt-5"',
      'escalate = ["anthropic/opus"]',
      '',
      '[ui]',
      'theme = "light"',
      '',
    ].join('\n');
    expect(upsertModelTable(text, VALUES)).toBe(
      [
        '[model]',
        '# pinned for work',
        'provider = "anthropic"',
        '  id = "claude-sonnet"',
        'escalate = ["anthropic/opus"]',
        'thinking = "high"',
        '',
        '[ui]',
        'theme = "light"',
        '',
      ].join('\n'),
    );
  });

  it('leaves thinking alone when none is given', () => {
    const text = '[model]\nprovider = "a"\nid = "b"\nthinking = "low"\n';
    expect(
      upsertModelTable(text, { provider: 'anthropic', id: 'claude-sonnet' }),
    ).toBe(
      '[model]\nprovider = "anthropic"\nid = "claude-sonnet"\nthinking = "low"\n',
    );
  });

  it('keeps CRLF line endings', () => {
    const text = '[ui]\r\ntheme = "dark"\r\n';
    expect(upsertModelTable(text, VALUES)).toBe(
      '[ui]\r\ntheme = "dark"\r\n\r\n[model]\r\nprovider = "anthropic"\r\nid = "claude-sonnet"\r\nthinking = "high"\r\n',
    );
  });

  it('finds a header with spacing and a trailing comment', () => {
    const text = '[ model ]  # mine\nprovider = "x"\n';
    expect(upsertModelTable(text, VALUES)).toBe(
      '[ model ]  # mine\nprovider = "anthropic"\nid = "claude-sonnet"\nthinking = "high"\n',
    );
  });

  it('quotes values as TOML strings', () => {
    expect(upsertModelTable('', { provider: 'p', id: 'a"b\\c' })).toContain(
      'id = "a\\"b\\\\c"',
    );
  });
});
