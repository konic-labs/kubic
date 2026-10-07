// Production code the shipped binary never reaches, kept on purpose.
//
// `reachability.mjs` fails on any other source file that no value import
// reaches from apps/kubic/src/main.ts, and `test-only-exports.mjs` fails on
// any other agent-lane export that only tests call. Both also fail on an
// entry here that is used again or no longer exists, so the list never
// outlives its reason.

/** Unreachable source files, keyed by repo-relative path. */
export const DEAD_FILES = {
  'apps/kubic/src/cli/context.ts':
    'type-only command registry contract: `import type` is erased, so nothing reaches it at runtime',
  'packages/eval/src/rl/fixtures.ts':
    'RL dataset export, not wired into the eval CLI yet',
  'packages/eval/src/rl/index.ts':
    'RL dataset export, not wired into the eval CLI yet',
  'packages/exec/src/test-support/git-sandbox.ts':
    'test support: the real-git sandbox the tests share',
  'packages/worker/src/lane/test-harness.ts':
    'test support: the faux lane factory the tests share',
};

/** Agent-lane exports only tests call, keyed by module, then symbol. */
export const UNWIRED_EXPORTS = {
  'packages/worker/src/compaction.ts': {
    emptyFileOps:
      'structured-summary file-ops vocabulary; the spill path is not implemented',
    accumulateFileOps:
      'structured-summary file-ops vocabulary; the spill path is not implemented',
    formatStructuredSummary:
      'structured-summary vocabulary; summaries are not rendered anywhere yet',
    resolveTruncatedOutput:
      'spill-path resolver; the spill path is not implemented',
    buildSpillArtifact:
      'spill artifact constructor; spill artifacts are not implemented',
    passThroughOutput:
      'no-truncation guarantee for the spill path; the spill path is not implemented',
  },
  'packages/worker/src/prompts.ts': {
    assertSingleModelId:
      'single-model-per-turn guard; no per-turn re-selection site exists yet',
    SessionCacheStats:
      'cache hit/miss vocabulary; no status surface reads it yet',
    buildCompactionRoute:
      'fresh-routing-id guard; no routing-id compaction site exists yet',
  },
  'packages/worker/src/lane/wrap.ts': {
    compositionOrder:
      'extension wrap-order formatter; the boot order is fixed, nothing formats it yet',
  },
  'packages/worker/src/lane/settle.ts': {
    settleSubmission:
      'submission-settlement kernel; the live path settles through settleTerminalStatus',
  },
};
