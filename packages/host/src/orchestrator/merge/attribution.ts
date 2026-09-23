// Journal attribution for merged hunks (issue #46; §42, §17
// read-only). Post-merge hunks keep their settling agent so
// `kubic diff --agent <id>` attributes exactly what each worker wrote.
// Pure — the journal store itself is owned by exec/journal (#17).

export interface JournalEntryRef {
  path: string;
  agent: string;
  hunk: string;
}

export interface MergedHunk {
  path: string;
  hunk: string;
}

export type AttributedHunk = MergedHunk & { agent: string };

export function diffArgsForAgent(agentId: string): string[] {
  return ['diff', '--agent', agentId];
}

export function filterEntriesByAgent(
  entries: readonly JournalEntryRef[],
  agentId: string,
): JournalEntryRef[] {
  return entries
    .filter((entry) => entry.agent === agentId)
    .map((entry) => ({ ...entry }));
}

export function attributeMergedHunks(
  hunks: readonly MergedHunk[],
  agentId: string,
): AttributedHunk[] {
  return hunks.map((hunk) => ({ ...hunk, agent: agentId }));
}
