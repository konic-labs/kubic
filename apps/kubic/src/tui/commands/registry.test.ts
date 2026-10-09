// The handler table and the registry the palette, autocomplete and `/help`
// read name the same commands.
import { SLASH_COMMANDS } from '@kubic/tui/slash-commands';
import { describe, expect, it } from 'vitest';
import { TUI_COMMANDS } from './registry.js';

describe('the slash-command handlers', () => {
  it('handle exactly the commands the registry lists', () => {
    expect([...TUI_COMMANDS.keys()].sort()).toEqual(
      SLASH_COMMANDS.map((spec) => spec.name).sort(),
    );
  });

  it('answer the lane commands before the lane check, and only those', () => {
    const lane = [...TUI_COMMANDS]
      .filter(([, handler]) => handler.lane === true)
      .map(([name]) => name)
      .sort();
    expect(lane).toEqual(['compact', 'escalate', 'model', 'thinking']);
  });
});
