// Solo root lane: one Pi Session + one AgentLane in-process (issue #11;
// §5.1, §20.7). Zero IPC on the path — the harness, lane, and 7 Kubic
// tools all live in this process. Kubic adds no loop: accept → drive →
// DriveOutcome, with retry waiting honored via notBefore.

import { randomUUID } from 'node:crypto';
import type { PermissionClasses } from '../../../agents/src/policy.js';
import {
  toolsForClasses,
  validateClasses,
} from '../../../agents/src/policy.js';
import type { ExecutionEnv } from '../../../exec/src/env.js';
import type { FileJournalStore } from '../../../exec/src/journal.js';
import {
  buildCompactPrompt,
  type CompactionCheckpoint,
  DEFAULT_RESERVE_TOKENS,
  shouldCheckAt,
  shouldCompact,
} from '../compaction.js';
import type { EscalationLadder } from '../model-select.js';
import { validateEscalation } from '../model-select.js';
import { MemoryMemoStore } from '../ops/memos.js';
import type { MemoStore } from '../ops/types.js';
import {
  AgentHarness,
  type AgentHarnessApi,
  type AgentLane,
  BACKGROUND_CONTEXT,
  type Context,
  type DeferredHandle,
  type Model,
  type Session,
} from '../pi-boundary.js';
import {
  assembleSystemPrompt,
  buildCompactionRoute,
  type CompactionRoute,
  escalatePinnedModel,
  type LaneBinding,
  type LaneRegistry,
  type ModelEscalationEvent,
  PromptCacheError,
  pinModelForTask,
  type SystemPromptInput,
  type TaskAffinity,
} from '../prompts.js';
import { OperationKillRegistry } from './abort.js';
import {
  type PolicyInterceptorOptions,
  registerPolicyInterceptors,
} from './interceptors.js';
import { applyToolPolicy } from './policy.js';
import { type KubicToolContext, kubicToolsToPiTools } from './tools-adapter.js';
import {
  composeTools,
  type ToolContribution,
  withPermissionCheck,
} from './wrap.js';

export const SOLO_LANE_NAME = 'main';

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

export function defaultSoloPrompt(cwd: string): string {
  return [
    'You are a coding agent working in a terminal.',
    `Working directory: ${cwd}.`,
    'Use the read, write, edit, grep, find, ls, and bash tools to inspect and change files.',
    'Keep answers short and technical.',
  ].join('\n');
}

export interface SoloPolicyOptions {
  classes?: PermissionClasses;
  interceptors?: PolicyInterceptorOptions;
  contributions?: ToolContribution[];
}

// Harness compaction budget overrides. keepRecentTokens mirrors Pi's
// DEFAULT_COMPACTION_SETTINGS (20000): Kubic owns the trigger reserve,
// Pi owns the mechanism (checkpoints, summarization, spill files).
export const SOLO_KEEP_RECENT_TOKENS = 20000;

export interface SoloCompactionOptions {
  enabled?: boolean;
  reserveTokens?: number;
  keepRecentTokens?: number;
}

// Caller contract: classes alone deploy the allowlist (setActiveTools) and
// the innermost permission wrapper. Destructive/network/confine guards
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
  session: Session;
  models: ReturnType<typeof import('../pi-boundary.js').createModels>;
  model: Model<string>;
  env: ExecutionEnv;
  sessionId: string;
  agentId: string;
  memos?: MemoStore;
  systemPrompt?: string;
  context?: Context;
  policy?: SoloPolicyOptions;
  // LaneRegistry binding (issue #82, rule 5): when set, boot spawns the
  // session/lane binding; a repeat boot for the same key reuses the
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
  // write/edit through the lane is recorded with its toolCallId.
  journal?: FileJournalStore;
  // Appended prompt sections (issue #99; §29.3 skills first): the caller
  // composes context blocks (skill listings, role prompt) and the lane
  // appends them to the assembled system prompt. Ordered, so the
  // cache-stable prefix (role/cwd/tools/meta) is never rewritten — the
  // blocks land as suffix sections only. Ignored when `systemPrompt` is
  // given: an explicit prompt is byte-authoritative.
  promptSections?: string[];
  // §12.1 role prompt (issue #99): replaces the hardcoded SOLO_ROLE seed
  // with the role document's own `## Prompt` text. The assembled
  // cwd/tools/meta lines are unchanged — the role supplies the instruction
  // half only, so the prompt-cache prefix rules (#33) still hold.
  rolePrompt?: string;
  // §40 role tool allowlist (issue #99): the resolved role tool set is
  // applied with lane.setActiveTools, so a tool the role does not declare
  // is never registered — absence, not approval. Applied AFTER the
  // class-derived policy so the role is the narrower of the two (a role
  // can only narrow, never widen, what the permission classes allow).
  toolAllowlist?: string[];
}

