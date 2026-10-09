// ExecutionEnv seam.
// Every tool runs through this seam — no tool imports node:fs/child_process
// directly (enforced by scripts/dep-lint.mjs: only packages/exec may).
// Kubic has no isolation: confinement here is a cwd guardrail against
// accidental escapes, not a sandbox boundary.
//
// FileSystem + Shell interfaces, provenance on every result,
// NodeExecutionEnv (cwd-scoped), FakeExecutionEnv (hermetic tests).
// Streaming onUpdate, throttled change-gated checkpoints,
// recordFinal crash-resume read point, detached process-group kill.
// Replay declarations and the tool-call state machine are NOT reimplemented
// here: the Pi harness owns the tool-call state machine
// (`planned → effect_pending → outcome_ready → completed`, `replay:
// "never" | "safe"`) and the admission gate. Kubic declares a policy per
// operation and hands it to the harness.

export type {
  CheckpointStore,
  ExecutionEnv,
  FileSystem,
  ProcessHandle,
  ProcessSnapshot,
  Provenance,
  Shell,
  ShellResult,
  /** @internal */ SpawnOptions,
  StatInfo,
} from './contracts.js';
export { /** @internal */ ROOT_PROVENANCE } from './contracts.js';
export { NodeExecutionEnv } from './node-env.js';

export { toolSpawnEnv } from './tool-env.js';
