// Solo root lane: one pi-durable Harness + its root conversation, in-process
// (issue #11; §5.1, §20.7; ported to the Pi 1.0 durable harness in #394).
// Zero IPC on the path — the harness, the conversation, and the Kubic tools
// all live in this process. Kubic adds no loop: a turn is
// `conversation.submit(...)` → `submission.wait(...)`, and durable
// retry/backoff belongs to the harness (K6 owns the turn glue).

import type { PermissionClasses } from '../../../agents/src/policy.js';
import {
  toolsForClasses,
  validateClasses,
} from '../../../agents/src/policy.js';
import type { ExecutionEnv } from '../../../exec/src/env.js';
import type { FileJournalStore } from '../../../exec/src/journal.js';
import { withReadRoots } from '../../../exec/src/read-roots.js';
import {
  DEFAULT_RESERVE_TOKENS,
  soloCompactionSettings,
} from '../compaction.js';
import type { EscalationLadder, ThinkingInputs } from '../model-select.js';
import {
  ModelSelectError,
  resolveThinkingLevel,
  validateEscalation,
} from '../model-select.js';
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
  type ToolRegistration,
} from '../pi-boundary.js';
import {
  assembleSystemPrompt,
  escalatePinnedModel,
  type LaneBinding,
  type LaneRegistry,
  type ModelEscalationEvent,
  PromptCacheError,
  pinModelForTask,
  type SystemPromptInput,
  type TaskAffinity,
  taskModelForTurn,
} from '../prompts.js';
import { createSessionSpillSink } from '../spill.js';
import { OperationKillRegistry } from './abort.js';
import {
  type PolicyInterceptorOptions,
  policyInterceptorHooks,
} from './interceptors.js';
import {
  applyToolPolicy,
  PolicyRefusedError,
  toolsForNames,
} from './policy.js';
import { laneConversationIdOf, type SessionHandle } from './session-store.js';
import { type KubicToolContext, kubicToolsToPiTools } from './tools-adapter.js';
import {
  composeTools,
  type ToolContribution,
  withPermissionCheck,
} from './wrap.js';

export const SOLO_LANE_NAME = 'main';

// The stable key of the one prompt section the solo extension installs.
// pi-durable stores sections as positional `pi.system` entries keyed by
// name, so a resumed session replays the same section instead of
// appending a second one.
export const SOLO_PROMPT_SECTION = 'kubic';

// Stable role seed for the assembled solo prompt (issue #82). The
// sentences match the pre-#82 ad-hoc prompt; the wiring delta is that
// boot now appends the byte-stable `cwd:` / `tools:` / `meta:` lines
// from prompts.ts instead of the `Working directory:` sentence.
export const SOLO_ROLE = [
  'You are a coding agent working in a terminal.',
  'Use the read, write, edit, grep, find, ls, and bash tools to inspect and change files.',
  'Keep answers short and technical.',
].join('\n');

export interface SoloPromptInput {
  cwd: string;
  toolNames: string[];
  metadata: Record<string, string>;
  extraSections?: string[];
  // §12.1 role text override (issue #99): the role document's `## Prompt`
  // body replaces the SOLO_ROLE constant. Absent means the constant, so
  // every pre-existing caller assembles identical bytes.
  role?: string;
}

// The one section's text. pi-durable renders `content` and each section
// joined by "\n\n" (pi-ai `getSystemMessageText`), so per-line sections
// would change the model-visible bytes; a single untagged section carries
// exactly the pre-1.0 prompt, and the harness still diffs it as one
// positional `pi.system` entry (#33/#82 prefix stability).
export function assembleSoloPrompt(input: SoloPromptInput): string {
  const full: SystemPromptInput = {
    role: input.role ?? SOLO_ROLE,
    cwd: input.cwd,
    toolNames: input.toolNames,
    metadata: input.metadata,
    ...(input.extraSections === undefined
      ? {}
      : { extraSections: input.extraSections }),
  };
  return assembleSystemPrompt(full);
}

export function defaultSoloModelId(model: {
  provider: string;
  id: string;
}): string {
  return `${model.provider}/${model.id}`;
}

