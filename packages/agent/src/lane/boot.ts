// The lane: one pi-durable Harness over a session and the conversation the
// session runs (the root, or a fork's own), in-process. The boot's steps are
// in boot-steps.ts.
// Zero IPC on the path — the harness, the conversation, and the Kubic tools
// all live in this process. Kubic adds no loop: a turn is
// `conversation.submit(...)` → `submission.wait(...)`, and durable
// retry/backoff belongs to the harness (lane/turn.ts owns the turn glue).

import type { ExecutionEnv } from '@kubic/exec/env';
import type { FileJournalStore } from '@kubic/exec/journal';
import {
  compactionSettings,
  createManualKeepScope,
  DEFAULT_RESERVE_TOKENS,
  type ManualKeepScope,
} from '../compaction.js';
import type { EscalationLadder, ThinkingInputs } from '../model-select.js';
import { validateEscalation } from '../model-select.js';
import type { PermissionClasses } from '../permissions.js';
import { toolsForClasses, validateClasses } from '../permissions.js';
import {
  AgentDoc,
  BACKGROUND_CONTEXT,
  type Context,
  type Conversation,
  createRegistry,
  defineExtension,
  Harness,
  type HarnessSettings,
  type HookRegistration,
  type Model,
  type ModelThinkingLevel,
  type Registry,
  section,
} from '../pi-boundary.js';
import {
  assembleSystemPrompt,
  escalatePinnedModel,
  type ModelEscalationEvent,
  PromptCacheError,
  pinModelForTask,
  type SystemPromptInput,
  type TaskAffinity,
  taskModelForTurn,
} from '../prompts.js';
import { OperationKillRegistry } from './abort.js';
import {
  activateLaneTools,
  defaultModelId,
  installPolicyExtensions,
  laneThinkingLevel,
  laneToolSet,
  reconcileStoredModel,
  toolContextFor,
} from './boot-steps.js';
import type { PolicyInterceptorOptions } from './interceptors/index.js';
import {
  laneConversationIdOf,
  type SessionHandle,
} from './session-store/index.js';
import { kubicToolsToPiTools } from './tools-adapter.js';
import {
  composeTools,
  type ToolContribution,
  withPermissionCheck,
} from './wrap.js';

const LANE_NAME = 'main';

// The stable key of the one prompt section the extension installs.
// pi-durable stores sections as positional `pi.system` entries keyed by
// name, so a resumed session replays the same section instead of
// appending a second one.
export const PROMPT_SECTION = 'kubic';

// Stable role seed for the assembled prompt. The
// sentences match the pre ad-hoc prompt; the wiring delta is that
// boot now appends the byte-stable `cwd:` / `tools:` / `meta:` lines
// from prompts.ts instead of the `Working directory:` sentence.
/** @internal */
export const DEFAULT_ROLE_PROMPT = [
  'You are a coding agent working in a terminal.',
  'Use the read, write, edit, grep, find, ls, and bash tools to inspect and change files.',
  'Keep answers short and technical.',
].join('\n');

/** @internal */
export interface PromptInput {
  cwd: string;
  toolNames: string[];
  metadata: Record<string, string>;
  extraSections?: string[];
  // Role text override: the role document's `## Prompt`
  // body replaces the DEFAULT_ROLE_PROMPT constant. Absent means the constant, so
  // every pre-existing caller assembles identical bytes.
  role?: string;
}

// The one section's text. pi-durable renders `content` and each section
// joined by "\n\n" (pi-ai `getSystemMessageText`), so per-line sections
// would change the model-visible bytes; a single untagged section carries
// exactly the prompt the model sees, and the harness still diffs it as one
// positional `pi.system` entry.
/** @internal */
export function assemblePrompt(input: PromptInput): string {
  const full: SystemPromptInput = {
    role: input.role ?? DEFAULT_ROLE_PROMPT,
    cwd: input.cwd,
    toolNames: input.toolNames,
    metadata: input.metadata,
    ...(input.extraSections === undefined
      ? {}
      : { extraSections: input.extraSections }),
  };
  return assembleSystemPrompt(full);
}

