// Operation tool contract (issue #67, EPIC A/B mutation hardening).
// Pins every registered tool's name/description/replay triple exactly:
// Stryker StringLiteral mutants on descriptions (→ "") survive suites that
// only exercise behavior, so the contract itself is asserted here. Registry
// keys must equal operation names, and unknown tools fail with the exact
// `unknown_tool` shape — never a bare throw.
import { describe, expect, it } from 'vitest';
import { OPERATIONS } from './registry.js';

const EXPECTED: Record<string, { description: string; replay: string }> = {
  read: {
    description:
      'Read a text file. Returns the raw lines under a "[read <path>: lines a-b of N]" header. offset is 1-indexed (default 1); limit defaults to and is capped at 2000 lines; at most 8 MiB is scanned. When the header ends "more: offset=N", call again with that offset.',
    replay: 'safe',
  },
  ls: {
    description:
      'List one directory (not recursive): every entry with its kind and size. path defaults to the workspace root.',
    replay: 'safe',
  },
  find: {
    description:
      'Find files and directories recursively under root (default "."), filtered by nameContains (substring) and type ("file" or "dir"). Returns at most maxResults entries (default 100) and says when the list was cut.',
    replay: 'safe',
  },
  grep: {
    description:
      'Search file contents line by line with a JavaScript regex. Returns "path:line: text" lines under a header, at most maxMatches (default 100). include keeps only files whose path contains that substring (not a glob).',
    replay: 'safe',
  },
  write: {
    description:
      'Create or overwrite a file with its complete content, atomically (tmp + rename); returns before/after hashes. Use edit to change part of a file.',
    replay: 'never',
  },
  edit: {
    description:
      'Replace exact text in a file atomically (tmp + rename). oldText must match byte for byte, whitespace included, and occur exactly expectCount times (default 1) or the edit is refused (no_match / ambiguous_match). Files over 8 MiB are refused.',
    replay: 'never',
  },
  bash: {
    description:
      'Run a shell command in the workspace root (bash, else sh). Returns the exit code and the raw stdout/stderr under a header; each stream keeps its last 64 KiB. timeout is in seconds.',
    replay: 'never',
  },
  git_status: {
    description:
      'Structured working-tree status (branch, ahead/behind, staged/unstaged/untracked)',
    replay: 'safe',
  },
  git_diff: {
    description: 'Scoped diff of staged changes, a revision range, or a path',
    replay: 'safe',
  },
  git_log: {
    description:
      'Recent commits (sha, author, date, message), optionally only those touching path; max defaults to 20 and is capped at 100',
    replay: 'safe',
  },
  git_show: {
    description: 'Patch (diff) of a commit or other ref',
    replay: 'safe',
  },
  git_stage: {
    description:
      'Stage explicit paths (never -A: the agent stages what it means)',
    replay: 'never',
  },
  git_commit: {
    description:
      'Commit staged changes; returns sha + file list (trajectory records commits from this result in EPIC F)',
    replay: 'never',
  },
  git_branch: {
    description:
      'List branches, or create one (checkout is out of scope: solo works on the current branch)',
    replay: 'never',
  },
  git_checkpoint: {
    description:
      'Create a restorable stash point WITHOUT touching the tree (git stash create); restore with git stash apply <sha>',
    replay: 'never',
  },
};

describe('operation tool contract (issue #67)', () => {
  it('registers exactly the fifteen solo tools', () => {
    expect(Object.keys(OPERATIONS).sort()).toEqual(
      Object.keys(EXPECTED).sort(),
    );
  });

  it('pins each tool name, description, and replay policy exactly', () => {
    for (const [key, op] of Object.entries(OPERATIONS)) {
      const expected = EXPECTED[key];
      expect(expected, `contract entry for ${key}`).toBeDefined();
      expect(op.name).toBe(key);
      expect(op.description).toBe(expected?.description);
      expect(op.replay).toBe(expected?.replay);
    }
  });

  it('never-replay tools are exactly the effect tools', () => {
    const never = Object.entries(OPERATIONS)
      .filter(([, op]) => op.replay === 'never')
      .map(([key]) => key)
      .sort();
    expect(never).toEqual(
      [
        'bash',
        'edit',
        'git_branch',
        'git_checkpoint',
        'git_commit',
        'git_stage',
        'write',
      ].sort(),
    );
  });
});
