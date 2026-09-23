// Cache-preserving prompt assembly + model affinity (issue #33; §26).
//
// Prompt caches key on leading bytes: any instability in the prefix
// (system text, tool order, metadata order) or any mid-prefix edit
// silently voids the cache. This module keeps the prefix byte-stable by
// construction and pins one model per task with explicit, recorded,
// one-way escalation. Pure: no Pi imports except types via pi-boundary,
// no network, no filesystem.

import { type EscalationLadder, escalateModel } from './model-select.js';
import type { Usage } from './pi-boundary.js';

export class PromptCacheError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PromptCacheError';
  }
}

// The 7 cache-preservation rules (§26): assembly keeps 1-4, the lane
// lifecycle keeps 5-6, compaction keeps 7.
export const PROMPT_CACHE_RULES: readonly string[] = [
  'stable-prefix: identical inputs assemble byte-identical system prompts',
  'stable-tool-order: tool definitions sort by name',
  'stable-metadata: metadata serializes with sorted keys',
  'append-only-turns: per-turn content appends as suffix, prefix untouched',
  'reuse-lane: continuations reuse the bound lane, re-spawn is rejected',
  'pin-model: one model id per task, no per-action reselect',
  'fresh-compaction-ids: compaction uses fresh routing ids, no cache write',
];

export interface SystemPromptInput {
  role: string;
  cwd: string;
  toolNames: string[];
  metadata: Record<string, string>;
  extraSections?: string[];
}

export function sortedToolNames(names: string[]): string[] {
  return [...names].sort();
}

export function serializeMetadata(meta: Record<string, string>): string {
  return Object.keys(meta)
    .sort()
    .map((k) => `${k}=${meta[k]}`)
    .join(',');
}

export function assembleSystemPrompt(input: SystemPromptInput): string {
  const sections = [
    input.role,
    `cwd: ${input.cwd}`,
    `tools: ${sortedToolNames(input.toolNames).join(',')}`,
    `meta: ${serializeMetadata(input.metadata)}`,
    ...(input.extraSections ?? []),
  ];
  return sections.join('\n');
}

// Rule 4: turn-varying content may only extend the prompt. Anything else
// shifts prefix bytes and voids the cache.
export function appendTurnContent(prefix: string, turn: string): string {
  if (turn.length === 0) {
    throw new PromptCacheError('turn content must not be empty');
  }
  return `${prefix}\nturn: ${turn}`;
}

export function assertStartsWithPrefix(full: string, prefix: string): void {
  if (!full.startsWith(prefix)) {
    throw new PromptCacheError('prompt prefix bytes changed mid-session');
  }
}

export interface LaneBinding {
  sessionId: string;
  lane: string;
  modelId: string;
}

// Rule 5: one live lane per session+lane key. Continuations resolve the
// bound lane; spawning over a live key is rejected so a continuation can
// never silently fork (and lose) the cached prefix.
export class LaneRegistry {
  private bound = new Map<string, LaneBinding>();

  private key(sessionId: string, lane: string): string {
    return `${sessionId}/${lane}`;
  }

  spawn(binding: LaneBinding): void {
    const key = this.key(binding.sessionId, binding.lane);
    if (this.bound.has(key)) {
      throw new PromptCacheError(
        `re-spawn rejected for continuation on '${key}': reuse the lane`,
      );
    }
    this.bound.set(key, { ...binding });
  }

  continuation(sessionId: string, lane: string): LaneBinding {
    const found = this.bound.get(this.key(sessionId, lane));
    if (found === undefined) {
      throw new PromptCacheError(
        `no active lane for '${sessionId}/${lane}': continuation must reuse a lane`,
      );
    }
    return { ...found };
  }
}

export interface AffinityEscalation {
  from: string;
  to: string;
  reason: string;
  at: number;
}

// Rule 6: the model is pinned once per task. Turns read the pin; there is
// no reselect hook, so N turns always resolve to 1 model id.
export interface TaskAffinity {
  taskId: string;
  modelId: string;
  escalations: AffinityEscalation[];
}

export function pinModelForTask(taskId: string, modelId: string): TaskAffinity {
  return { taskId, modelId, escalations: [] };
}

export function taskModelForTurn(affinity: TaskAffinity): string {
  return affinity.modelId;
}

