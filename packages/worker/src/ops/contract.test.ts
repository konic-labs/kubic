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
    description: 'Read file contents with line offset/limit',
    replay: 'safe',
  },
  ls: {
    description: 'List directory entries with kinds and sizes',
    replay: 'safe',
  },
  find: {
    description: 'Find files and directories recursively with filters',
    replay: 'safe',
  },
  grep: {
    description: 'Search file contents for a regex with line numbers',
    replay: 'safe',
  },
  write: {
    description: 'Write a file atomically (tmp + rename) with hashes',
    replay: 'never',
  },
  edit: {
    description: 'Replace exact text matches atomically (tmp + rename)',
    replay: 'never',
  },
  bash: {
    description: 'Execute a shell command with streaming, timeout, and abort',
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
      'Recent commits (sha, author, date, message), optionally for a path',
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
