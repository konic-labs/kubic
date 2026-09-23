// (3) compaction + artifact reuse (issue #56): RED first.
import { describe, expect, it } from 'vitest';
import { decideCompactReuse } from './compact-reuse.js';

describe('compaction + artifact reuse (issue #56)', () => {
  it('reuses a fresh artifact instead of respawning work', () => {
    const decision = decideCompactReuse({
      compactionDue: false,
      artifactAvailable: true,
      artifactFresh: true,
    });
    expect(decision.reuseArtifact).toBe(true);
    expect(decision.respawn).toBe(false);
  });

  it('compacts when due even when an artifact exists', () => {
    const decision = decideCompactReuse({
      compactionDue: true,
      artifactAvailable: true,
      artifactFresh: true,
    });
    expect(decision.compact).toBe(true);
    expect(decision.reuseArtifact).toBe(true);
  });

  it('respawns only when no fresh artifact exists and nothing compacts', () => {
    const decision = decideCompactReuse({
      compactionDue: false,
      artifactAvailable: false,
      artifactFresh: false,
    });
    expect(decision.respawn).toBe(true);
  });

  it('never reuses a stale artifact', () => {
    const decision = decideCompactReuse({
      compactionDue: false,
      artifactAvailable: true,
      artifactFresh: false,
    });
    expect(decision.reuseArtifact).toBe(false);
  });
});
