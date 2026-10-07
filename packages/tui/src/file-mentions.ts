// @-file mention completion for the prompt editor (Pi
// parity). Typing `@` and part of a path offers matching workspace files;
// Tab (or Enter on the popup) inserts the workspace-relative path as
// `@path` — `@"path with spaces"` when it needs quoting — followed by a
// space. Only the path is sent with the prompt: no file content is attached
// (the model reads the file with its own tools when it needs it).
//
// The file list is injected: the composition root walks the workspace with
// the gitignore-aware walk the find/grep tools use, so this module stays
// presentation-only and never touches the filesystem. Pi's own combined
// provider shells out to `fd`, which Kubic cannot assume is installed.
import type {
  AutocompleteItem,
  AutocompleteProvider,
  AutocompleteSuggestions,
} from './tui-boundary.js';

/** How many files one popup offers: large repos stay responsive. */
export const FILE_MENTION_MAX = 50;

const basename = (path: string): string =>
  path.slice(path.lastIndexOf('/') + 1);

function isSubsequence(query: string, text: string): boolean {
  let at = 0;
  for (const ch of text) {
    if (ch === query[at]) at += 1;
    if (at === query.length) return true;
  }
  return query.length === 0;
}

/**
 * The paths matching `query`, best first, at most FILE_MENTION_MAX. Case-
 * insensitive tiers: the path starts with the query, then the file name
 * does, then the path contains it, then a fuzzy (in-order) match; ties go
 * to the shorter path, then alphabetical.
 */
export function rankFileMentions(
  files: readonly string[],
  query: string,
): string[] {
  const q = query.toLowerCase();
  const scored: Array<{ path: string; tier: number }> = [];
  for (const path of files) {
    const lower = path.toLowerCase();
    const tier = lower.startsWith(q)
      ? 0
      : basename(lower).startsWith(q)
        ? 1
        : lower.includes(q)
          ? 2
          : isSubsequence(q, lower)
            ? 3
            : -1;
    if (tier >= 0) scored.push({ path, tier });
  }
  scored.sort(
    (a, b) =>
      a.tier - b.tier ||
      a.path.length - b.path.length ||
      a.path.localeCompare(b.path),
  );
  return scored.slice(0, FILE_MENTION_MAX).map((entry) => entry.path);
}

/** The mention text for a path: quoted when it contains whitespace. */
export function mentionFor(path: string): string {
  return /\s/.test(path) ? `@"${path}"` : `@${path}`;
}

/**
 * The `@` token ending at the cursor, or undefined. An `@` starts a mention
 * at the line start or after whitespace; `@"…` may contain spaces until its
 * closing quote, a bare `@…` ends at the first whitespace.
 */
function mentionToken(before: string): string | undefined {
  for (
    let at = before.lastIndexOf('@');
    at >= 0;
    at = before.lastIndexOf('@', at - 1)
  ) {
    if (at > 0 && !/\s/.test(before[at - 1] ?? '')) continue;
    const token = before.slice(at);
    if (token.startsWith('@"')) {
      return token.indexOf('"', 2) === -1 ? token : undefined;
    }
    return /\s/.test(token) ? undefined : token;
  }
  return undefined;
}

export class FileMentionAutocomplete implements AutocompleteProvider {
  readonly triggerCharacters = ['@'];
  private readonly listFiles: () => readonly string[];

  constructor(listFiles: () => readonly string[]) {
    this.listFiles = listFiles;
  }

  getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
  ): Promise<AutocompleteSuggestions | null> {
    const before = (lines[cursorLine] ?? '').slice(0, cursorCol);
    const token = mentionToken(before);
    if (token === undefined) return Promise.resolve(null);
    const query = token.startsWith('@"') ? token.slice(2) : token.slice(1);
    let files: readonly string[];
    try {
      files = this.listFiles();
    } catch {
      // A failed listing offers nothing; typing is never blocked.
      return Promise.resolve(null);
    }
    const matches = rankFileMentions(files, query);
    if (matches.length === 0) return Promise.resolve(null);
    return Promise.resolve({
      prefix: token,
      items: matches.map((path) => ({ value: mentionFor(path), label: path })),
    });
  }

  // The token before the cursor is replaced by the mention plus one space.
  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string,
  ): { lines: string[]; cursorLine: number; cursorCol: number } {
    const next = [...lines];
    const line = next[cursorLine] ?? '';
    const start = Math.max(0, cursorCol - prefix.length);
    const inserted = `${item.value} `;
    next[cursorLine] =
      `${line.slice(0, start)}${inserted}${line.slice(cursorCol)}`;
    return { lines: next, cursorLine, cursorCol: start + inserted.length };
  }
}

/**
 * One provider over several (the slash commands and the @-files share the
 * editor's single autocomplete slot): the first provider with suggestions
 * answers, and the completion goes back to the provider that offered it.
 */
export class CombinedAutocomplete implements AutocompleteProvider {
  readonly triggerCharacters: string[];
  private readonly providers: readonly AutocompleteProvider[];
  private last: AutocompleteProvider | undefined;

  constructor(providers: readonly AutocompleteProvider[]) {
    this.providers = providers;
    this.triggerCharacters = [
      ...new Set(providers.flatMap((p) => p.triggerCharacters ?? [])),
    ];
  }

  async getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: Parameters<AutocompleteProvider['getSuggestions']>[3],
  ): Promise<AutocompleteSuggestions | null> {
    for (const provider of this.providers) {
      const found = await provider.getSuggestions(
        lines,
        cursorLine,
        cursorCol,
        options,
      );
      if (found !== null) {
        this.last = provider;
        return found;
      }
    }
    this.last = undefined;
    return null;
  }

  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string,
  ): { lines: string[]; cursorLine: number; cursorCol: number } {
    const provider = this.last ?? this.providers[0];
    if (provider === undefined) return { lines, cursorLine, cursorCol };
    return provider.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
  }
}
