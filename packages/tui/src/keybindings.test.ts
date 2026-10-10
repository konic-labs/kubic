// The keybinding registry: defaults, overrides
// from ~/.kubic/keybindings.json, conflict reporting, canonical key ids.
import { describe, expect, it } from 'vitest';
import {
  canonicalKey,
  createKeyRegistry,
  DEFAULT_KEY_REGISTRY,
  KEY_ACTION_IDS,
  KeybindingsError,
  parseKeybindingsJson,
} from './keybindings.js';

describe('keybinding registry defaults', () => {
  it('binds every shipped global key to its action', () => {
    const keys = DEFAULT_KEY_REGISTRY;
    expect(keys.actionFor('global', 'ctrl+o')).toBe('panel.diff');
    expect(keys.actionFor('global', 'ctrl+r')).toBe('panel.journal');
    // Esc is the cancel key; quitting has no default key.
    expect(keys.actionFor('global', 'escape')).toBe('app.cancel');
    expect(keys.keysFor('app.exit')).toEqual([]);
    expect(keys.label('app.exit')).toBe('');
    expect(keys.actionFor('global', 'alt+down')).toBe('panel.next');
    expect(keys.notices).toEqual([]);
  });

  it('keeps the approval keys in their own scope (Esc denies there, cancels globally)', () => {
    const keys = DEFAULT_KEY_REGISTRY;
    expect(keys.actionFor('approval', 'escape')).toBe('approval.deny');
    expect(keys.actionFor('approval', 'v')).toBe('approval.page');
    expect(keys.actionFor('global', 'v')).toBeUndefined();
    expect(keys.isGlobalKey('a')).toBe(false);
    expect(keys.approvalOverrides()).toEqual({
      'allow-once': ['a'],
      'allow-session': ['ctrl+s'],
      deny: ['d', 'escape'],
      comment: ['c'],
      edit: ['e'],
      'allow-edits': ['shift+a'],
    });
  });

  it('only claims global-scope keys ahead of the editor (panel keys are not global)', () => {
    expect(DEFAULT_KEY_REGISTRY.isGlobalKey('ctrl+o')).toBe(true);
    expect(DEFAULT_KEY_REGISTRY.isGlobalKey('alt+down')).toBe(false);
    expect(DEFAULT_KEY_REGISTRY.isGlobalKey(undefined)).toBe(false);
  });

  it('compares canonical ids: pi-tui is not modifier-order stable', () => {
    expect(canonicalKey('shift+ctrl+f')).toBe('ctrl+shift+f');
    expect(canonicalKey('Ctrl+O')).toBe('ctrl+o');
    expect(canonicalKey('pageUp')).toBe('pageup');
    expect(canonicalKey('ctrl+ctrl+o')).toBeUndefined();
    expect(canonicalKey('hyper+o')).toBeUndefined();
    expect(canonicalKey('ctrl+word')).toBeUndefined();
    const keys = createKeyRegistry({ 'panel.diff': ['ctrl+shift+f'] });
    expect(keys.actionFor('global', 'shift+ctrl+f')).toBe('panel.diff');
  });

  it('reads a capital letter as the shifted key, as pi-tui does', () => {
    // A legacy terminal sends `L` for Shift+L; pi-tui parses it as `L`.
    expect(canonicalKey('L')).toBe('shift+l');
    expect(canonicalKey('l')).toBe('l');
    expect(canonicalKey('ctrl+L')).toBe('ctrl+l');
    expect(DEFAULT_KEY_REGISTRY.actionFor('approval', 'A')).toBe(
      'approval.allowEdits',
    );
    expect(DEFAULT_KEY_REGISTRY.actionFor('approval', 'a')).toBe(
      'approval.allowOnce',
    );
  });
});