interface LanePolicyOptions {
  classes?: PermissionClasses;
  interceptors?: PolicyInterceptorOptions;
  contributions?: ToolContribution[];
  /**
   * Perf spans for every executed tool, registered as the
   * `kubic.spans` extension between policy and the Kubic extension. The
   * caller builds them (`runSpanHooks(spans)`) so the lane keeps no
   * perf import of its own.
   */
  spanHooks?: () => HookRegistration[];
  /**
   * Enterprise tool gate: the composition root closes this
   * over `isToolAllowedByEnterprise(effectivePolicy, tool)`, so the lane
   * has no policy import of its own. When present, the base/class/role
   * intersection is filtered through it for BOTH the active tool set and
   * the prompt's `tools:` line — the two can never disagree about what the
   * model may call. Absent means no enterprise tool policy is configured.
   */
  toolAllowed?: (tool: string) => boolean;
  /**
   * Enterprise model gate: closed over
   * `isModelAllowed(effectivePolicy, provider, id)` by the composition root.
   * The stored-model rule lets a resumed session keep its own
   * model, and the boot selection is gated but the stored one never was — a
   * session file could carry a refused provider past the policy. A stored
   * model the gate refuses is dropped for the selected (gated) one.
   */
  modelAllowed?: (provider: string, modelId: string) => boolean;
}

// Harness compaction budget overrides. keepRecentTokens defaults inside
// compaction.ts (the compactionSettings), so Kubic keeps ONE home for
// the 20000 figure.
export interface LaneCompactionOptions {
  enabled?: boolean;
  reserveTokens?: number;
  keepRecentTokens?: number;
}

// Caller contract: classes alone deploy the allowlist (configure({tools}))
// and the innermost permission wrapper. Destructive/network/confine guards
// deploy only when interceptors options are also passed — the lane cannot
// invent a workspace root, so confinement stays explicit.

// The permission wrapper is composed innermost (closest to the core) when
// classes are declared, so execute-time denial is deployed on every
// policy boot — not just tested in isolation.
function withPolicyContributions(
  policy: LanePolicyOptions | undefined,
): ToolContribution[] {
  const extra = policy?.contributions ?? [];
  if (policy?.classes === undefined) return extra;
  const valid = validateClasses({ ...policy.classes });
  const allowed = toolsForClasses(valid);
  return [withPermissionCheck((name) => allowed.includes(name)), ...extra];
}

