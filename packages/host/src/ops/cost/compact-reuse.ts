// (3) compaction + artifact reuse (issue #56; §62 lever 3).
// Before respawning work, reuse a fresh artifact; compact when the
// compaction policy says due. Reads the compaction trigger (§27) and the
// artifact refs (§25) conceptually — both consumed read-only through the
// caller-supplied booleans, never reimplemented here. Pure, faux-only.

export interface CompactReuseInput {
  compactionDue: boolean;
  artifactAvailable: boolean;
  artifactFresh: boolean;
}

export interface CompactReuseDecision {
  compact: boolean;
  reuseArtifact: boolean;
  respawn: boolean;
  reason: string;
}

export function decideCompactReuse(
  input: CompactReuseInput,
): CompactReuseDecision {
  const reusable = input.artifactAvailable && input.artifactFresh;
  if (input.compactionDue) {
    return {
      compact: true,
      reuseArtifact: reusable,
      respawn: !reusable,
      reason: reusable
        ? 'compaction due: compact, then reuse the fresh artifact'
        : 'compaction due with no fresh artifact: compact, then respawn',
    };
  }
  if (reusable) {
    return {
      compact: false,
      reuseArtifact: true,
      respawn: false,
      reason: 'fresh artifact available: reuse instead of respawning work',
    };
  }
  return {
    compact: false,
    reuseArtifact: false,
    respawn: true,
    reason: input.artifactAvailable
      ? 'artifact stale: respawn from refs, never from stale contents'
      : 'no artifact: respawn bounded work',
  };
}
