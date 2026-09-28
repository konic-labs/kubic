// packages/worker/src/pi-boundary.ts — the SINGLE choke point for Pi harness
// imports (design §65). No other Kubic file may import `@earendil-works/*`
// modules; `scripts/dep-lint.mjs` rejects Pi imports everywhere else and
// CODEOWNERS flags every diff touching this file for maintainer review.
//
// Approved seams (public Pi surface only — never Pi deep internals):
// - ExecutionEnv (sandboxed shell + filesystem for worker runs)
// - *Operations (tool implementations the worker exposes to the lane)
// - before_tool hook (approval interception point)
// - deferred approvals (async approval client contract)
//
// Per-export justification template — copy this block above EVERY re-export
// added to this file:
//
//   JUSTIFICATION:
//     seam: <Pi package + export path, e.g. @earendil-works/pi-agent-core#ExecutionEnv>
//     used by: <Kubic module that needs it, e.g. packages/worker/src/session.ts>
//     why Pi has no alternative: <one line — what breaks if we reimplement>
//     review: <link to the approving issue/PR discussion>

// JUSTIFICATION:
//   seam: @earendil-works/pi-agent-core harness types (AgentLane, tools,
//     DriveOutcome, requests, Context)
//   used by: packages/worker/src/lane/* (adapter + drive wrapper typings)
//   why Pi has no alternative: these types ARE the harness contract (§15 —
//     Kubic defines no parallel event vocabulary)
//   review: issue #11 (OpenOperation: issue #147 — the open operations Pi
//     restores on attach, which bootSoloLane surfaces so a crashed turn is
//     resumed or aborted instead of refusing every prompt with LaneBusy)
export type {
  AbortRequestResult,
  AgentHarness as AgentHarnessApi,
  AgentHarnessTool,
  AgentHarnessToolInvocation,
  AgentHarnessToolUpdateCallback,
  AgentLane,
  Context,
  DriveOptions,
  DriveOutcome,
  DriveResult,
  Events,
  FileErrorCode,
  FileInfo,
  FileKind,
  FileSystem,
  HarnessEvent,
  HookHandler,
  Hooks,
  JsonValue,
  LaneSnapshot,
  OpenOperation,
  OperationAdmissionResult,
  OperationError,
  OperationRequest,
  OperationResultRecord,
  Result,
  Session,
  SessionCreateOptions,
  SessionRepo,
  TerminalStatus,
  UsageRow,
} from '@earendil-works/pi-agent-core';
// JUSTIFICATION:
//   seam: @earendil-works/pi-agent-core#AgentHarness
//   used by: packages/worker/src/lane/solo.ts (solo lane boot)
//   why Pi has no alternative: the agent loop, durable execution, and session
//     restore ARE Pi (§4) — reimplementing them would fork the harness
//   review: issue #11 (root AgentLane wiring)
// JUSTIFICATION:
//   seam: @earendil-works/pi-agent-core#BACKGROUND_CONTEXT
//   used by: packages/worker/src/lane/solo.ts + tests (non-interactive drive)
//   why Pi has no alternative: Context carries Pi's cancellation/telemetry
//     plumbing; fabricating one would detach the lane from harness context
//   review: issue #11
// JUSTIFICATION:
//   seam: @earendil-works/pi-agent-core#MemorySessionRepo (+ Session types)
//   used by: packages/worker/src/lane/solo.ts (session backing) and tests
//   why Pi has no alternative: session durability is a harness concern (§21 —
//     SessionRepo.open + lane.resume); JSONL backing lands with issue #14
//   review: issue #11
// JUSTIFICATION:
//   seam: @earendil-works/pi-agent-core#laneConfig (public session value
//     address for a lane's persisted configuration)
//   used by: packages/worker/src/lane/solo.ts (issue #148 — read the model a
//     resumed lane will restore BEFORE the harness boots, so the prompt
//     metadata, reserve clamp and reports name the model the lane runs)
//   why Pi has no alternative: Pi restores the stored model inside
//     harness.lane(); the public value address is the only read of it that
//     happens before the system prompt is fixed
//   review: issue #148
export {
  AgentHarness,
  BACKGROUND_CONTEXT,
  err,
  FileError,
  JsonlSessionRepo,
  laneConfig,
  MemorySessionRepo,
  ok,
} from '@earendil-works/pi-agent-core';
export type {
  DeferredHandle,
  Model,
  ModelThinkingLevel,
  MutableModels,
  // TSchema (issue #168): the type of the per-operation parameter schemas
  // in ops/registry.ts — the same typebox Pi's Tool.parameters requires.
  TSchema,
  Usage,
} from '@earendil-works/pi-ai';
// JUSTIFICATION:
//   seam: @earendil-works/pi-ai thinking support (supported levels + clamp)
//   used by: packages/worker/src/model-select.ts (issue #20 thinking clamp)
//   why Pi has no alternative: per-model thinking support lives in the model
//     definitions (§38); reimplementing the clamp would desync from models
//   review: issue #20
// JUSTIFICATION:
//   seam: @earendil-works/pi-ai model layer (createModels, faux provider,
//     Model type, Type for tool schemas)
//   used by: packages/worker/src/lane/* (model wiring) and faux-driven tests
//   why Pi has no alternative: providers, auth, and models.json are Pi's
//     model layer (§4); real wiring lands with issue #20
//   review: issue #11
// JUSTIFICATION:
//   seam: @earendil-works/pi-ai#Type (typebox re-export, v1.3.27)
//   used by: packages/worker/src/lane/tools-adapter.ts (tool arg schemas)
//   why Pi has no alternative: AgentTool.parameters requires a TSchema and
//     Pi pins typebox 1.3.27 — importing Pi's re-export keeps exactly one
//     schema implementation on the tool path instead of a second typebox copy
//   review: issue #11
// JUSTIFICATION:
//   seam: @earendil-works/pi-ai custom providers (createProvider +
//     OpenAI-compatible stream factories for models.json endpoints)
//   used by: packages/worker/src/models-config.ts (issue #20 local/custom)
//   why Pi has no alternative: provider streaming, auth resolution, and cost
//     accounting live in Pi's model layer (§37 — registry generated, never
//     hand-edited); Kubic only parses models.json and calls the factory
//   review: issue #20
// JUSTIFICATION:
//   seam: @earendil-works/pi-ai credential store (in-memory; file-backed
//     credentials land with EPIC D/F — solo runs on env keys + memory)
//   used by: apps/kubic composition root (models assembly for `kubic models`)
//   why Pi has no alternative: auth resolution reads this store (§37)
//   review: issue #20
// JUSTIFICATION:
//   seam: @earendil-works/pi-ai#validateToolArguments
//   used by: packages/worker/src/ops/registry-schema.test.ts (issue #168 —
//     pins that the registry schemas and the Kubic validators agree)
//   why Pi has no alternative: it is the exact check the harness runs on
//     every tool call before execute; a second schema checker would test a
//     different validator than the one production uses
//   review: issue #168
export {
  clampThinkingLevel,
  createModels,
  createProvider,
  envApiKeyAuth,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  getSupportedThinkingLevels,
  InMemoryCredentialStore,
  Type,
  validateToolArguments,
} from '@earendil-works/pi-ai';
export { openAICompletionsApi as openAICompletionsApiLazy } from '@earendil-works/pi-ai/api/openai-completions.lazy';
export { openAIResponsesApi as openAIResponsesApiLazy } from '@earendil-works/pi-ai/api/openai-responses.lazy';
