// biome-ignore-all assist/source/organizeImports: each re-export keeps its own
// JUSTIFICATION block packages/agent/src/pi-boundary.ts — the agent Pi seam.
// No other Kubic file may import `@earendil-works/*`: `scripts/dep-lint.mjs`
// allows Pi imports only in this file and in the TUI's
// `packages/tui/src/tui-boundary.ts`, and CODEOWNERS flags every diff touching
// this file for maintainer review.
//
// Pi 1.0 has no experimental harness in `@earendil-works/pi-agent-core`
// (AgentHarness, AgentLane, sessions, drive, OpenOperation, harness tools,
// hooks, events). The approved seams are:
// - pi-durable Harness over a Storage (conversations, durable tasks, resume)
// - Kubic operations as pi-durable ToolRegistration, composed with wrapTool
// - ToolTask beforeTool/afterTool, GenerationTask and CompactionTask hooks
//   (policy, approval and perf interception points)
// - chord Context (cancellation every durable call is threaded with)
// - pi-durable FileSystem (the exec-backed session bridge)
// - pi-ai model layer (createModels, providers, thinking clamp, Type)
//
// Per-export justification template — copy this block above EVERY re-export
// added to this file (the pi-boundary gate fails an export without one):
//
//   JUSTIFICATION:
//     seam: <Pi package + export path, e.g. @earendil-works/pi-durable#Harness>
//     used by: <Kubic module that needs it, e.g. packages/agent/src/lane/boot.ts>
//     why Pi has no alternative: <one line — what breaks if we reimplement>

// JUSTIFICATION:
//   seam: @earendil-works/chord#Context, #JsonValue (types)
// used by: packages/agent/src/lane/{boot,session-store,tools-adapter,
//     pending,abort,events}.ts (Context) and lane/interceptors/ + tools
//     (JsonValue for tool details, memos and hook state)
//   why Pi has no alternative: chord's Context IS the cancellation/telemetry
//     plumbing the 1.0 harness is threaded with, and JsonValue is the exact
//     compiled JSON boundary the durable documents and tool details validate
//     against (Kubic defines no parallel vocabularies).
export type { Context, JsonValue } from '@earendil-works/chord';