// NOTE (issue #215): defaultSoloPrompt lived here — deleted, it had no
// callers (the run paths always assemble an explicit prompt).
export interface SoloPolicyOptions {
  classes?: PermissionClasses;
  interceptors?: PolicyInterceptorOptions;
  contributions?: ToolContribution[];
  /**
   * Issue #208: a before_tool gate registered as its own extension BEFORE
   * the policy interceptors. Pi's before_tool chain stops at the first
   * block, so a gate that must observe EVERY attempt (the run budget meter)
   * has to register before the guards that may block it. The hooks land in
   * the `kubic.budget` extension, which is installed first.
   */
  beforePolicyHooks?: () => HookRegistration[];
  /**
   * Issue #98: perf spans for every executed tool, registered as the
   * `kubic.spans` extension between policy and the Kubic extension. The
   * caller builds them (`runSpanHooks(spans)`, #397) so the lane keeps no
   * perf import of its own.
   */
  spanHooks?: () => HookRegistration[];
  /**
   * §58 enterprise tool gate (issue #288): the composition root closes this
   * over `isToolAllowedByEnterprise(effectivePolicy, tool)`, so the lane
   * has no policy import of its own. When present, the base/class/role
   * intersection is filtered through it for BOTH the active tool set and
   * the prompt's `tools:` line — the two can never disagree about what the
   * model may call. Absent means no enterprise tool policy is configured.
   */
  toolAllowed?: (tool: string) => boolean;
  /**
   * §58 enterprise model gate (issue #288): closed over
   * `isModelAllowed(effectivePolicy, provider, id)` by the composition root.
   * The stored-model rule (issue #148) lets a resumed session keep its own
   * model, and the boot selection is gated but the stored one never was — a
   * session file could carry a refused provider past the policy. A stored
   * model the gate refuses is dropped for the selected (gated) one.
   */
  modelAllowed?: (provider: string, modelId: string) => boolean;
}

// Harness compaction budget overrides. keepRecentTokens defaults inside
// compaction.ts (#399's soloCompactionSettings), so Kubic keeps ONE home for
// the 20000 figure.
export interface SoloCompactionOptions {
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
  policy: SoloPolicyOptions | undefined,
): ToolContribution[] {
  const extra = policy?.contributions ?? [];
  if (policy?.classes === undefined) return extra;
  const valid = validateClasses({ ...policy.classes });
  const allowed = toolsForClasses(valid);
  return [withPermissionCheck((name) => allowed.includes(name)), ...extra];
}

