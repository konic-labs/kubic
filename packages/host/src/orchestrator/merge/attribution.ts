// Journal attribution for merged hunks (issue #46; §42, §17
// read-only). Post-merge hunks keep their settling agent so
// `kubic diff --agent <id>` attributes exactly what each worker wrote.
// Pure — the journal store itself is owned by exec/journal (#17).

export interface MergedHunk {
  path: string;
  hunk: string;
}

export type AttributedHunk = MergedHunk & { agent: string };

// Issue #213 (L-D33): diffArgsForAgent/filterEntriesByAgent (+ the
// JournalEntryRef they alone used) are deleted — test-only helpers with
// no prod path. Live attribution is attributeMergedHunks, called from
// orchestrate-cli.
export function attributeMergedHunks(
  hunks: readonly MergedHunk[],
  agentId: string,
): AttributedHunk[] {
  return hunks.map((hunk) => ({ ...hunk, agent: agentId }));
}
