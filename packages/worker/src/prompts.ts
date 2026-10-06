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

// NOTE (issue #215): the PROMPT_CACHE_RULES list was deleted — it named
// no production reader (the rules live in §26 and are pinned by the
// assembly, lifecycle and two-turn tests, not by a constant).
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

// Rule 4 lives structurally in assembleSystemPrompt above (extra sections
// append last; nothing shifts prefix bytes) and is pinned at lane level by
// the no-new-pi.system-entry two-turn test — there is no per-turn prompt
// extension in the pi-durable design, so the standalone append/assert
// helpers were deleted (issue #215).
// Rule 5 (issue #82) deleted in the #210 review round: LaneRegistry (and
// its LaneBinding shape) had no production consumer repo-wide — only test
// constructions plus the optional boot field — so the class, the interface,
// the boot spawn/continuation branch and the lane's binding surface went
// with it. The per-task model pin (rule 6) below is the live mechanism.

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