export interface LaneBootOptions {
  // The session handle: its storage is what the harness opens, and
  // its lock stays held for the handle's lifetime. The caller releases it
  // after `close()`.
  session: SessionHandle;
  models: ReturnType<typeof import('../pi-boundary.js').createModels>;
  model: Model<string>;
  env: ExecutionEnv;
  sessionId: string;
  agentId: string;
  systemPrompt?: string;
  context?: Context;
  policy?: LanePolicyOptions;
  // Model affinity pin: when set, boot pins the
  // boot model for the task; escalateLaneModel is the only path off it.
  taskId?: string;
  // Harness compaction budget: reserve defaults to Kubic's
  // DEFAULT_RESERVE_TOKENS so the harness automatic path fires on the
  // same threshold as shouldCompact.
  compaction?: LaneCompactionOptions;
  // Session journal for interception: when set, every
  // write/edit through the lane is recorded with its tool call id.
  journal?: FileJournalStore;
  // Interactive turn supplier: sampled per tool call, so
  // tool-journaled entries carry the same turn as that turn's sweep
  // entries. Absent on headless runs by design — their entries carry no
  // `turn` field at all (pi-durable exposes no numeric turn). A supplier
  // that returns `undefined` (the TUI's cell before its counter is
  // installed) also writes no field.
  currentTurn?: () => number | undefined;
  // Appended prompt sections (skills first): the caller
  // composes context blocks (skill listings, role prompt) and the lane
  // appends them to the assembled system prompt. Ordered, so the
  // cache-stable prefix (role/cwd/tools/meta) is never rewritten — the
  // blocks land as suffix sections only. Ignored when `systemPrompt` is
  // given: an explicit prompt is byte-authoritative.
  promptSections?: string[];
  // The roots of the skills advertised with absolute
  // paths outside the workspace. The read tool (and only it) may open a
  // path inside one — the env serves those reads and the confine guard
  // leaves them un-rerooted; every other tool and path stays confined.
  skillReadRoots?: readonly string[];
  // Role prompt: replaces the hardcoded DEFAULT_ROLE_PROMPT seed
  // with the role document's own `## Prompt` text. The assembled
  // cwd/tools/meta lines are unchanged — the role supplies the instruction
  // half only, so the prompt-cache prefix rules still hold.
  rolePrompt?: string;
  // Role tool allowlist: the resolved role tool set is
  // applied with `configure({ tools })`, so a tool the role does not
  // declare is never registered — absence, not approval. Applied AFTER the
  // class-derived policy so the role is the narrower of the two (a role
  // can only narrow, never widen, what the permission classes allow).
  toolAllowlist?: string[];
  // The per-invocation tool selection
  // (`--tools <a,b>`). Intersected with the class/role/enterprise sets — a
  // selection can only narrow, never widen. `noTools` is the empty set (a
  // chat-only run); the two are mutually exclusive and a library caller
  // that sets both is refused by name.
  toolSelection?: string[];
  noTools?: boolean;
  // Resumed-session model identity. The root
  // conversation's `pi.agent` document restores a resumed session's STORED
  // model; `model` only seeds a new conversation. When they differ:
  // 'selected' (the caller's selection was an explicit pin) switches the
  // conversation to `model` — configure, reserve re-clamp, notice — and
  // 'stored' (the default: the selection was only a default pick) keeps the
  // session's own model, which then drives the prompt metadata, the reserve
  // clamp and every report. A stored model that is not registered
  // fails the boot closed with a named ModelSelectError.
  modelPolicy?: 'selected' | 'stored';
  // The one-line notice for either reconciliation (stderr on `run`, the
  // debug channel elsewhere). Absent means silent.
  onModelNotice?: (line: string) => void;
  // The thinking level is a per-conversation agent choice. Given
  // here it is written on boot; absent, a resumed session keeps its stored
  // level (and becomes a config/flag issue only).
  thinkingLevel?: ModelThinkingLevel;
  // The lane's thinking-level request. `override` is a
  // per-run level (cli `--thinking` / `KUBIC_MODEL_THINKING`, source named);
  // `role` is the `[roles.<name>] thinking` default; `config` is the
  // `[model].thinking` file default with its layer. `persisted` is never
  // passed — the lane reads the session's stored level itself, so the
  // precedence (override > session > role > config) holds on attach too.
  // An explicit `thinkingLevel` above is the same level as `override`.
  thinking?: Omit<ThinkingInputs, 'persisted'>;
  // The one-line clamp notice for the resolved level: a
  // request the model does not support is never silently rewritten.
  // Absent means `onModelNotice` — both name stderr on `kubic run`.
  onThinkingNotice?: (line: string) => void;
  // Harness-wide run policy (retry, stream, toolExecution, steering/follow
  // up). Compaction is NOT passable: it is built from `compaction` through
  // compactionSettings so the Kubic clamp cannot be bypassed. Extension
  // selection is NOT passable either: the lane owns the four Kubic
  // extensions, and a caller-supplied selection could uninstall the tools,
  // the prompt and every policy hook silently.
  settings?: Omit<HarnessSettings, 'compaction' | 'extensions'>;
}

export interface Lane {
  harness: Harness;
  conversation: Conversation;
  // The per-process registry the Kubic extensions are installed in. It is
  // not stored: conversations store extension NAMES, so every boot
  // re-installs them.
  registry: Registry;
  kills: OperationKillRegistry;
  // The model the conversation runs after boot: the selection
  // for a new conversation or an explicit switch, else the session's stored
  // model. Every report (prompt metadata, status, usage, envelope) names
  // this one; a later configure is read live through `conversation.agent()`.
  model: Model<string>;
  sessionId: string;
  affinity?: TaskAffinity;
  // The configured (unclamped) compaction reserve and a window lookup, so a
  // model switch re-clamps the harness reserve to the NEW model's window.
  configuredReserveTokens?: number;
  // The manual-compaction scope the harness' keep getter reads.
  manualKeep: ManualKeepScope;
  modelWindow?: (provider: string, modelId: string) => number | undefined;
  // Shuts the harness down (and with it the session's storage). Releasing
  // the session handle — lock included — stays the caller's job: boot may
  // have been handed a handle it does not own.
  close(context: Context): Promise<void>;
}