// JUSTIFICATION:
//   seam: @earendil-works/chord/context#BACKGROUND_CONTEXT
//   used by: packages/agent/src/lane/* (harness calls), apps/kubic/src/
//     {runners/doctor,tui/boot,tui/lane-loop,run/state,run/close}.ts and the host readers
//     under packages/host/src/{sessions,journal,cost,doctor}/
//   why Pi has no alternative: Pi 1.0 has no pi-agent-core re-export;
//     chord owns Context, and every durable call (Harness.open, submit,
//     wait, abort, watchEvents) takes one. BACKGROUND_CONTEXT is the
//     never-cancelling context; a Kubic copy would have to reimplement
//     chord's cancellation plumbing and would not type against the harness.
export { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';

// JUSTIFICATION:
//   seam: @earendil-works/pi-ai#AuthContext (type)
//   used by: packages/host/src/models/models-cli.ts (the explicit env/home the
//     assembled catalogue resolves provider auth against)
//   why Pi has no alternative: createModels reads auth through this context;
//     a Kubic-shaped context would not type-check against Pi's resolver
// TSchema: the type of the per-operation parameter schemas
// in ops/registry.ts — the same typebox Pi's Tool.parameters requires.
export type {
  ApiKeyAuth,
  AuthContext,
  Model,
  ModelThinkingLevel,
  MutableModels,
  TSchema,
  Usage,
} from '@earendil-works/pi-ai';

// JUSTIFICATION:
//   seam: @earendil-works/pi-ai thinking support (supported levels + clamp)
//   used by: packages/agent/src/model-select.ts
//   why Pi has no alternative: per-model thinking support lives in the model
//     definitions; reimplementing the clamp would desync from models
// JUSTIFICATION:
//   seam: @earendil-works/pi-ai model layer (createModels, faux provider,
//     Model type, Type for tool schemas)
//   used by: packages/agent/src/lane/* (model wiring) and faux-driven tests
//   why Pi has no alternative: providers, auth, and models.json are Pi's
//     model layer
// JUSTIFICATION:
//   seam: @earendil-works/pi-ai#Type (typebox re-export, v1.3.27)
//   used by: packages/agent/src/lane/tools-adapter.ts (tool arg schemas)
//   why Pi has no alternative: AgentTool.parameters requires a TSchema and
//     Pi pins typebox 1.3.27 — importing Pi's re-export keeps exactly one
//     schema implementation on the tool path instead of a second typebox copy
// JUSTIFICATION:
//   seam: @earendil-works/pi-ai custom providers (createProvider +
//     OpenAI-compatible stream factories for models.json endpoints)
//   used by: packages/agent/src/models-config/
//   why Pi has no alternative: provider streaming, auth resolution, and cost
//     accounting live in Pi's model layer (registry generated, never
//     hand-edited); Kubic only parses models.json and calls the factory
// JUSTIFICATION:
//   seam: @earendil-works/pi-ai credential store (in-memory; built-ins
//     resolve their env keys through the assembly's auth context)
//   used by: apps/kubic composition root (models assembly for `kubic models`)
//   why Pi has no alternative: auth resolution reads this store
// JUSTIFICATION:
//   seam: @earendil-works/pi-ai#validateToolArguments
//   used by: packages/agent/src/ops/registry-schema.test.ts (pins that the
//   registry schemas and the Kubic validators agree)
//   why Pi has no alternative: it is the exact check the harness runs on
//     every tool call before execute; a second schema checker would test a
//     different validator than the one production uses
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
  /** @internal */ validateToolArguments,
} from '@earendil-works/pi-ai';

// JUSTIFICATION:
//   seam: @earendil-works/pi-ai/api/openai-completions.lazy
//   used by: packages/agent/src/models-config/ (an OpenAI-compatible
//     models.json endpoint is registered as a custom provider)
//   why Pi has no alternative: the lazy subpath is an upstream entry point
//     that loads the completions API without the provider SDKs; importing
//     the eager module instead would load them for every Kubic process
export { openAICompletionsApi as openAICompletionsApiLazy } from '@earendil-works/pi-ai/api/openai-completions.lazy';

// JUSTIFICATION:
//   seam: @earendil-works/pi-ai/api/openai-responses.lazy
//   used by: packages/agent/src/models-config/ (an OpenAI-compatible
//     models.json endpoint is registered as a custom provider)
//   why Pi has no alternative: the lazy subpath is an upstream entry point
//     that loads the responses API without the provider SDKs; importing the
//     eager module instead would load them for every Kubic process
export { openAIResponsesApi as openAIResponsesApiLazy } from '@earendil-works/pi-ai/api/openai-responses.lazy';