export function assertSingleModelId(ids: string[]): string {
  const distinct = [...new Set(ids)];
  if (distinct.length !== 1) {
    throw new PromptCacheError(
      `per-action re-select detected: ${distinct.join(', ')}`,
    );
  }
  return distinct[0] as string;
}

export interface ModelEscalationEvent {
  type: 'model-escalation';
  taskId: string;
  from: string;
  to: string;
  reason: string;
  at: number;
}

// The ONLY path off the pin: one-way, ladder-bounded, recorded (via the
// shared escalateModel), and observable — every switch builds a
// trajectory-routable event and notifies the sink. No silent switches:
// affinity objects are never mutated in place.
export function escalatePinnedModel(
  affinity: TaskAffinity,
  ladder: EscalationLadder,
  to: string,
  reason: string,
  sink?: (event: ModelEscalationEvent) => void,
): { affinity: TaskAffinity; event: ModelEscalationEvent } {
  const from = affinity.modelId;
  escalateModel(ladder, from, to, reason);
  const at = Date.now();
  const event: ModelEscalationEvent = {
    type: 'model-escalation',
    taskId: affinity.taskId,
    from,
    to,
    reason,
    at,
  };
  sink?.(event);
  return {
    affinity: {
      taskId: affinity.taskId,
      modelId: to,
      escalations: [...affinity.escalations, { from, to, reason, at }],
    },
    event,
  };
}

export interface CompactionRoute {
  routingId: string;
  cacheRetention: 'none';
  cacheWriteEnabled: boolean;
}

// Rule 7: compaction/summary must not poison the cache under the live
// routing id, and must not write cache entries of its own.
export function buildCompactionRoute(
  currentSessionId: string,
  freshRoutingId: string,
): CompactionRoute {
  if (freshRoutingId.length === 0 || freshRoutingId === currentSessionId) {
    throw new PromptCacheError(
      'compaction requires a fresh routing id distinct from the live session',
    );
  }
  return {
    routingId: freshRoutingId,
    cacheRetention: 'none',
    cacheWriteEnabled: false,
  };
}

export interface SessionCacheCounters {
  requests: number;
  hits: number;
  misses: number;
  cacheRead: number;
  cacheWrite: number;
}

export function emptyCacheCounters(): SessionCacheCounters {
  return { requests: 0, hits: 0, misses: 0, cacheRead: 0, cacheWrite: 0 };
}

type CacheUsage = Pick<Usage, 'cacheRead' | 'cacheWrite'>;

export function recordCacheUsage(
  counters: SessionCacheCounters,
  usage: CacheUsage,
): SessionCacheCounters {
  const hit = usage.cacheRead > 0;
  return {
    requests: counters.requests + 1,
    hits: counters.hits + (hit ? 1 : 0),
    misses: counters.misses + (hit ? 0 : 1),
    cacheRead: counters.cacheRead + usage.cacheRead,
    cacheWrite: counters.cacheWrite + usage.cacheWrite,
  };
}

export function cacheHitRate(counters: SessionCacheCounters): number | null {
  if (counters.requests === 0) return null;
  return counters.hits / counters.requests;
}

// Hit/miss observability per session: every record updates the counters,
// hitRate/format expose them to the status surface.
export class SessionCacheStats {
  private sessions = new Map<string, SessionCacheCounters>();

  record(sessionId: string, usage: CacheUsage): void {
    const prev = this.sessions.get(sessionId) ?? emptyCacheCounters();
    this.sessions.set(sessionId, recordCacheUsage(prev, usage));
  }

  counters(sessionId: string): SessionCacheCounters {
    return this.sessions.get(sessionId) ?? emptyCacheCounters();
  }

  hitRate(sessionId: string): number | null {
    return cacheHitRate(this.counters(sessionId));
  }

  format(sessionId: string): string {
    const c = this.counters(sessionId);
    const rate = cacheHitRate(c);
    const pct = rate === null ? 'n/a' : `${Math.round(rate * 100)}%`;
    return (
      `cache session ${sessionId} | hit-rate ${pct} ` +
      `(${c.hits}/${c.requests}) | read ${c.cacheRead} write ${c.cacheWrite}`
    );
  }
}