export interface SoloBootOptions {
  // The session handle (#392): its storage is what the harness opens, and
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
  policy?: SoloPolicyOptions;
  // LaneRegistry binding (issue #82, rule 5): when set, boot spawns the
  // session/conversation binding; a repeat boot for the same key reuses the
  // continuation instead of re-spawning (which the registry rejects).
  registry?: LaneRegistry;
  // Model affinity pin (issue #82, rule 6): when set, boot pins the
  // boot model for the task; escalateSoloModel is the only path off it.
  taskId?: string;
  // Harness compaction budget (issue #82): reserve defaults to Kubic's
  // DEFAULT_RESERVE_TOKENS so the harness automatic path fires on the
  // same threshold as shouldCompact.
  compaction?: SoloCompactionOptions;
  // Session journal for interception (issue #17): when set, every
  // write/edit through the lane is recorded with its tool call id.
  journal?: FileJournalStore;
  // Interactive turn supplier (issue #436): sampled per tool call, so
  // tool-journaled entries carry the same turn as that turn's sweep
  // entries. Absent on headless runs by design — their entries carry no
  // `turn` field at all (pi-durable exposes no numeric turn). A supplier
  // that returns `undefined` (the TUI's cell before its counter is
  // installed) also writes no field.
  currentTurn?: () => number | undefined;
  // Appended prompt sections (issue #99; §29.3 skills first): the caller
  // composes context blocks (skill listings, role prompt) and the lane
  // appends them to the assembled system prompt. Ordered, so the
  // cache-stable prefix (role/cwd/tools/meta) is never rewritten — the
  // blocks land as suffix sections only. Ignored when `systemPrompt` is
  // given: an explicit prompt is byte-authoritative.
  promptSections?: string[];
  // Issue #173 (§29.3): the roots of the skills advertised with absolute
  // paths outside the workspace. The read tool (and only it) may open a
  // path inside one — the env serves those reads and the confine guard
  // leaves them un-rerooted; every other tool and path stays confined.
  skillReadRoots?: readonly string[];
  // §12.1 role prompt (issue #99): replaces the hardcoded SOLO_ROLE seed
  // with the role document's own `## Prompt` text. The assembled
  // cwd/tools/meta lines are unchanged — the role supplies the instruction
  // half only, so the prompt-cache prefix rules (#33) still hold.
  rolePrompt?: string;
  // §40 role tool allowlist (issue #99): the resolved role tool set is
  // applied with `configure({ tools })`, so a tool the role does not
  // declare is never registered — absence, not approval. Applied AFTER the
  // class-derived policy so the role is the narrower of the two (a role
  // can only narrow, never widen, what the permission classes allow).
  toolAllowlist?: string[];
  // §40.1 mechanism 1 (issue #273): the per-invocation tool selection
  // (`--tools <a,b>`). Intersected with the class/role/enterprise sets — a
  // selection can only narrow, never widen. `noTools` is the empty set (a
  // chat-only run); the two are mutually exclusive and a library caller
  // that sets both is refused by name.
  toolSelection?: string[];
  noTools?: boolean;
  // Resumed-session model identity (issue #148; §21, §26.1). The root
  // conversation's `pi.agent` document restores a resumed session's STORED
  // model; `model` only seeds a new conversation. When they differ:
  // 'selected' (the caller's selection was an explicit pin) switches the
  // conversation to `model` — configure, reserve re-clamp, notice — and
  // 'stored' (the default: the selection was only a default pick) keeps the
  // session's own model, which then drives the prompt metadata, the reserve
  // clamp and every report. A stored model that is no longer registered
  // fails the boot closed with a named ModelSelectError.
  modelPolicy?: 'selected' | 'stored';
  // The one-line notice for either reconciliation (stderr on `run`, the
  // debug channel elsewhere). Absent means silent.
  onModelNotice?: (line: string) => void;
  // Issue #225: the thinking level is a per-conversation agent choice. Given
  // here it is written on boot; absent, a resumed session keeps its stored
  // level (and #225 becomes a config/flag issue only).
  thinkingLevel?: ModelThinkingLevel;
  // Issue #225 (§38.3): the lane's thinking-level request. `override` is a
  // per-run level (cli `--thinking` / `KUBIC_MODEL_THINKING`, source named);
  // `role` is the `[roles.<name>] thinking` default; `config` is the
  // `[model].thinking` file default with its layer. `persisted` is never
  // passed — the lane reads the session's stored level itself, so the
  // precedence (override > session > role > config) holds on attach too.
  // An explicit `thinkingLevel` above is the same level as `override`.
  thinking?: Omit<ThinkingInputs, 'persisted'>;
  // The one-line clamp notice for the resolved level (issue #225): a
  // request the model does not support is never silently rewritten.
  // Absent means `onModelNotice` — both name stderr on `kubic run`.
  onThinkingNotice?: (line: string) => void;
  // Harness-wide run policy (retry, stream, toolExecution, steering/follow
  // up). Compaction is NOT passable: it is built from `compaction` through
  // soloCompactionSettings so the Kubic clamp cannot be bypassed. Extension
  // selection is NOT passable either: the lane owns the four Kubic
  // extensions, and a caller-supplied selection could uninstall the tools,
  // the prompt and every policy hook silently (review #394 low 3).
  settings?: Omit<HarnessSettings, 'compaction' | 'extensions'>;
  // Issue #154 (§14.2): tools that ask the HUMAN something (an orchestrator
  // worker's `ask_user`). They are interactions, not capabilities: offered
  // beside the base tools and outside the role / class / enterprise gates
  // (which narrow what the agent may DO), but never under `--no-tools`.
  interactionTools?: readonly ToolRegistration[];
}

function resolveStoredModel(
  models: SoloBootOptions['models'],
  stored: { provider: string; modelId: string },
): Model<string> {
  const id = `${stored.provider}/${stored.modelId}`;
  const hint = '(pin a model to switch this session)';
  if (models.getProvider(stored.provider) === undefined) {
    throw new ModelSelectError(
      `session model '${id}' is unavailable: provider '${stored.provider}' is not registered ${hint}`,
    );
  }
  const model = models.getModel(stored.provider, stored.modelId);
  if (model === undefined) {
    throw new ModelSelectError(
      `session model '${id}' is unavailable: model '${stored.modelId}' is not registered on provider '${stored.provider}' ${hint}`,
    );
  }
  return model as Model<string>;
}