// JUSTIFICATION:
//   seam: @earendil-works/pi-ai/providers/all#builtinProviders
//   used by: packages/host/src/models/models-cli.ts (assembleModels registers the
//     generated catalogue before layering models.json customs)
//   why Pi has no alternative: the built-in catalogue is GENERATED by Pi
//     (never hand-edited) and each built-in owns its auth rules
//     (documented env keys, ambient credentials); re-listing providers in
//     Kubic would fork both the catalogue and the auth resolution
export { builtinProviders } from '@earendil-works/pi-ai/providers/all';
// JUSTIFICATION:
//   seam: @earendil-works/pi-ai/utils/uuid#uuidv7
//   used by: packages/agent/src/lane/session-store/ (minting a new
//     session id)
//   why Pi has no alternative: the session id is part of the store's public
//     contract (`kubic run --session`, `kubic sessions list`, the session
//     directory name), and this generator mints it; another source
//     would change every printed id's shape and lose the time-ordered
//     property operators rely on. node:crypto only mints v4.
export { uuidv7 } from '@earendil-works/pi-ai/utils/uuid';
// JUSTIFICATION:
//   seam: @earendil-works/pi-durable types (Conversation, Submission,
//     SettledSubmissionRecord, Extension, ToolRegistration,
//     ToolExecutionApi, ToolHooks, HookRegistration, HarnessSettings,
//     CompactionPolicy, AgentEvent, EntryRecord, Storage)
//   used by: the Kubic modules that name them in their own signatures —
// lane/boot.ts Lane (Conversation, Extension, HarnessSettings),
//     lane/tools-adapter.ts (ToolRegistration, ToolExecutionApi),
//     lane/interceptors/ (ToolHooks, HookRegistration), lane/settle.ts
//     (Submission, SettledSubmissionRecord), lane/events.ts (AgentEvent),
// lane/session-store/ (Storage), lane/boot.ts compaction
//     (CompactionPolicy), the session readers (EntryRecord)
//   why Pi has no alternative: these are the shapes the durable harness
//     passes across its API; Kubic aliases or structural copies would drift
//     from upstream and fail to type-check at the calls they feed.
// JUSTIFICATION:
//   seam: @earendil-works/pi-durable#SnapshotEvent, #UsageState,
//     #ConversationId, #SubmissionId, #TaskId, #EntryId, #JsonObject
//   used by: packages/agent/src/lane/events.ts (the KubicLaneEvent union
//     and the watchEvents snapshot mapping) and packages/agent/src/usage.ts
//     (per-response rows built from a committed assistant entry)
//   why Pi has no alternative: these are the exact types of the events
//     watchEvents delivers and of the ids Kubic keys its own lane events
//     by; structural copies would drift from the committed stream
//     and fail to type-check where Harness/watchEvents are called.
export type {
  AgentEvent,
  CompactionPolicy,
  Conversation,
  ConversationId,
  EntryId,
  EntryRecord,
  HarnessSettings,
  HookRegistration,
  JsonObject,
  SnapshotEvent,
  Storage,
  Submission,
  SubmissionId,
  TaskId,
  ToolExecutionApi,
  ToolRegistration,
  UsageState,
} from '@earendil-works/pi-durable';
// JUSTIFICATION:
//   seam: @earendil-works/pi-durable#Harness, createRegistry,
//     defineExtension
//   used by: packages/agent/src/lane/boot.ts and lane/boot-steps.ts (the
//     lane boots with a per-process registry holding the policy, span and
//     Kubic extensions)
//   why Pi has no alternative: the durable harness IS the execution engine
//     — Harness.open over a Storage owns conversations, durable
//     tasks, resume and the registry of tools/sections/hooks.
// JUSTIFICATION:
//   seam: @earendil-works/pi-durable#defineTool, wrapTool
//   used by: packages/agent/src/lane/tools-adapter.ts (the seven Kubic ops
//     as ToolRegistrations) and lane/wrap.ts (composeTools/wrappers become
//     wrapTool decorators)
//   why Pi has no alternative: a ToolRegistration is what the harness
//     validates, durably runs and replays; defining Kubic's own tool type
//     would not be executed.
// JUSTIFICATION:
//   seam: @earendil-works/pi-durable#section (prompt sections) and #hook,
//     #ToolTask, #GenerationTask, #CompactionTask (hook targets)
//   used by: packages/agent/src/lane/boot.ts (ordered prompt sections) and
//     lane/interceptors/ (beforeTool/afterTool policy and approval);
// lane/boot.ts compaction (CompactionTask.beforeCompact)
//   why Pi has no alternative: these are the built-in tasks whose hooks are
//     the 1.0 replacement for the removed harness before_tool/after_tool
//     interception, and section() is how pieces of the system prompt become
//     positional pi.system entries; a Kubic event vocabulary would bypass
//     durable recovery.
// JUSTIFICATION:
//   seam: @earendil-works/pi-durable#AgentDoc, #LiveDoc, #UsageDoc,
//     #configure
//   used by: packages/agent/src/lane/boot.ts (reconciles the stored model
//     through the root conversation's pi.agent document),
//     lane/events.ts (reads pi.live), the session readers (sum pi.usage),
//     and any creating commit that sets agent choices
//     through configure(tx, …)
//   why Pi has no alternative: these are the committed documents the
//     harness itself writes and reads; Kubic's own doc kinds would not be
//     observed by generation/compaction nor appear in viewState().
// JUSTIFICATION:
//   seam: @earendil-works/pi-durable entry-kind tokens (#UserEntry,
//     #AssistantEntry, #ToolResultEntry, #SystemEntry, #CompactionEntry)
//   used by: packages/agent/src/lane/transcript.ts (the shared pi-durable →
//     Kubic transcript adapter) and apps/kubic/src/run/close.ts (the plain
//     `pi.user` entry that keeps a run's prompt durable)
//   why Pi has no alternative: these tokens carry both the stored entry
//     kinds (pi.user, pi.assistant, …) and their `model` payload types;
//     matching on Kubic string copies would silently drift from storage on
//     an upstream kind rename.
// JUSTIFICATION:
//   seam: @earendil-works/pi-durable#watchEvents, #ConversationBusy,
//     #MemoryStorage, #defineDoc
//   used by: packages/agent/src/lane/events.ts (maps the committed event
//     stream), packages/agent/src/lane/boot.ts (rejects a busy submit with
//     ConversationBusy), packages/agent/src/lane/session-store/
//     (defines the kubic.session document), and the Kubic test harness
//     factory (swaps MemoryStorage for temp-dir JSONL)
//   why Pi has no alternative: watchEvents is the harness's committed-state
//     event stream (experimental upstream, isolated behind Kubic's events
//     module), MemoryStorage is its in-memory backend, and defineDoc is the
//     only way to declare a document the harness will commit.
// JUSTIFICATION:
//   seam: @earendil-works/pi-durable#createSession (the plain Session kernel
//     over one storage: commits and document reads, no harness)
//   used by: packages/agent/src/lane/session-store/ (the creating commit
//     that writes the kubic.session document)
//   why Pi has no alternative: a document write is a Session commit, and the
//     kernel is the only sanctioned writer of storage records (it owns the
//     record shapes, minted IDs and validation). Booting a Harness here would
//     need a model layer and a registry the session store does not own, and
//     hand-built StorageWrite records would reimplement the kernel. Import
//     it as `createSession as createSessionKernel`: it is pi-durable's plain
//     Session kernel, not the store's own createSession.
export {
  AgentDoc,
  AssistantEntry,
  CompactionEntry,
  ConversationBusy,
  createRegistry,
  defineDoc,
  defineExtension,
  defineTool,
  /** @internal */ GenerationTask,
  Harness,
  hook,
  /** @internal */ LiveDoc,
  MemoryStorage,
  SystemEntry,
  section,
  ToolResultEntry,
  ToolTask,
  UsageDoc,
  UserEntry,
  watchEvents,
} from '@earendil-works/pi-durable';
// JUSTIFICATION:
//   seam: @earendil-works/pi-durable/env#FileSystem (with Result,
//     FileErrorCode types)
//   used by: packages/agent/src/lane/session-fs.ts (the exec-backed
//     FileSystem the JSONL storage writes through) and lane/* (the `env`
//     option of Harness.open)
//   why Pi has no alternative: the portable FileSystem returns Result
//     instead of throwing and is the type pi-durable's JSONL core accepts;
//     a Kubic-shaped adapter would not satisfy Storage.open or
//     HarnessOptions.env, and FileError is the code-carrying failure the
//     session bridge maps to Kubic errors.
export type {
  FileErrorCode,
  FileSystem,
  Result,
} from '@earendil-works/pi-durable/env';
// JUSTIFICATION:
//   seam: @earendil-works/pi-durable/env#ok, #err, #FileError
//   used by: packages/agent/src/lane/session-fs.ts (constructing the same
//     Result failures FileSystem callers expect)
//   why Pi has no alternative: these are the constructors of the env
//     Result/FileError pair above; hand-rolling the result shape would
//     drift from the interface the JSONL core and built-in tools read.
export { err, FileError, ok } from '@earendil-works/pi-durable/env';
// JUSTIFICATION:
//   seam: @earendil-works/pi-durable/storage/jsonl#JsonlStorage (the portable
//     JSONL storage core, opened over a supplied FileSystem)
//   used by: packages/agent/src/lane/session-store/ (one storage per
//     <sessions-root>/<id>/) and lane/session-fs.test.ts (the storage
//     conformance suite runs over the exec bridge)
//   why Pi has no alternative: JSONL durability, commit markers and crash
//     recovery are pi-durable Storage internals, and Kubic owns no storage
//     format of its own. The portable
//     core — not the `/node` entry point — is what takes the exec bridge, so
//     every session byte crosses the I/O seam (confinement, secret
//     scrubbing, file modes).
export { JsonlStorage } from '@earendil-works/pi-durable/storage/jsonl';
// JUSTIFICATION:
//   seam: @earendil-works/pi-durable/storage/jsonl/node#openNodeJsonlStorage
//   used by: packages/agent/src/lane/session-store/ (one storage per
//     <sessions-root>/<id>/)
//   why Pi has no alternative: JSONL durability, commit markers and crash
//     recovery are pi-durable Storage internals, and Kubic owns no storage
//     format of its own.
export {
  /** @internal */ openNodeJsonlStorage,
} from '@earendil-works/pi-durable/storage/jsonl/node';