/** @internal */
export function splitModelId(id: string): {
  provider: string;
  modelId: string;
} {
  const slash = id.indexOf('/');
  if (slash <= 0 || slash === id.length - 1) {
    throw new PromptCacheError(
      `model id must be 'provider/id' (got ${JSON.stringify(id)})`,
    );
  }
  return { provider: id.slice(0, slash), modelId: id.slice(slash + 1) };
}

// The ONLY path off the pinned model through the lane: one-way,
// ladder-bounded, recorded, and applied to the live conversation. Ordering
// is parse → validate → configure → record: the id-format parse and the
// ladder pre-check both run BEFORE the live switch, and the ladder record
// plus sink event fire only AFTER configure resolves — so a refused step,
// a malformed id, or a configure rejection burns no escalation budget,
// emits no event, and leaves affinity untouched.
export async function escalateLaneModel(
  lane: Lane,
  ladder: EscalationLadder,
  to: string,
  reason: string,
  context: Context,
  sink?: (event: ModelEscalationEvent) => void,
): Promise<{
  affinity: TaskAffinity;
  event: ModelEscalationEvent;
}> {
  if (lane.affinity === undefined) {
    throw new PromptCacheError(
      'no pinned affinity: boot with taskId before escalating',
    );
  }
  // The per-turn model read goes through the affinity helper,
  // so the helper has a lane-level caller (not a test-only export).
  const from = taskModelForTurn(lane.affinity);
  if (to === from) {
    throw new PromptCacheError(
      `refusing no-op escalation: already on '${to}' (same-model step)`,
    );
  }
  const parsed = splitModelId(to);
  validateEscalation(ladder, from, to);
  // The reserve follows the live model through compactionSettings'
  // `currentWindow` getter (which reads affinity first), so no explicit
  // re-clamp is needed.
  await lane.conversation.configure({ model: parsed }, context);
  const result = escalatePinnedModel(lane.affinity, ladder, to, reason, sink);
  lane.affinity = result.affinity;
  return result;
}

