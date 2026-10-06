// Runtime-state exclude rules (issue #91; design §35, D34/D35).
//
// The split: `.kubic/config.toml` and `.kubic/roles/*.md` are committed —
// `.kubic/{sessions,journal,artifacts,wt,orchestrator}/` is runtime state
// and must never reach the commit path. This module ships the runtime
// half into the repository's LOCAL, uncommitted exclude file
// (`.git/info/exclude`), so:
//
//   * the first `kubic run` / `kubic orchestrate` in a user repo leaves no
//     untracked `.kubic/` state behind (`git status --porcelain` stays
//     clean),
//   * a user's committed `.gitignore` is never dirtied by the tool, and
//   * `.kubic/` itself stays unignored, so `config.toml` + `roles/*.md`
//     remain committable (mixed directory, by construction).
//
// Placement is forced by §9: only packages/exec may spawn processes or
// touch node:fs. This module is deliberately self-contained (node:
// builtins only, no relative imports) so the plain `node --test` gate
// (`scripts/runtime-exclude.test.mjs`, no build step) can drive the real
// mechanism without `.js`-specifier resolution, and so @kubic/host can
// derive its required-entry list from the same source of truth.
//
// Fail-open: any git/fs failure degrades to a skip. Writing ignore rules
// serves the user's commit path; it must never fail a run.

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// The runtime subpaths under `.kubic/`, in the shipped order. Single
// source of truth: `@kubic/host` `config/config.ts` derives
// `GITIGNORE_REQUIRED_ENTRIES` from this list, and the docs quote it.
export const RUNTIME_EXCLUDE_ENTRIES = [
  '.kubic/sessions/',
  '.kubic/journal/',
  '.kubic/artifacts/',
  '.kubic/wt/',
  '.kubic/orchestrator/',
] as const;

// Managed-block markers. A later run replaces the block in place instead
// of appending a duplicate, so repeated runs are idempotent and a rule
// set that grows (this issue added `.kubic/orchestrator/`) re-syncs.
export const RUNTIME_EXCLUDE_BEGIN =
  '# kubic runtime state (issue #91) — local, never committed';
export const RUNTIME_EXCLUDE_END = '# end kubic runtime state (issue #91)';

export interface RuntimeExcludeText {
  text: string;
  changed: boolean;
}

export class RuntimeExcludeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeExcludeError';
  }
}

// The characters that can never appear in an exclude entry (issue #133
// review): C0 controls + DEL, C1 controls, and the bidi overrides — the same
// set `sanitizeReasonField` (@kubic/host) strips from operator-facing
// fields, kept here because this module owns what may become a gitignore
// line. An entry is written one line at a time, so a newline would inject
// arbitrary patterns into `.git/info/exclude`; an ESC or bidi override would
// reach whatever reads the file. The config load refuses such a value at the
// door; render time refuses it again. Never stripped on the write path: a
// hostile entry must not be silently repaired into a different rule.
const UNSAFE_CHARACTERS =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally matching controls.
  /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;
const UNSAFE_CHARACTERS_ALL =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally stripping controls.
  /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;

export function hasUnsafeCharacters(value: string): boolean {
  return UNSAFE_CHARACTERS.test(value);
}

// The gitignore metacharacters that may never appear in an exclude entry
// (issue #133 re-review): an entry is written verbatim as one gitignore
// pattern, and these make the line mean something other than the literal
// path it names — `*`/`?`/`[`/`]` match other paths (hiding files from
// `git add -A` and the pre-merge clean-tree guard), a leading `#` turns
// the line into a comment, and a backslash escapes the following character
// (a trailing one leaves an entry that matches nothing at all). The config
// load refuses such a value at the door; render time refuses it again.
// Never escaped on the write path: a hostile entry must not be silently
// repaired into a different rule.
const GITIGNORE_METACHARACTERS = /[*?[\]\\]/;

export function hasGitignoreMetacharacters(value: string): boolean {
  return value.startsWith('#') || GITIGNORE_METACHARACTERS.test(value);
}

// Display-only: strips the same set for a message that quotes a value back
// (the scheduler's deny reasons). NEVER applied to a value that is written.
export function stripUnsafeCharacters(value: string): string {
  return value.replace(UNSAFE_CHARACTERS_ALL, '');
}