// JUSTIFICATION:
//   seam: @earendil-works/pi-durable#TaskId, #CompactionResult (types)
//   used by: packages/agent/src/compaction.ts (the admitted manual
//     compaction's id comes back from Conversation.compact; the admission
//     waits on it with harness.waitForTask)
//   why Pi has no alternative: TaskId is the branded id the durable task
//     graph hands back from Conversation.compact(); a Kubic string handle
//     would not type-check against waitForTask/getTask and would drift from
//     the ids in LiveDoc.compactions and the pi.compaction entries.
// TaskId is re-exported by the block above (deduped at merge).
export type { CompactionResult } from '@earendil-works/pi-durable';

// JUSTIFICATION:
//   seam: @earendil-works/pi-durable#Registry
// used by: packages/agent/src/lane/boot.ts (Lane.registry — the
//     per-process registry the boot installs the Kubic extensions into)
//     and lane/policy.ts (resolving a name-based allowlist back to the
//     ToolRegistration objects configure({ tools }) takes)
//   why Pi has no alternative: HarnessOptions takes exactly this Registry,
//     and a Kubic-shaped copy would neither type against Harness.open nor
//     publish the ToolRegistration objects an allowlist must reference.
export type { Registry } from '@earendil-works/pi-durable';
// JUSTIFICATION:
//   seam: @earendil-works/pi-durable#createSession (the plain Session kernel
//     over one storage: commits and document reads, no harness)
//   used by: packages/agent/src/lane/session-store/ (the creating commit
//     that writes the kubic.session document)
//   why Pi has no alternative: a document write is a Session commit, and the
//     kernel is the only sanctioned writer of storage records (it owns the
//     record shapes, minted IDs and validation). Booting a Harness here would
//     need a model layer and a registry the session store does not own, and
//     hand-built StorageWrite records would reimplement the kernel. Import
//     it as `createSession as createSessionKernel`: it is pi-durable's plain
//     Session kernel, not the store's own createSession.
export { createSession } from '@earendil-works/pi-durable';
// JUSTIFICATION:
//   seam: @earendil-works/pi-durable/testing#registerStorageConformance
//   used by: packages/agent/src/lane/session-fs.test.ts (the exec-bridge
//   FileSystem is checked against pi-durable's own storage contract, so an
//   adapter that drifts from the interface the storage relies on fails there
//   instead of corrupting a session)
//   why Pi has no alternative: the suite is the storage implementation's own
//     contract; a Kubic copy would test a different contract than the one
//     production runs against.
export {
  /** @internal */ registerStorageConformance,
} from '@earendil-works/pi-durable/testing';

