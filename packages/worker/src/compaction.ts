// Kubic compaction policy on the Pi mechanism (issue #34; §27.1-27.6).
//
// Pi owns the mechanism (checkpoints, /compact + /tree commands,
// summarization runs, output bounds, spill files in artifacts). This
// module is Kubic's policy layer: the trigger formula, where checks
// fire, the structured summary shape with cumulative file ops, branch
// summary entries, and spill-path wiring.
//
// Pure: no Pi imports (not even via pi-boundary — policy only), no
// network, no filesystem. No Kubic-side truncation scheme exists here
// by design: Pi output bounds + spill files are the only truncation
// path, and long content passes through byte-identical.

export const DEFAULT_RESERVE_TOKENS = 16384;

export interface CompactionThreshold {
  contextTokens: number;
  contextWindow: number;
  reserveTokens?: number;
}

// A reserve may take at most this share of the window. Without the clamp a
// window at or below the reserve (an 8192-token local model vs the 16384
// default) puts the threshold at or below zero and every turn compacts.
// Pi has no equivalent clamp; this is Kubic policy.
export const MAX_RESERVE_FRACTION = 0.25;

export function effectiveReserveTokens(
  contextWindow: number,
  reserveTokens: number = DEFAULT_RESERVE_TOKENS,
): number {
  if (!(contextWindow > 0)) return reserveTokens;
  return Math.min(
    reserveTokens,
    Math.floor(contextWindow * MAX_RESERVE_FRACTION),
  );
}

export function compactionThreshold(
  contextWindow: number,
  reserveTokens: number = DEFAULT_RESERVE_TOKENS,
): number {
  return contextWindow - effectiveReserveTokens(contextWindow, reserveTokens);
}

// Trigger: contextTokens STRICTLY above contextWindow - reserve (clamped).
// Boundary: equality does not fire.
export function shouldCompact(input: CompactionThreshold): boolean {
  return (
    input.contextTokens >
    compactionThreshold(input.contextWindow, input.reserveTokens)
  );
}

export const COMPACTION_CHECKPOINTS = [
  'post-tools',
  'pre-prompt',
  'post-low-run',
] as const;

export type CompactionCheckpoint = (typeof COMPACTION_CHECKPOINTS)[number];

export interface CheckpointContext {
  batchTerminal: boolean;
}

// Pi checkpoints: post-tools, pre-prompt, post-low-run fire on
// interactive lanes; batch-terminal lanes skip every checkpoint.
export function shouldCheckAt(
  point: CompactionCheckpoint,
  ctx: CheckpointContext,
): boolean {
  void point;
  return ctx.batchTerminal === false;
}

export function parseCompactCommand(input: string): string {
  const trimmed = input.trim();
  if (trimmed === '/compact') return '';
  if (trimmed.startsWith('/compact ')) return trimmed.slice('/compact '.length);
  throw new CompactionError(`not a /compact command: '${input}'`);
}

export class CompactionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompactionError';
  }
}

export interface CompactPromptInput {
  focus?: string;
  extraSections?: string[];
}

// /compact [instructions]: caller focus instructions ride verbatim in
// the summary prompt; empty focus builds the instruction-free prompt.
export function buildCompactPrompt(input: CompactPromptInput): string {
  const sections = [
    'Summarize this session for compaction: goal, decisions, open work, cumulative file ops, spill refs.',
    'Prefer compact state + artifacts + refs over history.',
  ];
  const focus = (input.focus ?? '').trim();
  if (focus.length > 0) sections.push(`focus: ${focus}`);
  sections.push(...(input.extraSections ?? []));
  return sections.join('\n');
}

export interface BranchSummaryEntry {
  type: 'branch_summary';
  branch: string;
  summary: string;
  at: number;
}

// /tree branch_summary entries with switch-back restore: the store
// keeps per-branch compacted state; switching away snapshots the live
// state and switching back restores it.
export class BranchSummaryStore {
  private states = new Map<string, string>();
  private summaries = new Map<string, BranchSummaryEntry>();
  private live: string;