describe('keybinding overrides', () => {
  it('an override replaces the defaults and the old key falls through', () => {
    const keys = createKeyRegistry({
      'panel.diff': ['ctrl+g'],
      'panel.journal': ['alt+g'],
    });
    expect(keys.actionFor('global', 'ctrl+g')).toBe('panel.diff');
    expect(keys.actionFor('global', 'alt+g')).toBe('panel.journal');
    expect(keys.actionFor('global', 'ctrl+o')).toBeUndefined();
    expect(keys.isGlobalKey('ctrl+o')).toBe(false);
    expect(keys.label('panel.diff')).toBe('ctrl+g');
    expect(keys.notices).toEqual([]);
  });

  it('an override that takes a default key reports the displaced action', () => {
    const keys = createKeyRegistry({ 'panel.diff': ['ctrl+r'] });
    expect(keys.actionFor('global', 'ctrl+r')).toBe('panel.diff');
    expect(keys.keysFor('panel.journal')).toEqual([]);
    expect(keys.notices).toEqual([
      'keybinding: ctrl+r now runs panel.diff (override), so panel.journal no longer has it',
      'keybinding: panel.journal is unbound',
    ]);
  });

  it('two overrides on one key are a conflict: named, the first keeps it', () => {
    const keys = createKeyRegistry({
      'panel.diff': ['ctrl+y'],
      'panel.journal': ['ctrl+y'],
    });
    expect(keys.actionFor('global', 'ctrl+y')).toBe('panel.diff');
    expect(keys.notices).toContain(
      'keybinding conflict: ctrl+y is bound to both panel.diff and panel.journal — panel.diff keeps it',
    );
    expect(keys.notices).toContain('keybinding: panel.journal is unbound');
  });

  it('an approval override conflicts only inside the approval scope', () => {
    // Esc stays the global cancel even though deny also binds it: the
    // approval owns the keys first while it shows, so that overlap is by
    // design.
    const keys = createKeyRegistry({ 'approval.allowOnce': ['y'] });
    expect(keys.notices).toEqual([]);
    expect(keys.approvalOverrides()['allow-once']).toEqual(['y']);
    expect(keys.actionFor('global', 'escape')).toBe('app.cancel');
  });

  it('still lets the operator bind a quit key', () => {
    const keys = createKeyRegistry({ 'app.exit': ['ctrl+q'] });
    expect(keys.notices).toEqual([]);
    expect(keys.actionFor('global', 'ctrl+q')).toBe('app.exit');
    expect(keys.label('app.exit')).toBe('ctrl+q');
  });
});

describe('parseKeybindingsJson', () => {
  it('accepts a key or a list per action, canonicalised', () => {
    expect(
      parseKeybindingsJson(
        '{"panel.diff": "Ctrl+G", "approval.deny": ["d", "escape"], "view.tree": []}',
        'k.json',
      ),
    ).toEqual({
      'panel.diff': ['ctrl+g'],
      'approval.deny': ['d', 'escape'],
      'view.tree': [],
    });
  });

  it('refuses an unknown action, a bad key id and broken JSON by name', () => {
    expect(() =>
      parseKeybindingsJson('{"panel.dif": "ctrl+g"}', 'k.json'),
    ).toThrow(/unknown action 'panel\.dif'/);
    expect(() =>
      parseKeybindingsJson('{"panel.diff": "ctrl+wat"}', 'k.json'),
    ).toThrow(/'panel\.diff' has an invalid key id 'ctrl\+wat'/);
    expect(() => parseKeybindingsJson('{', 'k.json')).toThrow(KeybindingsError);
    expect(() => parseKeybindingsJson('[]', 'k.json')).toThrow(
      /expected an object/,
    );
    expect(() => parseKeybindingsJson('{"panel.diff": 5}', 'k.json')).toThrow(
      /must be a key id or a list/,
    );
  });

  it('knows every registry action by id', () => {
    expect(KEY_ACTION_IDS).toContain('panel.diff');
    expect(KEY_ACTION_IDS).toContain('approval.page');
  });
});