export async function bootLane(options: LaneBootOptions): Promise<Lane> {
  const context = options.context ?? BACKGROUND_CONTEXT;
  const kills = new OperationKillRegistry();
  const baseTools = kubicToolsToPiTools(toolContextFor(options, kills));
  const tools = laneToolSet(
    options,
    baseTools.map((tool) => tool.name),
  );

  // Compaction: reserveTokens is a live getter over the window of the
  // conversation's CURRENT model. It reads the attached `pi.agent` document
  // first, so EVERY model switch — `escalateLaneModel`, the TUI/headless
  // `configure({ model })`, a boot — re-clamps on the next use, with no
  // explicit re-clamp step. Affinity and the boot model are fallbacks for
  // the window between this boot and its first configure.
  let currentModelId = defaultModelId(options.model);
  const windowOf = (provider: string, modelId: string) =>
    options.models.getModels(provider).find((model) => model.id === modelId)
      ?.contextWindow;
  let laneRef: Lane | undefined;
  // Minimal structural view of the attached `pi.agent` document state: its
  // committed `model` and its dispose(), so this module needs no extra
  // pi-boundary type for it.
  let agentState:
    | {
        readonly value: {
          readonly model?: {
            readonly provider: string;
            readonly modelId: string;
          };
        } | null;
        dispose(): void;
      }
    | undefined;
  const currentWindow = (): number | undefined => {
    const live = agentState?.value?.model;
    if (live !== undefined) {
      return windowOf(live.provider, live.modelId);
    }
    const id = laneRef?.affinity?.modelId ?? currentModelId;
    try {
      const parsed = splitModelId(id);
      return windowOf(parsed.provider, parsed.modelId);
    } catch {
      return undefined;
    }
  };
  const manualKeep = createManualKeepScope();
  const settings: HarnessSettings = {
    ...options.settings,
    // Kubic executes one tool at a time:
    // parallel rounds would race the destructive/effect operations.
    toolExecution: options.settings?.toolExecution ?? 'sequential',
    compaction: compactionSettings({
      ...(options.compaction?.enabled === undefined
        ? {}
        : { enabled: options.compaction.enabled }),
      configuredReserveTokens:
        options.compaction?.reserveTokens ?? DEFAULT_RESERVE_TOKENS,
      ...(options.compaction?.keepRecentTokens === undefined
        ? {}
        : { keepRecentTokens: options.compaction.keepRecentTokens }),
      currentWindow,
      manualKeep,
    }),
  };

  const registry = createRegistry();
  installPolicyExtensions(registry, options);
  const harness = await Harness.open(
    // Adopt, never take `storage` directly: the handle must know a
    // harness owns the storage, or its `release()` would close the storage
    // under the live harness.
    options.session.adopt(),
    { models: options.models, registry, settings },
    context,
  );
  // A forked session's lane runs its recorded fork, never the
  // reserved root (which holds the source's whole history in the copy).
  const forkedLane = options.session.meta.conversation;
  const conversation =
    forkedLane === undefined
      ? await harness.root(context)
      : await harness.conversation(
          laneConversationIdOf(options.session.meta),
          context,
        );
  if (conversation === undefined)
    throw new Error(
      `session ${options.session.id}: its lane conversation ${forkedLane} is missing`,
    );
  // The live `pi.agent` document drives currentWindow: attached once here,
  // disposed by close(). `value` is the committed state, so a configure from
  // any caller (this module, the TUI, a headless switch) moves the reserve.
  agentState = await harness.documentState(AgentDoc, conversation.id, context);
  const storedAgent = await harness.snapshot(
    AgentDoc,
    conversation.id,
    context,
  );
  const reconciled = reconcileStoredModel(options, storedAgent?.model);
  const effectiveModel = reconciled.model;
  const effectiveId = defaultModelId(effectiveModel);
  currentModelId = effectiveId;

  const promptText = lanePromptText(options, tools.names, effectiveId);
  registry.install(
    defineExtension({
      name: 'kubic',
      tools: composeTools(baseTools, withPolicyContributions(options.policy)),
      sections: [section(PROMPT_SECTION, () => promptText, { tag: false })],
    }),
  );

  const thinking = laneThinkingLevel(
    options,
    effectiveModel,
    storedAgent?.thinkingLevel,
  );
  // Model and thinking level are one durable agent change; unset fields
  // keep their stored value (a resumed session keeps its stored level).
  await conversation.configure(
    {
      model: { provider: effectiveModel.provider, modelId: effectiveModel.id },
      ...(thinking.source === 'default'
        ? {}
        : { thinkingLevel: thinking.level }),
    },
    context,
  );
  if (reconciled.notice !== undefined) {
    options.onModelNotice?.(reconciled.notice);
  }
  await activateLaneTools(
    registry,
    conversation,
    options,
    tools,
    storedAgent?.tools,
    context,
  );

  const lane: Lane = {
    harness,
    conversation,
    registry,
    kills,
    model: effectiveModel,
    sessionId: options.sessionId,
    configuredReserveTokens:
      options.compaction?.reserveTokens ?? DEFAULT_RESERVE_TOKENS,
    manualKeep,
    modelWindow: windowOf,
    close: async (closeContext) => {
      agentState?.dispose();
      await harness.close(closeContext);
    },
    ...(options.taskId === undefined
      ? {}
      : {
          affinity: pinModelForTask(options.taskId, effectiveId),
        }),
  };
  laneRef = lane;
  return lane;
}

// The lane's system prompt: the caller's own text, else the assembled one
// over the offered tool set and the effective model.
function lanePromptText(
  options: LaneBootOptions,
  toolNames: string[],
  effectiveId: string,
): string {
  return (
    options.systemPrompt ??
    assemblePrompt({
      cwd: options.env.cwd,
      toolNames,
      metadata: {
        agent: options.agentId,
        lane: LANE_NAME,
        model: effectiveId,
      },
      // Role prompt: the document's own text replaces
      // the constant; absent, the constant stands.
      ...(options.rolePrompt === undefined ? {} : { role: options.rolePrompt }),
      // Context blocks appended as suffix sections: the
      // role/cwd/tools/meta prefix stays byte-stable for the prompt
      // cache, and a caller with no blocks assembles the same bytes
      // it always did.
      ...((options.promptSections ?? []).length === 0
        ? {}
        : { extraSections: [...(options.promptSections ?? [])] }),
    })
  );
}