// JUSTIFICATION:
//   seam: @earendil-works/chord/context#withAbortSignal, #withCancel
//   used by: apps/kubic/src/run/{guard,close}.ts (the run's guard is a
//     cancellable Context, cancelled by a wall clock, a turn count or an
//     interrupt, whose abort reason packages/agent/src/lane/turn.ts reads;
//     the end-of-run abort has its own bound) and, for withAbortSignal, the
//     lane turn tests
//   why Pi has no alternative: chord's Context IS the cancellation plumbing
//     every durable call is threaded with; hand-rolling a context
//     object would not carry the ContextKeys the harness reads and would
//     bypass chord's listener registration. The parent stays unchanged, so a
//     per-turn bound never outlives its turn.
export {
  /** @internal */ withAbortSignal,
  withCancel,
} from '@earendil-works/chord/context';
// JUSTIFICATION:
//   seam: @earendil-works/pi-durable#ResetEntry
//   used by: packages/agent/src/lane/transcript.ts (the shared pi-durable →
//     Kubic transcript adapter maps a pi.reset entry: a plain reset, or one
//     carrying the handoff text as a user message)
//   why Pi has no alternative: the token carries the stored entry kind
//     (`pi.reset`) the adapter matches on; a Kubic string copy would drift
//     from storage on an upstream kind rename. The other five entry tokens
//     are already exported above; ResetEntry was missed in that block.
// JUSTIFICATION:
//   seam: @earendil-works/pi-durable#ROOT_CONVERSATION_ID
//   used by: packages/agent/src/lane/transcript.ts (readSessionEntries
//     reads a session's active transcript straight from its Storage — the
//     CLI readers attach to a session without booting a harness, and the
// lane's transcript is its reserved root conversation)
//   why Pi has no alternative: the id is reserved by pi-durable's Session
//     (the harness creates the root conversation under it); Kubic could only
//     guess a numeric literal, which would silently read nothing after an
//     upstream change.
export { ResetEntry, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable';

// JUSTIFICATION:
//   seam: @earendil-works/pi-ai/utils/estimate#estimateContextTokens
//   used by: packages/agent/src/compaction.ts (the manual `/compact` path
//     reports the context size before the cut in the TUI footer)
//   why Pi has no alternative: the number has to be the SAME estimate Pi's
//     own compaction threshold and cut selection use (the provider's usage
//     blocks plus message estimates); a Kubic reimplementation would report
//     a different number than the mechanism it describes, and the util
//     already exists upstream.
export { estimateContextTokens } from '@earendil-works/pi-ai/utils/estimate';

// JUSTIFICATION:
//   seam: @earendil-works/pi-ai#CacheRetention (type)
//   used by: packages/agent/src/stream-options.ts (the cacheRetention leaf of
//   the tuning)
//   why Pi has no alternative: it is the exact retention vocabulary
//     ('none' | 'short' | 'long') the provider stream options accept; a
//     Kubic string union would drift from the values Pi validates.
export type { CacheRetention } from '@earendil-works/pi-ai';
// JUSTIFICATION:
//   seam: @earendil-works/pi-durable#ConversationStreamOptions (type)
//   used by: packages/agent/src/stream-options.ts (the per-model/ per-role
// tuning the lane hands to Harness.open as settings.stream)
//     and packages/host/src/config/config.ts (the parsed [model]/[roles.*]
//     tables it resolves from)
//   why Pi has no alternative: these are the curated request options the
//     durable harness reads at every use (timeoutMs, maxRetries,
//     maxRetryDelayMs, headers, metadata, cacheRetention, deferred); a
//     Kubic-shaped copy would neither type against HarnessSettings nor track
//     the options generation actually forwards to the provider stream.
export type { ConversationStreamOptions } from '@earendil-works/pi-durable';
