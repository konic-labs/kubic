// The config schema is complete: every key is documented, resolves to a
// runtime row, and parses its own example.
import { describe, expect, it } from 'vitest';
import { parseTomlConfig } from './config.js';
import { keyEffectFor } from './runtime-view.js';
import { CONFIG_SECTIONS, type ConfigKey } from './schema.js';

// Every key, by the name the docs and the runtime rows use.
function dottedKeys(): string[] {
  return CONFIG_SECTIONS.flatMap((section) =>
    (section.keys as readonly ConfigKey[]).map((key) => {
      switch (section.shape) {
        case 'value':
          return key.name;
        case 'tables':
          return `${section.name}.<name>.${key.name}`;
        default:
          return `${section.name}.${key.name}`;
      }
    }),
  );
}

describe('the config schema', () => {
  it('documents every key in a docs row', () => {
    const documented = new Set(
      CONFIG_SECTIONS.flatMap((section) =>
        section.docs.flatMap((row) => row.keys as readonly string[]),
      ),
    );
    expect(dottedKeys().filter((key) => !documented.has(key))).toEqual([]);
  });

  it('documents only keys it declares', () => {
    const declared = new Set(dottedKeys());
    const rows = CONFIG_SECTIONS.flatMap((section) =>
      section.docs.flatMap((row) => row.keys as readonly string[]),
    );
    expect(rows.filter((key) => !declared.has(key))).toEqual([]);
  });

  it('gives every key a runtime row, its own or its section', () => {
    expect(
      dottedKeys().filter(
        (key) =>
          keyEffectFor(key.replace('.<name>', '.reviewer')) === undefined,
      ),
    ).toEqual([]);
  });

  it('parses every example value it declares', () => {
    for (const section of CONFIG_SECTIONS) {
      for (const key of section.keys as readonly ConfigKey[]) {
        if (key.example === undefined) continue;
        const text =
          section.shape === 'value'
            ? `${key.name} = ${key.example}\n`
            : `[${section.name}]\n${key.name} = ${key.example}\n`;
        expect(() => parseTomlConfig(text)).not.toThrow();
      }
    }
  });
});
