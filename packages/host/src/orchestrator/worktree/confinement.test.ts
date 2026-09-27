// Worktree confinement: outside writes need approval (issue #45, slice 4).
// RED first: writes inside the worktree pass, writes outside raise
// the `outside-write` approval (§41.1) instead of proceeding silently.
import { describe, expect, it } from 'vitest';
import {
  isOutsideWorktree,
  isSpawnedWorktreePath,
  isSpawnedWorktreeShape,
  OUTSIDE_WRITE_CAPABILITY,
  requireInsideWorktree,
  spawnedRootFor,
} from './confinement.js';
import { WorktreeError } from './errors.js';

describe('worktree confinement (issue #45)', () => {
  it('allows writes inside the worktree', () => {
    expect(
      isOutsideWorktree(
        '/repo/.kubic/wt/agent-1',
        '/repo/.kubic/wt/agent-1/a.txt',
      ),
    ).toBe(false);
    expect(() =>
      requireInsideWorktree(
        '/repo/.kubic/wt/agent-1',
        '/repo/.kubic/wt/agent-1/a.txt',
      ),
    ).not.toThrow();
  });

  it('raises outside-write approval for escapes', () => {
    expect(isOutsideWorktree('/repo/.kubic/wt/agent-1', '/etc/cron.d/x')).toBe(
      true,
    );
    expect(
      isOutsideWorktree('/repo/.kubic/wt/agent-1', '/repo/other.txt'),
    ).toBe(true);
    expect(
      isOutsideWorktree(
        '/repo/.kubic/wt/agent-1',
        '/repo/.kubic/wt/agent-1/../agent-2/x',
      ),
    ).toBe(true);
    try {
      requireInsideWorktree('/repo/.kubic/wt/agent-1', '/etc/cron.d/x');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(WorktreeError);
      expect((error as WorktreeError).approval).toBe(OUTSIDE_WRITE_CAPABILITY);
      expect((error as WorktreeError).approval).toBe('outside-write');
    }
  });

  it('defeats direct .. traversal above the worktree', () => {
    expect(isOutsideWorktree('/repo/.kubic/wt/agent-1', '../agent-2/x')).toBe(
      true,
    );
    expect(
      isOutsideWorktree(
        '/repo/.kubic/wt/agent-1',
        '/repo/.kubic/wt/agent-1/../../etc/passwd',
      ),
    ).toBe(true);
    expect(
      isOutsideWorktree('/repo/.kubic/wt/agent-1', '/repo/.kubic/wt/agent-1'),
    ).toBe(false);
  });

  it('anchors the spawned set to the repo root', () => {
    expect(isSpawnedWorktreePath('/repo', '/repo/.kubic/wt/agent-1')).toBe(
      true,
    );
    expect(isSpawnedWorktreePath('/repo', '/other/.kubic/wt/agent-9')).toBe(
      false,
    );
    expect(isSpawnedWorktreePath('/repo', '/repo/.kubic/wt/../escape')).toBe(
      false,
    );
    expect(isSpawnedWorktreeShape('/repo/.kubic/wt/agent-1')).toBe(true);
    expect(isSpawnedWorktreeShape('/repo/.kubic/wt/../escape')).toBe(false);
    expect(spawnedRootFor('/repo')).toBe('/repo/.kubic/wt');
  });

  it('follows the configured worktree root (issue #133)', () => {
    expect(spawnedRootFor('/repo', '.kubic-custom/wt')).toBe(
      '/repo/.kubic-custom/wt',
    );
    expect(
      isSpawnedWorktreePath(
        '/repo',
        '/repo/.kubic-custom/wt/agent-1',
        '.kubic-custom/wt',
      ),
    ).toBe(true);
    // The configured set is the only one: a default-root worktree is
    // foreign to a repo that configured a custom root (and vice versa).
    expect(
      isSpawnedWorktreePath(
        '/repo',
        '/repo/.kubic/wt/agent-1',
        '.kubic-custom/wt',
      ),
    ).toBe(false);
    expect(
      isSpawnedWorktreePath(
        '/repo',
        '/repo/.kubic-custom/wt/../escape',
        '.kubic-custom/wt',
      ),
    ).toBe(false);
    expect(
      isSpawnedWorktreeShape(
        '/repo/.kubic-custom/wt/agent-1',
        '.kubic-custom/wt',
      ),
    ).toBe(true);
    // The root itself is not a spawned worktree — a segment must follow.
    expect(
      isSpawnedWorktreeShape('/repo/.kubic-custom/wt', '.kubic-custom/wt'),
    ).toBe(false);
    expect(
      isSpawnedWorktreeShape(
        '/repo/.kubic-custom/wt/../escape/x',
        '.kubic-custom/wt',
      ),
    ).toBe(false);
    // The default shape check still requires the .kubic/wt pair.
    expect(isSpawnedWorktreeShape('/repo/.kubic-custom/wt/agent-1')).toBe(
      false,
    );
  });
});