  constructor(initialBranch: string, initialState: string) {
    this.states.set(initialBranch, initialState);
    this.live = initialBranch;
  }

  writeBranchSummary(entry: Omit<BranchSummaryEntry, 'type' | 'at'>): void {
    this.summaries.set(entry.branch, {
      type: 'branch_summary',
      branch: entry.branch,
      summary: entry.summary,
      at: Date.now(),
    });
  }

  readBranchSummary(branch: string): BranchSummaryEntry | undefined {
    return this.summaries.get(branch);
  }

  switchBranch(to: string, state?: string): void {
    this.states.set(this.live, this.currentState());
    if (state !== undefined) this.states.set(to, state);
    this.live = to;
  }

  current(): string {
    return this.live;
  }

  currentState(): string {
    return this.states.get(this.live) ?? '';
  }
}

export type FileOpKind = 'created' | 'modified' | 'deleted' | 'renamed';

export interface FileOp {
  kind: FileOpKind;
  path: string;
}

export interface CumulativeFileOps {
  created: string[];
  modified: string[];
  deleted: string[];
  renamed: string[];
}

export function emptyFileOps(): CumulativeFileOps {
  return { created: [], modified: [], deleted: [], renamed: [] };
}

function pushUnique(into: string[], path: string): void {
  if (into.includes(path) === false) into.push(path);
}

// Cumulative across the session: repeat ops on one path collapse to a
// single structural entry per bucket.
export function accumulateFileOps(
  base: CumulativeFileOps,
  ops: FileOp[],
): CumulativeFileOps {
  const next: CumulativeFileOps = {
    created: [...base.created],
    modified: [...base.modified],
    deleted: [...base.deleted],
    renamed: [...base.renamed],
  };
  for (const op of ops) pushUnique(next[op.kind], op.path);
  return next;
}

export interface StructuredSummary {
  goal: string;
  decisions: string[];
  openWork: string[];
  fileOps: CumulativeFileOps;
  spillRefs: string[];
}

export function formatStructuredSummary(summary: StructuredSummary): string {
  const lines = [
    `goal: ${summary.goal}`,
    `decisions: ${summary.decisions.join('; ')}`,
    `open work: ${summary.openWork.join('; ')}`,
    'file ops:',
    `  created: ${summary.fileOps.created.join(', ')}`,
    `  modified: ${summary.fileOps.modified.join(', ')}`,
    `  deleted: ${summary.fileOps.deleted.join(', ')}`,
    `  renamed: ${summary.fileOps.renamed.join(', ')}`,
    `spill refs: ${summary.spillRefs.join(', ')}`,
  ];
  return lines.join('\n');
}

export interface TruncatedToolOutput {
  truncated: boolean;
  preview: string;
  spillPath: string;
}

export interface SpillArtifact {
  kind: 'spill';
  path: string;
}

// Truncated bash resolves via its spill path: the preview stays in
// context, the full output is referenced — never re-truncated.
export function resolveTruncatedOutput(output: TruncatedToolOutput): string {
  return output.spillPath;
}

export function buildSpillArtifact(spillPath: string): SpillArtifact {
  return { kind: 'spill', path: spillPath };
}

// No Kubic-side truncation scheme: Pi output bounds are respected as
// given and long content passes through byte-identical. Kubic never
// slices, ellipsizes, or re-budgets tool output.
export function passThroughOutput(output: string): string {
  return output;
}

export interface CompactedState {
  summary: StructuredSummary;
  artifacts: SpillArtifact[];
}

// Compact state + artifacts + refs over history: the compacted state
// carries the structured summary and spill artifact refs only.
export function buildCompactedState(
  summary: StructuredSummary,
  artifacts: SpillArtifact[],
): CompactedState {
  return { summary, artifacts };
}
