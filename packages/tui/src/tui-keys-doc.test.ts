// The documented TUI keys must be the keys the app actually honours
// (issue #96 criterion 5).
//
// The implementing child's summary listed the panel keys as "Ctrl-O / Ctrl-R"
// and separately as "`D`/`J`" — the second pair does not exist: `tui-app.ts`
// binds `ctrl+o` and `ctrl+r` only, and its own comment records that pi-tui's
// editor already claims `j`/`d`. Docs that name a keybinding the app ignores
// are the worst kind of wrong: the operator presses it, nothing happens, and
// they conclude the feature is broken. This pins the doc's key table against
// the source of truth so the two cannot drift again.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { INLINE_APPROVAL_HEADER } from './approval-surface.js';
import { APPROVAL_DEFAULT_KEYS, APPROVAL_MIN_WIDTH } from './approval-view.js';

const repoRoot = join(import.meta.dirname, '..', '..', '..');
const appSource = readFileSync(
  join(repoRoot, 'packages/tui/src/tui-app.ts'),
  'utf8',
);
const commandsDoc = readFileSync(
  join(repoRoot, 'docs/cli/commands.md'),
  'utf8',
);

/** The `kubic tui` section of the commands doc. */
function tuiSection(): string {
  const start = commandsDoc.indexOf('## `kubic tui');
  expect(start).toBeGreaterThan(-1);
  const next = commandsDoc.indexOf('\n## ', start + 1);
  return commandsDoc.slice(start, next === -1 ? undefined : next);
}

/** Key ids the app compares against, e.g. 'ctrl+o' from `keyId === 'ctrl+o'`. */
function boundKeyIds(): string[] {
  const ids = new Set<string>();
  for (const match of appSource.matchAll(/keyId === '([^']+)'/g)) {
    ids.add(match[1] as string);
  }
  return [...ids].sort();
}

// Source-text scans: under Stryker every literal in tui-app.ts is
// instrumented, so `keyId === '...'` cannot match there (and a text scan
// kills no mutants).
describe.skipIf(process.env.STRYKER_MUTATOR_WORKER !== undefined)(
  'the documented TUI keys match the app (#96 criterion 5)',
  () => {
    it('finds the section and the bindings at all (not vacuous)', () => {
      // A path or rename bug would otherwise let every assertion below pass
      // against an empty subject.
      expect(tuiSection().length).toBeGreaterThan(200);
      expect(appSource.length).toBeGreaterThan(1000);
      expect(boundKeyIds().length).toBeGreaterThanOrEqual(4);
      expect(boundKeyIds()).toContain('ctrl+o');
      expect(boundKeyIds()).toContain('ctrl+r');
    });

    it('documents Ctrl-O and Ctrl-R for the inspectable panels', () => {
      const section = tuiSection();
      // Table rows: | `key` | meaning | — so the pattern spans the row's pipes.
      expect(section).toMatch(/`Ctrl-O`[^|]*\|[^|]*diff panel/i);
      expect(section).toMatch(/`Ctrl-R`[^|]*\|[^|]*journal panel/i);
    });

    it('documents every key id the app binds as a key-table row', () => {
      // The reverse direction of the drift: a binding the doc never mentions is
      // a feature the operator cannot discover.
      const section = tuiSection();
      // The key-table spelling of a binding id: Esc, the Alt keys by name
      // (the shipped table writes them with the modifier first), and
      // Ctrl-X for the rest.
      const ALT_NAMES: Readonly<Record<string, string>> = {
        'alt+a': 'Alt+A',
        'alt+enter': 'Alt+Enter',
        'alt+m': 'Alt+M',
        'alt+t': 'Alt+T',
      };
      const docName = (id: string): string =>
        id === 'escape'
          ? 'Esc'
          : (ALT_NAMES[id] ??
            id.replace(
              /^ctrl\+(.)$/,
              (_, k: string) => `Ctrl-${k.toUpperCase()}`,
            ));
      const escapeRe = (text: string): string =>
        text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      for (const id of boundKeyIds()) {
        expect(section).toMatch(
          new RegExp(`\\| \`${escapeRe(docName(id))}\` \\|`),
        );
      }
    });

    it('does NOT document D or J as panel keys: the editor claims them', () => {
      // `tui-app.ts` records the probe: editor bindings claim a/b/c/d/e/f/g/j/
      // k/u/w/y, so a bare `j`/`d` never reaches the global handler.
      const section = tuiSection();
      expect(section).not.toMatch(/`Ctrl-O`[^|]*\(`D`\)/);
      expect(section).not.toMatch(/`Ctrl-R`[^|]*\(`J`\)/);
      expect(section).not.toMatch(/\| `D` \|/);
      expect(section).not.toMatch(/\| `J` \|/);
    });

    it('documents the transcript scroll keys the alt screen claims (#302)', () => {
      // pi-tui's alt screen registers these ahead of the Kubic listener, so
      // they scroll the transcript and Home/End never reach the editor —
      // an operator who is not told that concludes the keys are broken.
      const section = tuiSection();
      expect(section).toMatch(/\| `PageUp` \/ `PageDown` \|/);
      expect(section).toMatch(/\| `Home` \/ `End` \|/);
      expect(section).toMatch(/`Ctrl-Up` \/ `Ctrl-Down`/);
      expect(section).toMatch(/`Ctrl-Shift-F`/);
      // The line-start/end replacement is named, or the loss looks silent.
      expect(section).toMatch(/`Ctrl-A` \/ `Ctrl-E`[^|]*line start \/ end/i);
    });

    it('documents the approval decision keys the surface actually binds', () => {
      // The shipped binding table itself, not a regex over its source text.
      expect(APPROVAL_DEFAULT_KEYS).toEqual({
        'allow-once': ['a'],
        'allow-session': ['ctrl+s'],
        deny: ['d', 'escape'],
      });
      const section = tuiSection();
      expect(section).toMatch(/\| `a` \|[^|]*allow once/i);
      expect(section).toMatch(/\| `Ctrl-S` \|[^|]*allow for the session/i);
      expect(section).toMatch(/arming delay[^.]*400 ms/i);
      expect(section).toMatch(/\| `d`, `Esc` \|[^|]*deny/i);
    });

    it('documents the narrow-terminal threshold the code uses', () => {
      // The doc says "below N columns" — the code's number, in prose.
      expect(tuiSection()).toMatch(
        new RegExp(`below ${APPROVAL_MIN_WIDTH} columns`, 'i'),
      );
    });

    it('documents the inline fallback by the header the code renders', () => {
      // The doc quotes the header's leading, width-independent part.
      const quoted = INLINE_APPROVAL_HEADER.split(' — ')[0] as string;
      expect(quoted).toBe('! approval (inline)');
      expect(tuiSection()).toContain(`\`${quoted}\``);
    });
  },
);
