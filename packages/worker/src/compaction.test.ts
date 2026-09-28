// Compaction, branch summarization, tool-output spill wiring (issue #34).
// RED: compaction.ts does not exist yet — every test below must fail first.
import { describe, expect, it } from 'vitest';

describe('trigger formula (issue #34: contextTokens > contextWindow - reserveTokens)', () => {
  it('fires only strictly above contextWindow - reserveTokens', async () => {
    const { shouldCompact } = await import('./compaction.js');
    const contextWindow = 200000;
    const reserveTokens = 16384;
    const threshold = contextWindow - reserveTokens;
    expect(
      shouldCompact({
        contextTokens: threshold,
        contextWindow,
        reserveTokens,
      }),
    ).toBe(false);
    expect(
      shouldCompact({
        contextTokens: threshold + 1,
        contextWindow,
        reserveTokens,
      }),
    ).toBe(true);
  });

  it('defaults reserveTokens to 16384 and honors explicit overrides', async () => {
    const { DEFAULT_RESERVE_TOKENS, shouldCompact } = await import(
      './compaction.js'
    );
    expect(DEFAULT_RESERVE_TOKENS).toBe(16384);
    // Default: 200000 - 16384 = 183616.
    expect(
      shouldCompact({ contextTokens: 183616, contextWindow: 200000 }),
    ).toBe(false);
    expect(
      shouldCompact({ contextTokens: 183617, contextWindow: 200000 }),
    ).toBe(true);
    // Override reserve to 1000: threshold 199000.
    expect(
      shouldCompact({
        contextTokens: 199000,
        contextWindow: 200000,
        reserveTokens: 1000,
      }),
    ).toBe(false);
    expect(
      shouldCompact({
        contextTokens: 199001,
        contextWindow: 200000,
        reserveTokens: 1000,
      }),
    ).toBe(true);
  });
});

describe('checkpoints (issue #34: post-tools, pre-prompt, post-low-run; skip batch-terminal)', () => {
  it('fires at all three checkpoints on interactive lanes', async () => {
    const { shouldCheckAt } = await import('./compaction.js');
    expect(shouldCheckAt('post-tools', { batchTerminal: false })).toBe(true);
    expect(shouldCheckAt('pre-prompt', { batchTerminal: false })).toBe(true);
    expect(shouldCheckAt('post-low-run', { batchTerminal: false })).toBe(true);
  });

  it('skips every checkpoint on batch-terminal lanes', async () => {
    const { shouldCheckAt } = await import('./compaction.js');
    expect(shouldCheckAt('post-tools', { batchTerminal: true })).toBe(false);
    expect(shouldCheckAt('pre-prompt', { batchTerminal: true })).toBe(false);
    expect(shouldCheckAt('post-low-run', { batchTerminal: true })).toBe(false);
  });
});

describe('/compact focus instructions (issue #34)', () => {
  it('carries caller focus instructions verbatim into the compact prompt', async () => {
    const { buildCompactPrompt, parseCompactCommand } = await import(
      './compaction.js'
    );
    const focus = parseCompactCommand('/compact focus on the auth flow');
    const prompt = buildCompactPrompt({ focus });
    expect(prompt).toContain('focus on the auth flow');
  });

  it('builds a valid prompt with no focus instructions', async () => {
    const { buildCompactPrompt, parseCompactCommand } = await import(
      './compaction.js'
    );
    expect(parseCompactCommand('/compact')).toBe('');
    const prompt = buildCompactPrompt({});
    expect(prompt.length).toBeGreaterThan(0);
  });
});

describe('/tree branch_summary entries (issue #34: write + switch-back restore e2e)', () => {
  it('writes a branch_summary entry and restores it on switch-back', async () => {
    const { BranchSummaryStore } = await import('./compaction.js');
    const store = new BranchSummaryStore('main', 'main state');
    store.writeBranchSummary({
      branch: 'feature',
      summary: 'feature work in progress',
    });
    store.switchBranch('feature', 'feature state');
    expect(store.current()).toBe('feature');
    expect(store.currentState()).toBe('feature state');
    store.switchBranch('main');
    expect(store.current()).toBe('main');
    expect(store.currentState()).toBe('main state');
    expect(store.readBranchSummary('feature')?.summary).toBe(
      'feature work in progress',
    );
  });
});

describe('structured summaries with cumulative file ops (issue #34)', () => {
  it('lists cumulative created/modified/deleted structurally', async () => {
    const { accumulateFileOps, emptyFileOps, formatStructuredSummary } =
      await import('./compaction.js');
    const ops = accumulateFileOps(emptyFileOps(), [
      { kind: 'created', path: 'a.ts' },
      { kind: 'modified', path: 'b.ts' },
      { kind: 'created', path: 'a.ts' },
      { kind: 'deleted', path: 'c.ts' },
    ]);
    expect(ops.created).toEqual(['a.ts']);
    expect(ops.modified).toEqual(['b.ts']);
    expect(ops.deleted).toEqual(['c.ts']);
    const text = formatStructuredSummary({
      goal: 'ship it',
      decisions: ['use x'],
      openWork: ['y'],
      fileOps: ops,
      spillRefs: [],
    });
    expect(text).toContain('a.ts');
    expect(text).toContain('b.ts');
    expect(text).toContain('c.ts');
  });
});

describe('tool-output spill wiring (issue #34: truncated bash resolves via spill path)', () => {
  it('resolves truncated bash output to its spill path artifact ref', async () => {
    const { buildSpillArtifact, resolveTruncatedOutput } = await import(
      './compaction.js'
    );
    const output = {
      truncated: true,
      preview: 'first bytes…',
      spillPath: 'artifacts/spill/bash-123.txt',
    };
    expect(resolveTruncatedOutput(output)).toBe('artifacts/spill/bash-123.txt');
    const artifact = buildSpillArtifact(output.spillPath);
    expect(artifact.path).toBe('artifacts/spill/bash-123.txt');
  });

  it('never truncates Kubic-side: long output passes through byte-identical', async () => {
    const { passThroughOutput } = await import('./compaction.js');
    const long = `x`.repeat(500000);
    expect(passThroughOutput(long)).toBe(long);
  });
});