export interface SoloLane {
  harness: Harness;
  conversation: Conversation;
  // The per-process registry the Kubic extensions are installed in. It is
  // not stored: conversations store extension NAMES, so every boot
  // re-installs them.
  registry: Registry;
  kills: OperationKillRegistry;
  // The model the conversation runs after boot (issue #148): the selection
  // for a new conversation or an explicit switch, else the session's stored
  // model. Every report (prompt metadata, status, usage, envelope) names
  // this one; a later configure is read live through `conversation.agent()`.
  model: Model<string>;
  sessionId: string;
  binding?: LaneBinding;
  affinity?: TaskAffinity;
  // The configured (unclamped) compaction reserve and a window lookup, so a
  // model switch re-clamps the harness reserve to the NEW model's window
  // (#399 reads them through the live CompactionPolicy getter).
  configuredReserveTokens?: number;
  modelWindow?: (provider: string, modelId: string) => number | undefined;
  // Shuts the harness down (and with it the session's storage). Releasing
  // the session handle — lock included — stays the caller's job: boot may
  // have been handed a handle it does not own.
  close(context: Context): Promise<void>;
}

export function splitSoloModelId(id: string): {
  provider: string;
  modelId: string;
} {
  const slash = id.indexOf('/');
  if (slash <= 0 || slash === id.length - 1) {
    throw new PromptCacheError(
      `solo model id must be 'provider/id' (got ${JSON.stringify(id)})`,
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
export async function escalateSoloModel(
  solo: SoloLane,
  ladder: EscalationLadder,
  to: string,
  reason: string,
  context: Context,
  sink?: (event: ModelEscalationEvent) => void,
): Promise<{
  affinity: TaskAffinity;
  event: ModelEscalationEvent;
}> {
  if (solo.affinity === undefined) {
    throw new PromptCacheError(
      'no pinned affinity: boot with taskId before escalating',
    );
  }
  // Issue #215: the per-turn model read goes through the affinity helper,
  // so the helper has a lane-level caller (not a test-only export).
  const from = taskModelForTurn(solo.affinity);
  if (to === from) {
    throw new PromptCacheError(
      `refusing no-op escalation: already on '${to}' (same-model step)`,
    );
  }
  const parsed = splitSoloModelId(to);
  validateEscalation(ladder, from, to);
  // The reserve follows the live model through soloCompactionSettings'
  // `currentWindow` getter (which reads affinity first), so no explicit
  // re-clamp is needed (#399).
  await solo.conversation.configure({ model: parsed }, context);
  const result = escalatePinnedModel(solo.affinity, ladder, to, reason, sink);
  solo.affinity = result.affinity;
  return result;
}

export async function bootSoloLane(
  options: SoloBootOptions,
): Promise<SoloLane> {
  const context = options.context ?? BACKGROUND_CONTEXT;
  const kills = new OperationKillRegistry();
  const toolContext: KubicToolContext = {
    env:
      options.skillReadRoots === undefined
        ? options.env
        : withReadRoots(options.env, options.skillReadRoots),
    sessionId: options.sessionId,
    agentId: options.agentId,
    kills,
    ...(options.journal === undefined ? {} : { journal: options.journal }),
    // Issue #436: the interactive turn supplier rides the tool context so
    // every intercepted write/edit samples the live turn at call time.
    ...(options.currentTurn === undefined
      ? {}
      : { currentTurn: options.currentTurn }),
    // Issue #182: clipped bash output spills into the session directory, so
    // it is pruned with the session and never lands in the workspace.
    spill: createSessionSpillSink(options.session.dir),
  };
  const interactionTools =
    options.noTools === true ? [] : [...(options.interactionTools ?? [])];
  const baseTools = [...kubicToolsToPiTools(toolContext), ...interactionTools];
  // §12.1/§40/§58 intersection (issues #99, #143, #288): the tools the
  // conversation offers and the tools the prompt advertises are ONE set —
  // base tools, narrowed by the permission classes when declared, by the
  // role allowlist when declared, and by the enterprise tool policy when
  // configured. A role or an enterprise deny can only narrow what the
  // classes allow, never widen it. Computed before the prompt is assembled
  // so the `tools:` line names exactly what the conversation offers: the
  // model must be told the truth about its own tool set (§40.3), and the
  // value is fixed for the boot, so the prompt-cache prefix (#33) is still
  // byte-stable across turns.
  const classAllowed =
    options.policy?.classes === undefined
      ? undefined
      : toolsForClasses(validateClasses({ ...options.policy.classes }));
  const enterpriseGate = options.policy?.toolAllowed;
  const baseNames = baseTools.map((tool) => tool.name);
  const registeredNames = new Set(baseNames);
  if (options.toolSelection !== undefined && options.noTools === true) {
    throw new PolicyRefusedError(
      '--tools and --no-tools are mutually exclusive',
    );
  }
  let roleNames = options.toolAllowlist ?? baseNames;
  if (options.toolSelection !== undefined) {
    const selected = new Set(options.toolSelection);
    roleNames = roleNames.filter((tool) => selected.has(tool));
  }
  if (options.noTools === true) roleNames = [];
  let effectiveToolNames =
    classAllowed === undefined
      ? [...roleNames]
      : roleNames.filter((tool) => classAllowed.includes(tool));
  if (enterpriseGate !== undefined) {
    effectiveToolNames = effectiveToolNames.filter((tool) =>
      enterpriseGate(tool),
    );
  }
  // A name the registry does not offer is not offered to the model either:
  // the prompt line and the configured tool set stay one set even when a
  // role names a tool this build does not carry.
  effectiveToolNames = effectiveToolNames.filter((tool) =>
    registeredNames.has(tool),
  );
  for (const tool of interactionTools) {
    if (!effectiveToolNames.includes(tool.name))
      effectiveToolNames.push(tool.name);
  }
  // Without a role or enterprise gate, applyToolPolicy already installs the
  // class-derived allowlist; only the two narrowing paths need their own
  // activation (and their set can never exceed the class-derived one).
  const mustActivateTools =
    options.toolAllowlist !== undefined ||
    options.toolSelection !== undefined ||
    options.noTools === true ||
    enterpriseGate !== undefined;

  // Compaction (#399): reserveTokens is a live getter over the window of the
  // conversation's CURRENT model. It reads the attached `pi.agent` document
  // first, so EVERY model switch — `escalateSoloModel`, the TUI/headless
  // `configure({ model })`, a boot — re-clamps on the next use, with no
  // explicit re-clamp step. Affinity and the boot model are fallbacks for
  // the window between this boot and its first configure.
  let currentModelId = defaultSoloModelId(options.model);
  const windowOf = (provider: string, modelId: string) =>
    options.models.getModels(provider).find((model) => model.id === modelId)
      ?.contextWindow;
  let soloRef: SoloLane | undefined;
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
    const id = soloRef?.affinity?.modelId ?? currentModelId;
    try {
      const parsed = splitSoloModelId(id);
      return windowOf(parsed.provider, parsed.modelId);
    } catch {
      return undefined;
    }
  };
  const settings: HarnessSettings = {
    ...options.settings,
    // Kubic executes one tool at a time (the pre-1.0 lane was single-flight):
    // parallel rounds would race the destructive/effect operations.
    toolExecution: options.settings?.toolExecution ?? 'sequential',
    compaction: soloCompactionSettings({
      ...(options.compaction?.enabled === undefined
        ? {}
        : { enabled: options.compaction.enabled }),
      configuredReserveTokens:
        options.compaction?.reserveTokens ?? DEFAULT_RESERVE_TOKENS,
      ...(options.compaction?.keepRecentTokens === undefined
        ? {}
        : { keepRecentTokens: options.compaction.keepRecentTokens }),
      currentWindow,
    }),
  };

  // Registry install order = hook order (§20.5, #208): budget observes every
  // attempt before the policy guards can block it, policy before spans, and
  // the Kubic extension (tools + prompt) last. Nothing here is stored;
  // conversations store extension names only, so a reopen re-installs them.
  const registry = createRegistry();
  const budgetHooks = options.policy?.beforePolicyHooks?.();
  if (budgetHooks !== undefined && budgetHooks.length > 0) {
    registry.install(
      defineExtension({ name: 'kubic.budget', hooks: [...budgetHooks] }),
    );
  }
  if (options.policy?.interceptors !== undefined) {
    registry.install(
      defineExtension({
        name: 'kubic.policy',
        hooks: policyInterceptorHooks({
          ...options.policy.interceptors,
          ...(options.skillReadRoots === undefined
            ? {}
            : {
                readRoots: [
                  ...(options.policy.interceptors.readRoots ?? []),
                  ...options.skillReadRoots,
                ],
              }),
        }),
      }),
    );
  }
  const spanHooks = options.policy?.spanHooks?.();
  if (spanHooks !== undefined && spanHooks.length > 0) {
    registry.install(
      defineExtension({ name: 'kubic.spans', hooks: [...spanHooks] }),
    );
  }

  const harness = await Harness.open(
    // Adopt, never take `storage` directly (D8.1): the handle must know a
    // harness owns the storage, or its `release()` would close the storage
    // under the live harness.
    options.session.adopt(),
    { models: options.models, registry, settings },
    context,
  );
  // Issue #265: a forked session's lane runs its recorded fork, never the
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
  // Issue #148: reconcile the stored conversation model with the selection
  // BEFORE the extension fixes the system prompt and the reserve.
  const selectedId = defaultSoloModelId(options.model);
  const storedAgent = await harness.snapshot(
    AgentDoc,
    conversation.id,
    context,
  );
  const stored = storedAgent?.model;
  const storedId =
    stored === undefined
      ? undefined
      : defaultSoloModelId({
          provider: stored.provider,
          id: stored.modelId,
        });
  const storedRefused =
    stored !== undefined &&
    options.policy?.modelAllowed?.(stored.provider, stored.modelId) === false;
  const keep =
    stored !== undefined &&
    storedId !== selectedId &&
    options.modelPolicy !== 'selected' &&
    !storedRefused
      ? stored
      : undefined;
  const differs = storedId !== undefined && storedId !== selectedId;
  const switchToSelected = differs && keep === undefined;
  const effectiveModel =
    keep === undefined
      ? options.model
      : resolveStoredModel(options.models, keep);
  const effectiveId = defaultSoloModelId(effectiveModel);
  currentModelId = effectiveId;

  const promptText =
    options.systemPrompt ??
    assembleSoloPrompt({
      cwd: options.env.cwd,
      toolNames: effectiveToolNames,
      metadata: {
        agent: options.agentId,
        lane: SOLO_LANE_NAME,
        model: effectiveId,
      },
      // §12.1 role prompt (issue #99): the document's own text replaces
      // the solo constant; absent, the constant stands.
      ...(options.rolePrompt === undefined ? {} : { role: options.rolePrompt }),
      // Context blocks appended as suffix sections (issue #99): the
      // role/cwd/tools/meta prefix stays byte-stable for the prompt
      // cache, and a caller with no blocks assembles the same bytes
      // it always did.
      ...((options.promptSections ?? []).length === 0
        ? {}
        : { extraSections: [...(options.promptSections ?? [])] }),
    });
  registry.install(
    defineExtension({
      name: 'kubic',
      tools: composeTools(baseTools, withPolicyContributions(options.policy)),
      sections: [
        section(SOLO_PROMPT_SECTION, () => promptText, { tag: false }),
      ],
    }),
  );

  // Issue #225 (§38.3): resolve the thinking request against the session's
  // stored level and clamp it to the EFFECTIVE model (the #148 rule above
  // may keep the session's own model, so clamping to the selection would
  // answer for the wrong model). A clamp is never silent.
  const resolvedThinking = resolveThinkingLevel(effectiveModel, {
    ...(options.thinking === undefined ? {} : options.thinking),
    // The explicit level is the same level as `override`, and wins over
    // it: one variable, two spellings, no silent double application.
    ...(options.thinkingLevel === undefined
      ? {}
      : {
          override: {
            level: options.thinkingLevel,
            source: 'override',
          },
        }),
    persisted: storedAgent?.thinkingLevel ?? null,
  });
  if (resolvedThinking.notice !== undefined) {
    (options.onThinkingNotice ?? options.onModelNotice)?.(
      resolvedThinking.notice,
    );
  }
  // Model and thinking level are one durable agent change; unset fields
  // keep their stored value (a resumed session keeps its stored level).
  // The offered tools follow below (class policy, then role narrowing).
  await conversation.configure(
    {
      model: { provider: effectiveModel.provider, modelId: effectiveModel.id },
      ...(resolvedThinking.source === 'default'
        ? {}
        : { thinkingLevel: resolvedThinking.level }),
    },
    context,
  );
  if (switchToSelected) {
    // An explicit selection is an explicit model change (§26.1): applied
    // to the restored conversation (and persisted) and announced.
    options.onModelNotice?.(
      `model: session model '${storedId}' switched to '${selectedId}' (${
        storedRefused && options.modelPolicy !== 'selected'
          ? 'enterprise policy'
          : 'explicit selection'
      })`,
    );
  } else if (differs) {
    options.onModelNotice?.(
      `model: session keeps its own model '${storedId}' (selected default '${selectedId}' not applied; pin a model to switch)`,
    );
  }
  if (options.policy?.classes !== undefined) {
    await applyToolPolicy(
      registry,
      conversation,
      options.policy.classes,
      context,
    );
  }
  // §12.1 role narrowing (issue #99): the role's resolved tool set is the
  // NARROWER of the two allowlists — applied after the class-derived one,
  // so a role can never widen what the permission classes permit. An empty
  // set is the noTools case (the conversation offers nothing). The absence
  // guard (issue #43's createRoleToolGuard) stays available to callers;
  // offer-time absence is what this pins.
  if (mustActivateTools) {
    await conversation.configure(
      { tools: toolsForNames(registry, effectiveToolNames) },
      context,
    );
  } else if (classAllowed === undefined && storedAgent?.tools !== undefined) {
    // The stored filter is durable (configure writes it), so a session
    // booted with a role/enterprise narrowing would otherwise keep it while
    // this boot's prompt advertises the full intersection (review #394 med
    // 1). Clearing it makes the offered set total on every boot; the
    // prompt's `tools:` line is the same set by construction.
    await conversation.configure({ tools: null }, context);
  }

  let binding: LaneBinding | undefined;
  // NIT (review, issue #82): the harness above boots BEFORE the registry
  // continuation check, so a re-boot builds a second harness even when the
  // lane is reused. Reordering to check-first was left alone: the harness
  // owns policy/hook wiring with side effects, and a check-first reorder
  // is not trivially safe.
  if (options.registry !== undefined) {
    const candidate: LaneBinding = {
      sessionId: options.sessionId,
      lane: SOLO_LANE_NAME,
      modelId: effectiveId,
    };
    let existing: LaneBinding | undefined;
    try {
      existing = options.registry.continuation(
        options.sessionId,
        SOLO_LANE_NAME,
      );
    } catch (err) {
      // Absence-only catch: a missing lane falls through to spawn, but any
      // other continuation failure (backend errors, programming errors)
      // propagates instead of being masked as "no lane yet".
      if (
        err instanceof PromptCacheError &&
        /no active lane/.test(err.message)
      ) {
        options.registry.spawn(candidate);
        binding = { ...candidate };
      } else {
        throw err;
      }
    }
    if (existing !== undefined) {
      // Model agreement on reuse: the new conversation runs the boot model,
      // so a stale bound modelId must never be handed back silently.
      if (existing.modelId !== candidate.modelId) {
        throw new PromptCacheError(
          `lane model mismatch for '${options.sessionId}/${SOLO_LANE_NAME}': ` +
            `bound to '${existing.modelId}' but boot requested '${candidate.modelId}'`,
        );
      }
      binding = existing;
    }
  }

  const solo: SoloLane = {
    harness,
    conversation,
    registry,
    kills,
    model: effectiveModel,
    sessionId: options.sessionId,
    configuredReserveTokens:
      options.compaction?.reserveTokens ?? DEFAULT_RESERVE_TOKENS,
    modelWindow: windowOf,
    close: async (closeContext) => {
      agentState?.dispose();
      await harness.close(closeContext);
    },
    ...(binding === undefined ? {} : { binding }),
    ...(options.taskId === undefined
      ? {}
      : {
          affinity: pinModelForTask(options.taskId, effectiveId),
        }),
  };
  soloRef = solo;
  return solo;
}
