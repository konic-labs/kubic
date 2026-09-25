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

describe('the documented TUI keys match the app (#96 criterion 5)', () => {
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

  it('does NOT document D or J as panel keys: the editor claims them', () => {
    // `tui-app.ts` records the probe: editor bindings claim a/b/c/d/e/f/g/j/
    // k/u/w/y, so a bare `j`/`d` never reaches the global handler.
    const section = tuiSection();
    expect(section).not.toMatch(/`Ctrl-O`[^|]*\(`D`\)/);
    expect(section).not.toMatch(/`Ctrl-R`[^|]*\(`J`\)/);
    expect(section).not.toMatch(/\| `D` \|/);
    expect(section).not.toMatch(/\| `J` \|/);
  });

  it('documents the approval decision keys the surface actually binds', () => {
    // APPROVAL_DEFAULT_KEYS in approval-view.ts: 'a', 's', 'd'+'escape'.
    const viewSource = readFileSync(
      join(repoRoot, 'packages/tui/src/approval-view.ts'),
      'utf8',
    );
    expect(viewSource).toMatch(/'allow-once': \['a'\]/);
    expect(viewSource).toMatch(/'allow-session': \['s'\]/);
    expect(viewSource).toMatch(/deny: \['d', 'escape'\]/);
    const section = tuiSection();
    expect(section).toMatch(/\| `a` \|[^|]*allow once/i);
    expect(section).toMatch(/\| `s` \|[^|]*allow for the session/i);
    expect(section).toMatch(/\| `d`, `Esc` \|[^|]*deny/i);
  });

  it('documents the narrow-terminal threshold the code uses', () => {
    const viewSource = readFileSync(
      join(repoRoot, 'packages/tui/src/approval-view.ts'),
      'utf8',
    );
    const min = /APPROVAL_MIN_WIDTH = (\d+)/.exec(viewSource)?.[1];
    expect(min).toBe('80');
    // The doc says "below 80 columns" — the same number, in prose.
    expect(tuiSection()).toMatch(/below 80 columns/i);
  });

  it('documents the inline fallback by the header the code renders', () => {
    const surfaceSource = readFileSync(
      join(repoRoot, 'packages/tui/src/approval-surface.ts'),
      'utf8',
    );
    const header = /INLINE_APPROVAL_HEADER = '([^']+)'/.exec(
      surfaceSource,
    )?.[1];
    expect(header).toContain('approval (inline)');
    expect(tuiSection()).toContain('approval (inline)');
  });
});
