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
