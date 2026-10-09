// `kubic run`: argument parsing, the result envelope and exit-code mapping,
// run and turn spans, the run trajectory, and the `[verify]` gate runner.
export type {
  HeadlessRunResult,
  RetryRecord,
  RunCommandOptions,
  RunProgressSink,
  RunTerminusKind,
  RunUsage,
} from './run-cli.js';
export {
  buildRunEnvelope,
  caughtRunResult,
  checkPromptValue,
  DEFAULT_RUN_TIMEOUT_MS,
  MAX_RUN_TIMEOUT_MS,
  mapCaughtErrorToTerminus,
  mapLaneOutcomeToFailure,
  /** @internal */ mapTerminusToExitCode,
  parseRunMaxTurns,
  parseRunTimeout,
  parseSessionIdArg,
  refusedRunResult,
  runRunCommand,
  shellQuote,
} from './run-cli.js';
export type { TurnSpansSink } from './run-spans.js';
export {
  RunSpans,
  runSpanHooks,
  serializeSpanArtifact,
  TurnSpans,
} from './run-spans.js';
export type { RunOutcome } from './run-trajectory.js';
export {
  assembleRunTrajectory,
  TRAJECTORY_FILE,
  /** @internal */ trajectoryResultFor,
  writeRunTrajectory,
} from './run-trajectory.js';
export type { DebugSink } from './spans.js';
export { hookErrorLine, modelLine } from './spans.js';
export { hasVerifyCommands, runVerifier, verifierLabels } from './verifier.js';
