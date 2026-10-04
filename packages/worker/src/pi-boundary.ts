// packages/worker/src/pi-boundary.ts — the worker Pi seam (design §65).
// No other Kubic file may import `@earendil-works/*`: `scripts/dep-lint.mjs`
// allows Pi imports only in this file and in the TUI's
// `packages/tui/src/tui-boundary.ts`, and CODEOWNERS flags every diff
// touching this file for maintainer review.
//
// Pi 1.0 removed the experimental harness from `@earendil-works/pi-agent-core`
// (AgentHarness, AgentLane, sessions, drive, OpenOperation, harness tools,
// hooks, events). The approved seams are now:
// - pi-durable Harness over a Storage (conversations, durable tasks, resume)
// - Kubic operations as pi-durable ToolRegistration, composed with wrapTool
// - ToolTask beforeTool/afterTool, GenerationTask and CompactionTask hooks
//   (policy, budget, approval and perf interception points)
// - chord Context (cancellation every durable call is threaded with)
// - pi-durable FileSystem / ExecutionEnv (the exec-backed session bridge)
// - pi-ai model layer (createModels, providers, thinking clamp, Type)
//
// Per-export justification template — copy this block above EVERY re-export
// added to this file (the pi-boundary gate fails an export without one):
//
//   JUSTIFICATION:
//     seam: <Pi package + export path, e.g. @earendil-works/pi-durable#Harness>
//     used by: <Kubic module that needs it, e.g. packages/worker/src/lane/solo.ts>
//     why Pi has no alternative: <one line — what breaks if we reimplement>
//     review: <link to the approving issue/PR discussion>

// JUSTIFICATION:
//   seam: @earendil-works/chord#Context, #JsonValue (types)
//   used by: packages/worker/src/lane/{solo,session-store,tools-adapter,
//     pending,abort,events}.ts (Context) and lane/interceptors.ts+tools
//     (JsonValue for tool details, memos and hook state)
//   why Pi has no alternative: chord's Context IS the cancellation/telemetry
//     plumbing the 1.0 harness is threaded with, and JsonValue is the exact
//     compiled JSON boundary the durable documents and tool details validate
//     against (§4, §65 — Kubic defines no parallel vocabularies).
//   review: issue #391 (K3 #393, K7 #397)
export type { Context, JsonValue } from '@earendil-works/chord';