export interface SoloLane {
  harness: AgentHarnessApi<KubicToolContext>;
  lane: AgentLane;
  kills: OperationKillRegistry;
  sessionId: string;
  binding?: LaneBinding;
  affinity?: TaskAffinity;
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
// ladder-bounded, recorded, and applied to the live lane. Ordering is
// parse → validate → setModel → record: the id-format parse and the
// ladder pre-check both run BEFORE the live switch, and the ladder record
// plus sink event fire only AFTER setModel resolves — so a refused step,
// a malformed id, or a setModel rejection burns no escalation budget,
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
  const from = solo.affinity.modelId;
  if (to === from) {
    throw new PromptCacheError(
      `refusing no-op escalation: already on '${to}' (same-model step)`,
    );
  }
  const parsed = splitSoloModelId(to);
  validateEscalation(ladder, from, to);
  await solo.lane.setModel(parsed, context);
  const result = escalatePinnedModel(solo.affinity, ladder, to, reason, sink);
  solo.affinity = result.affinity;
  return result;
}

export interface SoloCompactionCheck {
  contextWindow: number;
  contextTokens: number;
  reserveTokens?: number;
  checkpoint?: CompactionCheckpoint;
  batchTerminal?: boolean;
  focus?: string;
  newRoutingId?: () => string;
}

export type SoloCompactionDecision =
  | {
      checked: false;
      reason: 'checkpoint-skipped';
      checkpoint: CompactionCheckpoint;
    }
  | {
      checked: true;
      compacted: false;
      contextTokens: number;
      threshold: number;
    }
  | {
      checked: true;
      compacted: true;
      contextTokens: number;
      threshold: number;
      route: CompactionRoute;
      prompt: string;
    };

// Turn-loop compaction checkpoint (issue #82, rule 7): Pi checkpoints
// fire on interactive lanes only, the Kubic trigger formula decides, and
// the compact run carries a fresh routing id with cache writes disabled
// (rule 7) plus the verbatim caller focus. Never records usage itself.
export async function maybeCompactSoloLane(
  solo: SoloLane,
  check: SoloCompactionCheck,
  context: Context,
): Promise<SoloCompactionDecision> {
  const checkpoint = check.checkpoint ?? 'pre-prompt';
  if (
    shouldCheckAt(checkpoint, {
      batchTerminal: check.batchTerminal ?? false,
    }) === false
  ) {
    return { checked: false, reason: 'checkpoint-skipped', checkpoint };
  }
  const reserve = check.reserveTokens ?? DEFAULT_RESERVE_TOKENS;
  const threshold = check.contextWindow - reserve;
  if (
    shouldCompact({
      contextTokens: check.contextTokens,
      contextWindow: check.contextWindow,
      reserveTokens: reserve,
    }) === false
  ) {
    return {
      checked: true,
      compacted: false,
      contextTokens: check.contextTokens,
      threshold,
    };
  }
  const route = buildCompactionRoute(
    solo.sessionId,
    (check.newRoutingId ?? randomUUID)(),
  );
  const prompt = buildCompactPrompt(
    check.focus === undefined ? {} : { focus: check.focus },
  );
  // NOTE (review, issue #82): the route fields intentionally do NOT thread
  // into lane.compact — compact's `{ customInstructions }` parameter shape
  // is Pi's signature boundary, so the route stays a Kubic-side decision
  // record (fresh id, cache writes off) rather than a harness argument.
  await solo.lane.compact({ customInstructions: prompt }, context);
  return {
    checked: true,
    compacted: true,
    contextTokens: check.contextTokens,
    threshold,
    route,
    prompt,
  };
}

