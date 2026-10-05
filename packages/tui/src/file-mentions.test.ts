// @-file mention completion (issue #336; §16.5): typing `@` and part of a
// path offers matching workspace files, fuzzy and capped, and Tab inserts the
// workspace-relative path. The file list comes from the composition root
// (a gitignore-aware walk), so this module never touches the filesystem.
import { describe, expect, it, vi } from 'vitest';
import { PromptEditor } from './editor-view.js';
import {
  CombinedAutocomplete,
  FILE_MENTION_MAX,
  FileMentionAutocomplete,
  rankFileMentions,
} from './file-mentions.js';
import { SlashCommandAutocomplete } from './slash-commands.js';

const FILES = [
  'README.md',
  'src/main.ts',
  'src/map.ts',
  'src/util/math.ts',
  'docs/my notes.md',
];

// Pi debounces an @ request (20 ms) and resolves the provider
// asynchronously, so the tests wait for the popup itself — a bounded
// condition wait, never a fixed sleep.
async function popupShows(editor: PromptEditor, text: string): Promise<void> {
  await vi.waitFor(() => expect(editor.render(80).join('\n')).toContain(text), {
    timeout: 2000,
    interval: 5,
  });
}

describe('rankFileMentions (issue #336)', () => {
  it('offers every path matching the query, basename and prefix matches first', () => {
    expect(rankFileMentions(FILES, 'src/ma')).toEqual([
      'src/map.ts',
      'src/main.ts',
      'src/util/math.ts',
    ]);
    expect(rankFileMentions(FILES, 'math')[0]).toBe('src/util/math.ts');
    expect(rankFileMentions(FILES, 'zzz')).toEqual([]);
  });

  it('caps the offered list', () => {
    const many = Array.from({ length: 500 }, (_, i) => `f/file${i}.ts`);
    expect(rankFileMentions(many, 'file')).toHaveLength(FILE_MENTION_MAX);
  });
});

describe('@ mentions in the prompt editor (issue #336)', () => {
  const editorWith = (files: readonly string[]) => {
    const editor = new PromptEditor();
    editor.setAutocomplete(
      new CombinedAutocomplete([
        new SlashCommandAutocomplete(),
        new FileMentionAutocomplete(() => files),
      ]),
    );
    return editor;
  };

  it('typing @src/ma offers the matching files and Tab inserts the path', async () => {
    const editor = editorWith(FILES);
    for (const ch of 'look at @src/ma') editor.handleInput(ch);
    await popupShows(editor, 'src/main.ts');
    const frame = editor.render(80).join('\n');
    expect(frame).toContain('src/main.ts');
    expect(frame).toContain('src/map.ts');
    editor.handleInput('\t');
    expect(editor.getText()).toBe('look at @src/map.ts ');
  });

  it('quotes a path with spaces', async () => {
    const editor = editorWith(FILES);
    for (const ch of '@my') editor.handleInput(ch);
    await popupShows(editor, 'docs/my notes.md');
    editor.handleInput('\t');
    expect(editor.getText()).toBe('@"docs/my notes.md" ');
  });

  it('only offers what the file source lists (gitignored files never reach it)', async () => {
    // The composition root's walk honours .gitignore; a path it did not list
    // is never offered, whatever the query.
    const provider = new FileMentionAutocomplete(() => ['src/main.ts']);
    await expect(
      provider.getSuggestions(['@dist/out'], 0, 9),
    ).resolves.toBeNull();
    await expect(
      provider.getSuggestions(['@src/m'], 0, 6),
    ).resolves.toMatchObject({ items: [{ label: 'src/main.ts' }] });
  });

  it('still completes slash commands through the shared provider', async () => {
    const editor = editorWith(FILES);
    editor.handleInput('/');
    for (const ch of 'hel') editor.handleInput(ch);
    await popupShows(editor, '/help');
  });
});