// JUSTIFICATION:
//   seam: @earendil-works/chord/context#BACKGROUND_CONTEXT
//   used by: packages/worker/src/lane/* (harness calls), apps/kubic/src/
//     {prod-runners,headless-run,tui-run,orchestrate-run}.ts and
//     packages/host/src/{sessions-cli,journal-cli,ops/cost/cost-cli}.ts
//   why Pi has no alternative: Pi 1.0 removed the pi-agent-core re-export;
//     chord owns Context now, and every durable call (Harness.open, submit,
//     wait, abort, watchEvents) takes one. BACKGROUND_CONTEXT is the
//     never-cancelling context; a Kubic copy would have to reimplement
//     chord's cancellation plumbing and would not type against the harness.
//   review: issue #391 (K10 #400 repoints the host readers)
export { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';

// JUSTIFICATION:
//   seam: @earendil-works/pi-ai#AuthContext (type)
//   used by: packages/host/src/models-cli.ts (the explicit env/home the
//     assembled catalogue resolves provider auth against)
//   why Pi has no alternative: createModels reads auth through this context;
//     a Kubic-shaped context would not type-check against Pi's resolver
//   review: issue #221
export type {
  ApiKeyAuth,
  AuthContext,
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
//     credentials land with EPIC D/F — built-ins resolve their env keys
//     through the assembly's auth context, issue #221)
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

// JUSTIFICATION:
//   seam: @earendil-works/pi-ai/api/openai-completions.lazy
//   used by: packages/worker/src/models-config.ts (an OpenAI-compatible
//     models.json endpoint is registered as a custom provider)
//   why Pi has no alternative: the lazy subpath is an upstream entry point
//     that loads the completions API without the provider SDKs; importing
//     the eager module instead would load them for every Kubic process
//   review: issue #197 (folded into #391)
export { openAICompletionsApi as openAICompletionsApiLazy } from '@earendil-works/pi-ai/api/openai-completions.lazy';

// JUSTIFICATION:
//   seam: @earendil-works/pi-ai/api/openai-responses.lazy
//   used by: packages/worker/src/models-config.ts (an OpenAI-compatible
//     models.json endpoint is registered as a custom provider)
//   why Pi has no alternative: the lazy subpath is an upstream entry point
//     that loads the responses API without the provider SDKs; importing the
//     eager module instead would load them for every Kubic process
//   review: issue #197 (folded into #391)
export { openAIResponsesApi as openAIResponsesApiLazy } from '@earendil-works/pi-ai/api/openai-responses.lazy';

// JUSTIFICATION:
//   seam: @earendil-works/pi-ai/providers/all#builtinProviders
//   used by: packages/host/src/models-cli.ts (assembleModels registers the
//     generated catalogue before layering models.json customs)
//   why Pi has no alternative: the built-in catalogue is GENERATED by Pi
//     (§37.2 — never hand-edited) and each built-in owns its auth rules
//     (documented env keys, ambient credentials); re-listing providers in
//     Kubic would fork both the catalogue and the auth resolution
//   review: issue #221
export { builtinProviders } from '@earendil-works/pi-ai/providers/all';
// JUSTIFICATION:
//   seam: @earendil-works/pi-durable types (Conversation, Submission,
//     SettledSubmissionRecord, Extension, ToolRegistration,
//     ToolExecutionApi, ToolHooks, HookRegistration, HarnessSettings,
//     CompactionPolicy, AgentEvent, EntryRecord, Storage)
//   used by: the Kubic modules that name them in their own signatures —
//     lane/solo.ts SoloLane (Conversation, Extension, HarnessSettings),
//     lane/tools-adapter.ts (ToolRegistration, ToolExecutionApi),
//     lane/interceptors.ts (ToolHooks, HookRegistration), lane/settle.ts
//     (Submission, SettledSubmissionRecord), lane/events.ts (AgentEvent),
//     lane/session-store.ts (Storage), lane/solo.ts compaction
//     (CompactionPolicy), K10 readers (EntryRecord)
//   why Pi has no alternative: these are the shapes the durable harness
//     passes across its API; Kubic aliases or structural copies would drift
//     from upstream and fail to type-check at the calls they feed (§65).
//   review: issue #391 (K2 #392, K3 #393, K4 #394, K5 #395, K7 #397,
//     K8 #398, K9 #399, K10 #400, K11 #401)
export type {
  AgentEvent,
  CompactionPolicy,
  Conversation,
  EntryRecord,
  Extension,
  HarnessSettings,
  HookRegistration,
  SettledSubmissionRecord,
  Storage,
  Submission,
  ToolExecutionApi,
  ToolHooks,
  ToolRegistration,
} from '@earendil-works/pi-durable';
// JUSTIFICATION:
//   seam: @earendil-works/pi-durable#Harness, createRegistry,
//     defineExtension
//   used by: packages/worker/src/lane/solo.ts (K4 #394 boots the solo lane
//     with a per-process registry holding the Kubic extension)
//   why Pi has no alternative: the durable harness IS the execution engine
//     (§4, §20) — Harness.open over a Storage owns conversations, durable
//     tasks, resume and the registry of tools/sections/hooks; the 0.87
//     AgentHarness it replaces is gone in 1.0.
//   review: issue #391 (K4 #394)
// JUSTIFICATION:
//   seam: @earendil-works/pi-durable#defineTool, wrapTool
//   used by: packages/worker/src/lane/tools-adapter.ts (the seven Kubic ops
//     as ToolRegistrations) and lane/wrap.ts (composeTools/wrappers become
//     wrapTool decorators)
//   why Pi has no alternative: a ToolRegistration is what the harness
//     validates, durably runs and replays; the 0.87 AgentHarnessTool is
//     gone, and defining Kubic's own tool type would not be executed.
//   review: issue #391 (K3 #393)
// JUSTIFICATION:
//   seam: @earendil-works/pi-durable#section (prompt sections) and #hook,
//     #ToolTask, #GenerationTask, #CompactionTask (hook targets)
//   used by: packages/worker/src/lane/solo.ts (ordered prompt sections) and
//     lane/interceptors.ts (beforeTool/afterTool policy, budget, approval);
//     lane/solo.ts compaction (CompactionTask.beforeCompact)
//   why Pi has no alternative: these are the built-in tasks whose hooks are
//     the 1.0 replacement for the removed harness before_tool/after_tool
//     interception, and section() is how pieces of the system prompt become
//     positional pi.system entries; a Kubic event vocabulary would bypass
//     durable recovery (§15).
//   review: issue #391 (K4 #394, K7 #397, K9 #399)
// JUSTIFICATION:
//   seam: @earendil-works/pi-durable#AgentDoc, #LiveDoc, #UsageDoc,
//     #configure
//   used by: packages/worker/src/lane/solo.ts (K4 #394 reconciles the
//     stored model through the root conversation's pi.agent document),
//     lane/events.ts (K8 #398 reads pi.live), the session readers (K10 #400
//     sums pi.usage), and any creating commit that sets agent choices
//     through configure(tx, …)
//   why Pi has no alternative: these are the committed documents the
//     harness itself writes and reads; Kubic's own doc kinds would not be
//     observed by generation/compaction nor appear in viewState().
//   review: issue #391 (K2 #392, K4 #394, K8 #398, K10 #400)
// JUSTIFICATION:
//   seam: @earendil-works/pi-durable entry-kind tokens (#UserEntry,
//     #AssistantEntry, #ToolResultEntry, #SystemEntry, #CompactionEntry)
//   used by: packages/host/src/trajectory/run-trajectory.ts,
//     packages/host/src/sessions-cli.ts and apps/kubic/src/headless-run.ts
//     (the shared pi-durable → Kubic transcript adapter)
//   why Pi has no alternative: these tokens carry both the stored entry
//     kinds (pi.user, pi.assistant, …) and their `model` payload types;
//     matching on Kubic string copies would silently drift from storage on
//     an upstream kind rename.
//   review: issue #391 (K10 #400)
// JUSTIFICATION:
//   seam: @earendil-works/pi-durable#watchEvents, #ConversationBusy,
//     #MemoryStorage, #defineDoc
//   used by: packages/worker/src/lane/events.ts (K8 #398 maps the committed
//     event stream), packages/worker/src/lane/solo.ts (K5 #395 rejects a
//     busy submit with ConversationBusy), packages/worker/src/lane/
//     session-store.ts (K2 #392 defines the kubic.session document), and
//     the Kubic test harness factory (K11 #401 swaps MemoryStorage for
//     temp-dir JSONL)
//   why Pi has no alternative: watchEvents is the harness's committed-state
//     event stream (experimental upstream, isolated behind Kubic's events
//     module), MemoryStorage is its in-memory backend, and defineDoc is the
//     only way to declare a document the harness will commit.
//   review: issue #391 (K2 #392, K5 #395, K8 #398, K11 #401)
export {
  AgentDoc,
  AssistantEntry,
  CompactionEntry,
  CompactionTask,
  ConversationBusy,
  configure,
  createRegistry,
  defineDoc,
  defineExtension,
  defineTool,
  GenerationTask,
  Harness,
  hook,
  LiveDoc,
  MemoryStorage,
  SystemEntry,
  section,
  ToolResultEntry,
  ToolTask,
  UsageDoc,
  UserEntry,
  watchEvents,
  wrapTool,
} from '@earendil-works/pi-durable';

// JUSTIFICATION:
//   seam: @earendil-works/pi-durable/env#FileSystem (with Result,
//     FileErrorCode, FileInfo, FileKind, ExecutionEnv types)
//   used by: packages/worker/src/lane/session-fs.ts (the exec-backed
//     FileSystem the JSONL storage writes through) and lane/* (the `env`
//     option of Harness.open)
//   why Pi has no alternative: the portable FileSystem returns Result
//     instead of throwing and is the type pi-durable's JSONL core accepts;
//     a Kubic-shaped adapter would not satisfy Storage.open or
//     HarnessOptions.env, and FileError is the code-carrying failure the
//     session bridge maps to Kubic errors.
//   review: issue #391 (K2 #392 implements flushFile/truncateFile)
export type {
  ExecutionEnv,
  FileErrorCode,
  FileInfo,
  FileKind,
  FileSystem,
  Result,
} from '@earendil-works/pi-durable/env';

// JUSTIFICATION:
//   seam: @earendil-works/pi-durable/env#ok, #err, #FileError
//   used by: packages/worker/src/lane/session-fs.ts (constructing the same
//     Result failures FileSystem callers expect)
//   why Pi has no alternative: these are the constructors of the env
//     Result/FileError pair above; hand-rolling the result shape would
//     drift from the interface the JSONL core and built-in tools read.
//   review: issue #391 (K2 #392)
export { err, FileError, ok } from '@earendil-works/pi-durable/env';

// JUSTIFICATION:
//   seam: @earendil-works/pi-durable/storage/jsonl/node#openNodeJsonlStorage
//   used by: packages/worker/src/lane/session-store.ts (one storage per
//     <sessions-root>/<id>/ — K2 #392)
//   why Pi has no alternative: JSONL durability, commit markers and crash
//     recovery are pi-durable Storage internals; the 0.87 JsonlSessionRepo
//     is gone in 1.0, and Kubic owns no storage format of its own.
//   review: issue #391 (K2 #392)
export { openNodeJsonlStorage } from '@earendil-works/pi-durable/storage/jsonl/node';
