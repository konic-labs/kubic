// `kubic run`: argument parsing, the result envelope and exit-code mapping,
// run and turn spans, the run trajectory, and the `[verify]` gate runner.
export type { RunCommandOptions, RunProgressSink } from './run-cli.js';
export {
  checkPromptValue,
  DEFAULT_RUN_TIMEOUT_MS,
  MAX_RUN_TIMEOUT_MS,
  parseRunMaxTurns,
  parseRunTimeout,
  parseSessionIdArg,
  runRunCommand,
  shellQuote,
} from './run-cli.js';
export type {
  HeadlessRunResult,
  RetryRecord,
  RunTerminusKind,
  RunUsage,
} from './run-result.js';
export {
  buildRunEnvelope,
  caughtRunResult,
  mapCaughtErrorToTerminus,
  mapLaneOutcomeToFailure,
  /** @internal */ mapTerminusToExitCode,
  refusedRunResult,
} from './run-result.js';
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
export type { GateObserver } from './verifier.js';
export { hasVerifyCommands, runVerifier, verifierLabels } from './verifier.js';
