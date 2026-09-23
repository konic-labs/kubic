// Solo root lane: one Pi Session + one AgentLane in-process (issue #11;
// §5.1, §20.7). Zero IPC on the path — the harness, lane, and 7 Kubic
// tools all live in this process. Kubic adds no loop: accept → drive →
// DriveOutcome, with retry waiting honored via notBefore.

import type { PermissionClasses } from '../../../agents/src/policy.js';
import {
  toolsForClasses,
  validateClasses,
} from '../../../agents/src/policy.js';
import type { ExecutionEnv } from '../../../exec/src/env.js';
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
}

export interface SoloLane {
  harness: AgentHarnessApi<KubicToolContext>;
  lane: AgentLane;
  kills: OperationKillRegistry;
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
  };
  const { harness } = await AgentHarness.create(
    {
      session: options.session,
      models: options.models,
      model: options.model,
      tools: composeTools(
        kubicToolsToPiTools(),
        withPolicyContributions(options.policy),
      ),
      toolContext,
      systemPrompt: options.systemPrompt ?? defaultSoloPrompt(options.env.cwd),
    },
    context,
  );
  const lane = await harness.lane(SOLO_LANE_NAME, context);
  if (options.policy?.classes !== undefined) {
    await applyToolPolicy(harness, lane, options.policy.classes, context);
  }
  if (options.policy?.interceptors !== undefined) {
    registerPolicyInterceptors(harness.hooks, options.policy.interceptors);
  }
  return { harness, lane, kills };
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