export async function bootSoloLane(
  options: SoloBootOptions,
): Promise<SoloLane> {
  const context = options.context ?? BACKGROUND_CONTEXT;
  const kills = new OperationKillRegistry();
  const toolContext: KubicToolContext = {
    env: options.env,
    sessionId: options.sessionId,
    agentId: options.agentId,
    memos: options.memos ?? new MemoryMemoStore(),
    kills,
    ...(options.journal === undefined ? {} : { journal: options.journal }),
  };
  const baseTools = kubicToolsToPiTools();
  // §12.1 role narrowing (issue #99): the role's resolved tool set is the
  // NARROWER of the two allowlists — a role can never widen what the
  // permission classes permit. Computed BEFORE the harness boots so the
  // assembled `tools:` line names exactly what the lane registers: the
  // model must be told the truth about its own tool set (§40.3), and the
  // value is fixed for the boot, so the prompt-cache prefix (#33) is still
  // byte-stable across turns.
  const classAllowed =
    options.policy?.classes === undefined
      ? undefined
      : toolsForClasses(validateClasses({ ...options.policy.classes }));
  const effectiveToolNames =
    options.toolAllowlist === undefined
      ? baseTools.map((t) => t.name)
      : classAllowed === undefined
        ? [...options.toolAllowlist]
        : options.toolAllowlist.filter((tool) => classAllowed.includes(tool));
  const { harness } = await AgentHarness.create(
    {
      session: options.session,
      models: options.models,
      model: options.model,
      tools: composeTools(baseTools, withPolicyContributions(options.policy)),
      toolContext,
      systemPrompt:
        options.systemPrompt ??
        assembleSoloPrompt({
          cwd: options.env.cwd,
          toolNames: effectiveToolNames,
          metadata: {
            agent: options.agentId,
            lane: SOLO_LANE_NAME,
            model: defaultSoloModelId(options.model),
          },
          // §12.1 role prompt (issue #99): the document's own text replaces
          // the solo constant; absent, the constant stands.
          ...(options.rolePrompt === undefined
            ? {}
            : { role: options.rolePrompt }),
          // Context blocks appended as suffix sections (issue #99): the
          // role/cwd/tools/meta prefix stays byte-stable for the prompt
          // cache, and a caller with no blocks assembles the same bytes
          // it always did.
          ...((options.promptSections ?? []).length === 0
            ? {}
            : { extraSections: [...(options.promptSections ?? [])] }),
        }),
      compaction: {
        enabled: options.compaction?.enabled ?? true,
        reserveTokens:
          options.compaction?.reserveTokens ?? DEFAULT_RESERVE_TOKENS,
        keepRecentTokens:
          options.compaction?.keepRecentTokens ?? SOLO_KEEP_RECENT_TOKENS,
      },
    },
    context,
  );
  const lane = await harness.lane(SOLO_LANE_NAME, context);
  if (options.policy?.classes !== undefined) {
    await applyToolPolicy(harness, lane, options.policy.classes, context);
  }
  // §12.1 role narrowing (issue #99): the role's resolved tool set is the
  // NARROWER of the two allowlists — applied after the class-derived one,
  // so a role can never widen what the permission classes permit. An empty
  // set is the noTools case (the lane allow-lists nothing). The absence
  // guard (issue #43's createRoleToolGuard) stays available to callers;
  // registration-time absence is what this pins.
  if (options.toolAllowlist !== undefined) {
    await lane.setActiveTools(effectiveToolNames, context);
  }
  if (options.policy?.interceptors !== undefined) {
    registerPolicyInterceptors(harness.hooks, options.policy.interceptors);
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
      modelId: defaultSoloModelId(options.model),
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
      // Model agreement on reuse: the new lane runs the boot model, so a
      // stale bound modelId must never be handed back silently.
      if (existing.modelId !== candidate.modelId) {
        throw new PromptCacheError(
          `lane model mismatch for '${options.sessionId}/${SOLO_LANE_NAME}': ` +
            `bound to '${existing.modelId}' but boot requested '${candidate.modelId}'`,
        );
      }
      binding = existing;
    }
  }
  return {
    harness,
    lane,
    kills,
    sessionId: options.sessionId,
    ...(binding === undefined ? {} : { binding }),
    ...(options.taskId === undefined
      ? {}
      : {
          affinity: pinModelForTask(
            options.taskId,
            defaultSoloModelId(options.model),
          ),
        }),
  };
}

// Minimal drive surface: real AgentLanes satisfy this, and so do unit
// stubs — drive failures are Error instances in tests, Error subclasses
// (Closed, OperationMismatch) on the real path. Outcomes are routed on a
// narrow shape (kind/reason/notBefore/deferred) so tests fabricate
// harness-shaped outcomes without importing Pi error classes.
export type RoutableOutcome =
  | { kind: 'settled'; outcome: unknown }
  | { kind: 'waiting'; operationId: string; reason: 'retry'; notBefore: number }
  | {
      kind: 'waiting';
      operationId: string;
      reason: 'deferred';
      deferred: DeferredHandle;
    };

export interface LaneDriver {
  drive(
    options: { operationId: string },
    context: Context,
  ): Promise<
    { ok: true; value: RoutableOutcome } | { ok: false; error: unknown }
  >;
}

export type SettledDrive =
  | { kind: 'settled'; outcome: unknown }
  | { kind: 'waiting-deferred'; operationId: string; deferred: DeferredHandle };

export class LaneDriveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LaneDriveError';
  }
}

export interface DriveLoopOptions {
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
  context?: Context;
}

const DEFAULT_MAX_RETRIES = 100;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function driveToSettled(
  lane: LaneDriver,
  operationId: string,
  context: Context,
  options: DriveLoopOptions = {},
): Promise<SettledDrive> {
  const sleep = options.sleep ?? defaultSleep;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  let retries = 0;
  for (;;) {
    const driven = await lane.drive({ operationId }, context);
    if (!driven.ok) {
      const detail =
        driven.error instanceof Error
          ? driven.error.message
          : JSON.stringify(driven.error);
      throw new LaneDriveError(
        `lane drive failed for ${operationId}: ${detail}`,
      );
    }
    const outcome = driven.value;
    if (outcome.kind === 'settled')
      return { kind: 'settled', outcome: outcome.outcome };
    if (outcome.reason === 'deferred') {
      return {
        kind: 'waiting-deferred',
        operationId: outcome.operationId,
        deferred: outcome.deferred,
      };
    }
    retries += 1;
    if (retries > maxRetries) {
      throw new LaneDriveError(
        `retry budget exhausted for ${operationId} after ${maxRetries} waits`,
      );
    }
    await sleep(Math.max(0, outcome.notBefore - Date.now()));
  }
}
