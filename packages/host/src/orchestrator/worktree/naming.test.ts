// Worktree naming + errors (issue #45, slice 1; §44).
// RED first: kubic/<agent> branch naming, .kubic/wt/<agent> paths,
// and the shared WorktreeError (exit 5 non-git refusal mentions solo).
import { describe, expect, it } from 'vitest';
import {
  notARepoError,
  WORKTREE_EXIT_NOT_A_REPO,
  WorktreeError,
} from './errors.js';
import {
  branchForAgent,
  parseBranchAgent,
  pathForAgent,
  validateAgentId,
} from './naming.js';

describe('worktree naming (issue #45)', () => {
  it('maps an agent to the kubic/<agent> branch', () => {
    expect(branchForAgent('agent-1')).toBe('kubic/agent-1');
  });

  it('maps an agent to <root>/.kubic/wt/<agent>', () => {
    expect(pathForAgent('/repo', 'agent-1')).toBe('/repo/.kubic/wt/agent-1');
  });

  it('rejects invalid agent ids', () => {
    expect(validateAgentId('')).not.toEqual([]);
    expect(validateAgentId('../evil')).not.toEqual([]);
    expect(validateAgentId('kubic/x')).not.toEqual([]);
    expect(() => branchForAgent('../evil')).toThrow(/agent/);
    expect(() => pathForAgent('/repo', '')).toThrow(/agent/);
  });

  it('rejects a non-absolute repo root', () => {
    expect(() => pathForAgent('relative/root', 'agent-1')).toThrow(/absolute/);
  });

  it('round-trips the branch back to the agent', () => {
    expect(parseBranchAgent('kubic/agent-1')).toBe('agent-1');
    expect(parseBranchAgent('main')).toBe(null);
    expect(parseBranchAgent('kubic/')).toBe(null);
  });
});

describe('worktree naming: configured root (issue #133)', () => {
  it('derives the path under the configured worktree root', () => {
    expect(pathForAgent('/repo', 'agent-1', '.kubic-custom/wt')).toBe(
      '/repo/.kubic-custom/wt/agent-1',
    );
  });

  it('keeps the documented default when no root is configured', () => {
    expect(pathForAgent('/repo', 'agent-1')).toBe('/repo/.kubic/wt/agent-1');
    expect(pathForAgent('/repo', 'agent-1', '.kubic/wt')).toBe(
      '/repo/.kubic/wt/agent-1',
    );
  });

  it('refuses a root that escapes the repository', () => {
    // Defense in depth: the config load validates too, but the path
    // builder is what a direct caller reaches — it never joins an escape.
    expect(() => pathForAgent('/repo', 'agent-1', '../escape')).toThrow(/root/);
    expect(() => pathForAgent('/repo', 'agent-1', 'a/../../b')).toThrow(/root/);
    expect(() => pathForAgent('/repo', 'agent-1', '/abs/wt')).toThrow(/root/);
    expect(() => pathForAgent('/repo', 'agent-1', '')).toThrow(/root/);
  });
});

describe('worktree errors (issue #45)', () => {
  it('refuses non-git spawn with exit 5 pointing at solo', () => {
    expect(WORKTREE_EXIT_NOT_A_REPO).toBe(5);
    const error = notARepoError('/tmp/plain-dir');
    expect(error).toBeInstanceOf(WorktreeError);
    expect(error.exitCode).toBe(5);
    expect(error.code).toBe('not_a_repo');
    expect(error.message).toMatch(/solo/);
  });
});
