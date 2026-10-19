// Operation tool contract.
// Pins every registered tool's name/description/replay triple exactly: suites
// that only exercise behaviour would not notice an emptied description, so the
// contract itself is asserted here. Registry keys must equal operation names,
// and unknown tools fail with the exact `unknown_tool` shape — never a bare
// throw.
import { describe, expect, it } from 'vitest';
import { BASH_RESULT_MAX_CHARS, BASH_RESULT_MAX_LINES } from './bash.js';
import { OPERATIONS } from './registry.js';

// The git read ops clip to the shared model cap; the pin is
// built from the same constants as the descriptions so the bound cannot
// drift from the contract.
const GIT_CLIP = `Output clips to the shared model cap (last ${BASH_RESULT_MAX_LINES} lines, at most ${BASH_RESULT_MAX_CHARS} chars, tail-kept; truncated reports the cut and the full text is spilled when the lane provides a sink)`;

const EXPECTED: Record<string, { description: string; replay: string }> = {
  read: {
    description:
      'Read a text file. Returns the raw lines under a "[read <path>: lines a-b of N]" header. offset is 1-indexed (default 1); limit defaults to and is capped at 2000 lines; at most 8 MiB is scanned and at most 51200 bytes are returned (long output arrives clipped, with a notice). Binary files are refused. When the header ends "more: offset=N", call again with that offset.',
    replay: 'safe',
  },
  ls: {
    description:
      'List one directory (not recursive): every entry with its kind and size, sorted by name, at most 500 entries (`truncated` says when more exist). path defaults to the workspace root.',
    replay: 'safe',
  },
  find: {
    description:
      'Find files and directories recursively under root (default "."), filtered by nameContains (substring) and type ("file" or "dir"). Returns at most maxResults entries (default 100) and says when the list was cut. The walk skips .git, node_modules and paths a .gitignore excludes, and never follows or lists symlinks; it visits at most 10000 entries and 100 directory levels, and the result\'s notice names the cap that stopped it.',
    replay: 'safe',
  },
  grep: {
    description:
      'Search file contents line by line with a JavaScript regex. Returns "path:line: text" lines under a header, at most maxMatches (default 100); matching lines are clipped at 500 characters (the header says so when they are). include keeps only files whose path contains that substring (not a glob). Binary files (a NUL byte) are skipped and counted; files over 8388608 bytes are skipped and counted, and the result is then truncated. The search skips .git, node_modules and paths a .gitignore excludes, and never follows symlinks; it walks at most 10000 entries and 100 directory levels, and when a cap stops it the header names which one.',
    replay: 'safe',
  },
  write: {
    description:
      'Create or overwrite a file with its complete content, atomically (tmp + rename); returns before/after hashes. Use edit to change part of a file.',
    replay: 'never',
  },
  edit: {
    description:
      'Replace exact text in a file atomically (tmp + rename). oldText must match exactly (after line-ending/BOM normalization), whitespace included, and occur exactly expectCount times (default 1) or the edit is refused (no_match / ambiguous_match). Matching is done on LF-normalized text with any leading BOM stripped; every line the edit does not touch keeps its own line ending, the replacement takes the ending of the lines it replaces (a CRLF file stays CRLF), and the BOM is kept. Files over 8 MiB are refused.',
    replay: 'never',
  },
  bash: {
    description:
      'Run a shell command in the workspace root (bash, else sh). Returns the exit code and the raw stdout/stderr under a header; each stream keeps its last 64 KiB. timeout is in seconds (default 120, at most 600, unless the operator overrides them with KUBIC_BASH_TIMEOUT / KUBIC_BASH_MAX_TIMEOUT in kubic run or kubic tui); a command that runs past it is killed and the header says "timed out". Jobs the command backgrounds are killed when it ends unless the operator sets KUBIC_BASH_KEEP_BACKGROUND=1 (the output says which happened), so do not rely on a server started with & outliving the call.',
    replay: 'never',
  },
  git_status: {
    description:
      'Structured working-tree status (branch or detached HEAD, ahead/behind, staged/unstaged/untracked, conflicts, renames)',
    replay: 'safe',
  },
  git_diff: {
    description: `Scoped diff of staged changes, a revision range, or a path. ${GIT_CLIP}`,
    replay: 'safe',
  },
  git_log: {
    description: `Recent commits (sha, author, date, message), optionally only those touching path; max defaults to 20 and is capped at 100. ${GIT_CLIP}`,
    replay: 'safe',
  },
  git_show: {
    description: `Patch (diff) of a commit or other ref. ${GIT_CLIP}`,
    replay: 'safe',
  },
  git_stage: {
    description:
      'Stage explicit paths (never -A: the agent stages what it means)',
    replay: 'never',
  },
  git_commit: {
    description:
      'Commit staged changes; returns sha + file list (trajectory records commits from this result)',
    replay: 'never',
  },
  git_branch: {
    description:
      'List branches, or create one (checkout is out of scope: Kubic works on the current branch)',
    replay: 'never',
  },
  git_checkpoint: {
    description:
      'Create a restorable stash point WITHOUT touching the tree (git stash create); restore with git stash apply <sha>',
    replay: 'never',
  },
  git_merge: {
    description:
      'Merge a local branch into the current one (local refs only, never fetches); on conflict returns the conflicted paths and leaves the merge state for the resolver',
    replay: 'never',
  },
  git_conflict_status: {
    description: 'List paths with unresolved merge conflicts',
    replay: 'safe',
  },
  git_worktree_list: {
    description: 'List attached worktrees (path, branch, HEAD)',
    replay: 'safe',
  },
};

describe('operation tool contract', () => {
  it('registers exactly the eighteen tools', () => {
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
        'git_merge',
        'git_stage',
        'write',
      ].sort(),
    );
  });
});
