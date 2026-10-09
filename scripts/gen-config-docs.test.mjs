// The config docs generator over a small schema: the key table, the section
// list, the example config and the markers it writes between.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  renderExample,
  renderKeyTable,
  renderSectionList,
  replaceBetween,
} from './gen-config-docs.mjs';

const SECTIONS = [
  {
    name: 'agent',
    shape: 'table',
    keys: [
      { name: 'name', example: '"kubic"' },
      { name: 'systemPromptFile', note: ['A note.'], example: '"SYSTEM.md"' },
    ],
    docs: [{ keys: ['agent.name'], text: 'The agent id.' }],
  },
  {
    name: 'roles',
    shape: 'tables',
    keys: [{ name: 'model' }],
    exampleTables: { reviewer: ['model = "local/m"'] },
    docs: [{ keys: ['roles.<name>.model'], label: '`roles.*`', text: 'Pins.' }],
  },
  {
    name: 'audit',
    shape: 'array',
    keys: [{ name: 'sink', required: true }],
    exampleTables: { one: ['sink = "file"'] },
    docs: [],
  },
  {
    name: 'skills',
    shape: 'value',
    keys: [{ name: 'skills', example: '["./skills"]' }],
    docs: [{ keys: ['skills'], text: 'Skills.' }],
  },
];

describe('gen-config-docs', () => {
  it('renders one table row per docs row, the label overriding the keys', () => {
    assert.equal(
      renderKeyTable(SECTIONS),
      [
        '| Key | Effect |',
        '| --- | --- |',
        '| `agent.name` | The agent id. |',
        '| `roles.*` | Pins. |',
        '| `skills` | Skills. |',
      ].join('\n'),
    );
  });

  it('lists each section with its keys', () => {
    assert.equal(
      renderSectionList(SECTIONS),
      [
        '- `[agent]`: `name`, `systemPromptFile`',
        '- `[roles.<name>]`, one table per name: `model`',
        '- `[[audit]]`, an array of tables: `sink` (required)',
        '- `skills`: a top-level key, not a section',
      ].join('\n'),
    );
  });

  it('writes the top-level keys before every table', () => {
    assert.equal(
      renderExample(SECTIONS, ['Header.']),
      [
        '# Header.',
        '',
        'skills = ["./skills"]',
        '',
        '[agent]',
        'name = "kubic"',
        '# A note.',
        'systemPromptFile = "SYSTEM.md"',
        '',
        '[roles.reviewer]',
        'model = "local/m"',
        '',
        '[[audit]]',
        'sink = "file"',
        '',
      ].join('\n'),
    );
  });

  it('replaces only what sits between the markers', () => {
    const text =
      'before\n<!-- generated:x -->\nold\n<!-- /generated:x -->\nafter\n';
    assert.equal(
      replaceBetween(text, 'x', 'new'),
      'before\n<!-- generated:x -->\nnew\n<!-- /generated:x -->\nafter\n',
    );
    assert.throws(() => replaceBetween('no markers', 'x', 'new'), /markers/);
  });
});