function renderBlock(entries: readonly string[]): string {
  // Defense in depth (issue #133 review): no entry carrying control
  // characters may ever be rendered — refused by name, never echoed.
  for (const entry of entries) {
    if (hasUnsafeCharacters(entry)) {
      throw new RuntimeExcludeError(
        'refusing to write an exclude entry with control characters: the entry would inject gitignore lines into .git/info/exclude',
      );
    }
    // Same rule for the gitignore metacharacters (issue #133 re-review):
    // `*`/`?`/`[`/`]`, a leading `#` or a backslash would make the entry
    // act as a different rule than the literal path it names.
    if (hasGitignoreMetacharacters(entry)) {
      throw new RuntimeExcludeError(
        'refusing to write an exclude entry with gitignore metacharacters: the entry would match a different set of paths than the one it names',
      );
    }
  }
  return `${[RUNTIME_EXCLUDE_BEGIN, ...entries, RUNTIME_EXCLUDE_END].join('\n')}\n`;
}

// Pure text transform over an exclude/gitignore file: splices the managed
// block in place when the markers are present, appends it otherwise.
// Unrelated entries above and below the block survive. An opening marker
// with no closing marker is treated as a truncated block — ours to repair,
// so it is re-rendered through the end of the file.
export function applyRuntimeExcludeBlock(
  existing: string,
  entries: readonly string[] = RUNTIME_EXCLUDE_ENTRIES,
): RuntimeExcludeText {
  const block = renderBlock(entries);
  const beginAt = existing.indexOf(RUNTIME_EXCLUDE_BEGIN);
  let text: string;
  if (beginAt === -1) {
    const separator =
      existing === '' || existing.endsWith('\n\n') ? existing : `${existing}\n`;
    text = `${separator}${block}`;
  } else {
    const closeAt = existing.indexOf(RUNTIME_EXCLUDE_END, beginAt);
    const stop = closeAt === -1 ? -1 : existing.indexOf('\n', closeAt);
    const lineStop = stop === -1 ? existing.length : stop + 1;
    const tail = existing.slice(lineStop);
    text = `${existing.slice(0, beginAt)}${block}${tail}`;
  }
  return { text, changed: text !== existing };
}

export interface RuntimeExcludeOutcome {
  // Absolute path of the exclude file that now carries the rules.
  path?: string;
  changed: boolean;
  // Present when nothing was written: no work tree, or git/fs refused.
  skipped?: 'not-a-git-repo' | 'unavailable';
  detail?: string;
}

// The sync git probe the writer and the ignore-split checker share
// (issue #292): `rev-parse` runs no hooks, and a missing git binary
// reports `{ code: 1 }` instead of throwing. Exported for the doctor's
// checker (host) and the CLI config load (apps/kubic) — both stay
// process-free behind this seam per the §9 I/O confinement rule.
export function gitSync(
  cwd: string,
  args: readonly string[],
): { code: number; out: string } {
  try {
    const result = spawnSync('git', [...args], { cwd, encoding: 'utf8' });
    return { code: result.status ?? 1, out: (result.stdout ?? '').trim() };
  } catch (error) {
    return { code: 1, out: error instanceof Error ? error.message : '' };
  }
}

function git(cwd: string, args: string[]): { code: number; out: string } {
  return gitSync(cwd, args);
}

// Idempotent entry point: makes sure the runtime rules are in the
// repository's local exclude file, writing only when the content would
// change. One file per repository, so a linked worktree (orchestrate's
// agent checkout) resolves to the same file the main checkout uses.
export function ensureRuntimeExcludeRules(
  options: { cwd?: string; entries?: readonly string[] } = {},
): RuntimeExcludeOutcome {
  const cwd = options.cwd ?? process.cwd();
  const entries = options.entries ?? RUNTIME_EXCLUDE_ENTRIES;
  const top = git(cwd, ['rev-parse', '--show-toplevel']);
  if (top.code !== 0 || top.out === '') {
    return { changed: false, skipped: 'not-a-git-repo' };
  }
  const probe = git(cwd, ['rev-parse', '--git-path', 'info/exclude']);
  if (probe.code !== 0 || probe.out === '') {
    return {
      changed: false,
      skipped: 'unavailable',
      detail: 'git rev-parse --git-path info/exclude failed',
    };
  }
  const path = resolve(cwd, probe.out);
  try {
    let existing = '';
    try {
      existing = readFileSync(path, 'utf8');
    } catch {
      // No exclude file yet: writing it fresh is the intended path.
    }
    const { text, changed } = applyRuntimeExcludeBlock(existing, entries);
    if (changed) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
    }
    return { path, changed };
  } catch (error) {
    return {
      changed: false,
      skipped: 'unavailable',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
